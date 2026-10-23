//! Jobs (X62): every routed command of a session, kept on the central host
//! with its output, until the session is archived. A session's jobs live
//! in `~/.moonlet/jobs/<session>/`: `jobs.json`, the last 50, and one
//! `<job>.out` each, its output as `[u8 stream][u32 BE length][bytes]`
//! records.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use moonlet_core::paths::now_ms;
use moonlet_proto::Message;
use moonlet_proto::methods::{self as m, Job, JobChunk, JobOutput, JobOutputEvent, JobState};

/// Jobs kept per session, unless `MOONLET_TEST_JOBS_KEPT` says otherwise.
const KEPT: usize = 50;
/// Output kept per job: its start and its end, half each.
const OUTPUT_MAX: u64 = 10 * 1024 * 1024;
/// What one `job.output` answer carries at most.
const READ_MAX: usize = 1024 * 1024;

/// A running job's output beyond what its file keeps.
struct Live {
    /// Bytes in the file.
    written: u64,
    /// The end of the output, once the file is at half the limit.
    tail: VecDeque<(u8, Vec<u8>)>,
    tail_bytes: u64,
    dropped: u64,
    /// The last run's output, for its summary.
    last_run: String,
}

pub struct Jobs {
    dir: PathBuf,
    sessions: Mutex<HashMap<String, Vec<Job>>>,
    live: Mutex<HashMap<String, Live>>,
    kept: usize,
    output_max: u64,
    emit: Box<dyn Fn(Message) + Send + Sync>,
}

impl Jobs {
    /// Loads every session's jobs. A job that was going on when the daemon
    /// stopped is lost.
    pub fn load(dir: PathBuf, emit: impl Fn(Message) + Send + Sync + 'static) -> Jobs {
        let env = |var: &str| std::env::var(var).ok().and_then(|v| v.parse::<u64>().ok());
        let mut sessions = HashMap::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let session = e.file_name().to_string_lossy().to_string();
                let Ok(bytes) = std::fs::read(e.path().join("jobs.json")) else {
                    continue;
                };
                let Ok(mut list) = serde_json::from_slice::<Vec<Job>>(&bytes) else {
                    continue;
                };
                for j in &mut list {
                    if matches!(
                        j.state,
                        JobState::Running { .. }
                            | JobState::BringingBack
                            | JobState::Waiting { .. }
                    ) {
                        j.state = JobState::Lost;
                        j.ended_at.get_or_insert(now_ms());
                    }
                }
                sessions.insert(session, list);
            }
        }
        Jobs {
            dir,
            sessions: Mutex::new(sessions),
            live: Mutex::default(),
            kept: env("MOONLET_TEST_JOBS_KEPT").map_or(KEPT, |n| n as usize),
            output_max: env("MOONLET_TEST_JOB_OUTPUT_MAX").unwrap_or(OUTPUT_MAX),
            emit: Box::new(emit),
        }
    }

    /// `job.list`: a session's jobs, newest first.
    pub fn list(&self, session: &str) -> Vec<Job> {
        let mut list = self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .cloned()
            .unwrap_or_default();
        list.reverse();
        list
    }

    pub fn get(&self, job: &str) -> Option<Job> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .flatten()
            .find(|j| j.id == job)
            .cloned()
    }

    /// Starts a job, dropping the session's oldest past the limit.
    pub fn start(&self, mut job: Job) -> String {
        job.started_at = now_ms();
        let id = job.id.clone();
        let session = job.session.clone();
        let dropped: Vec<String> = {
            let mut sessions = self.sessions.lock().unwrap();
            let list = sessions.entry(session.clone()).or_default();
            list.push(job.clone());
            let over = list.len().saturating_sub(self.kept);
            list.drain(..over).map(|j| j.id).collect()
        };
        for old in dropped {
            let _ = std::fs::remove_file(self.out_file(&session, &old));
        }
        self.live.lock().unwrap().insert(
            id.clone(),
            Live {
                written: 0,
                tail: VecDeque::new(),
                tail_bytes: 0,
                dropped: 0,
                last_run: String::new(),
            },
        );
        self.save(&session);
        (self.emit)(Message::event(m::EV_JOB_CHANGED, &job));
        id
    }

    /// Changes job `id` and tells the apps.
    pub fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        let changed = {
            let mut sessions = self.sessions.lock().unwrap();
            sessions
                .values_mut()
                .flatten()
                .find(|j| j.id == id)
                .map(|j| {
                    f(j);
                    j.clone()
                })
        };
        if let Some(job) = changed {
            self.save(&job.session);
            (self.emit)(Message::event(m::EV_JOB_CHANGED, &job));
        }
    }

    /// Output of job `id`, as it comes.
    pub fn output(&self, id: &str, stream: u8, data: &[u8]) {
        let Some(session) = self.get(id).map(|j| j.session) else {
            return;
        };
        let half = self.output_max / 2;
        {
            let mut live = self.live.lock().unwrap();
            let Some(l) = live.get_mut(id) else { return };
            l.last_run.push_str(&String::from_utf8_lossy(data));
            if l.last_run.len() > READ_MAX {
                let cut = l.last_run.len() - READ_MAX;
                let cut = (cut..l.last_run.len())
                    .find(|i| l.last_run.is_char_boundary(*i))
                    .unwrap_or(0);
                l.last_run.drain(..cut);
            }
            if l.written < half {
                let room = (half - l.written) as usize;
                let (now, later) = data.split_at(data.len().min(room));
                if append(&self.out_file(&session, id), stream, now).is_ok() {
                    l.written += now.len() as u64 + 5;
                }
                if !later.is_empty() {
                    l.tail.push_back((stream, later.to_vec()));
                    l.tail_bytes += later.len() as u64;
                }
            } else {
                l.tail.push_back((stream, data.to_vec()));
                l.tail_bytes += data.len() as u64;
            }
            while l.tail_bytes > half
                && let Some((_, first)) = l.tail.front_mut()
            {
                let over = (l.tail_bytes - half) as usize;
                if first.len() <= over {
                    l.tail_bytes -= first.len() as u64;
                    l.dropped += first.len() as u64;
                    l.tail.pop_front();
                } else {
                    first.drain(..over);
                    l.tail_bytes -= over as u64;
                    l.dropped += over as u64;
                }
            }
        }
        // Counted in memory: `jobs.json` is written at the job's next change.
        if let Some(j) = self
            .sessions
            .lock()
            .unwrap()
            .values_mut()
            .flatten()
            .find(|j| j.id == id)
        {
            j.output_bytes += data.len() as u64;
        }
        let ev = JobOutputEvent {
            job: id.to_string(),
            session,
            chunks: vec![JobChunk {
                stream,
                text: String::from_utf8_lossy(data).into(),
            }],
        };
        (self.emit)(Message::event(m::EV_JOB_OUTPUT, ev));
    }

    /// A line in the job's stored output only, such as a rerun's separator.
    /// It starts the summary's text afresh.
    pub fn mark(&self, id: &str, line: &str) {
        let Some(session) = self.get(id).map(|j| j.session) else {
            return;
        };
        if let Some(l) = self.live.lock().unwrap().get_mut(id) {
            l.last_run.clear();
            if l.written < self.output_max / 2 {
                if append(&self.out_file(&session, id), 2, line.as_bytes()).is_ok() {
                    l.written += line.len() as u64 + 5;
                }
            } else {
                l.tail.push_back((2, line.as_bytes().to_vec()));
                l.tail_bytes += line.len() as u64;
            }
        }
    }

    /// Ends job `id` in `state`: the end of its output goes to its file,
    /// after a line for what was dropped, and its summary is made.
    pub fn finish(&self, id: &str, state: JobState, root: Option<&str>) {
        let Some(session) = self.get(id).map(|j| j.session) else {
            return;
        };
        let live = self.live.lock().unwrap().remove(id);
        let mut summary = None;
        if let Some(l) = live {
            let file = self.out_file(&session, id);
            if l.dropped > 0 {
                let line = format!("moonlet: {} of output dropped here\n", size(l.dropped));
                let _ = append(&file, 2, line.as_bytes());
            }
            for (stream, data) in &l.tail {
                let _ = append(&file, *stream, data);
            }
            summary = moonlet_core::job_summary::summarise(&l.last_run, root);
        }
        self.update(id, |j| {
            j.state = state;
            j.ended_at = Some(now_ms());
            j.summary = summary;
        });
    }

    /// `job.output`: job `id`'s stored output from byte `from`.
    pub fn read(&self, id: &str, from: u64) -> Option<JobOutput> {
        let job = self.get(id)?;
        let bytes = std::fs::read(self.out_file(&job.session, id)).unwrap_or_default();
        let mut at = from as usize;
        let mut chunks: Vec<JobChunk> = Vec::new();
        let mut taken = 0;
        while at + 5 <= bytes.len() && taken < READ_MAX {
            let stream = bytes[at];
            let len = u32::from_be_bytes(bytes[at + 1..at + 5].try_into().ok()?) as usize;
            let end = (at + 5 + len).min(bytes.len());
            let text = String::from_utf8_lossy(&bytes[at + 5..end]).to_string();
            match chunks.last_mut() {
                Some(last) if last.stream == stream => last.text.push_str(&text),
                _ => chunks.push(JobChunk { stream, text }),
            }
            taken += len;
            at = end;
        }
        Some(JobOutput {
            chunks,
            next: at as u64,
            more: at + 5 <= bytes.len(),
        })
    }

    /// A session was archived: its jobs go.
    pub fn forget(&self, session: &str) {
        self.sessions.lock().unwrap().remove(session);
        let _ = std::fs::remove_dir_all(self.dir.join(segment(session)));
    }

    fn out_file(&self, session: &str, job: &str) -> PathBuf {
        self.dir
            .join(segment(session))
            .join(format!("{}.out", segment(job)))
    }

    fn save(&self, session: &str) {
        let list = self
            .sessions
            .lock()
            .unwrap()
            .get(session)
            .cloned()
            .unwrap_or_default();
        let file = self.dir.join(segment(session)).join("jobs.json");
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(file.parent().unwrap())?;
            let tmp = file.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec(&list).unwrap_or_default())?;
            std::fs::rename(&tmp, &file)
        };
        if let Err(e) = write() {
            tracing::warn!("cannot write {}: {e}", file.display());
        }
    }
}

/// Appends one output record to `file`.
fn append(file: &Path, stream: u8, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?;
    let mut record = Vec::with_capacity(data.len() + 5);
    record.push(stream);
    record.extend_from_slice(&(data.len() as u32).to_be_bytes());
    record.extend_from_slice(data);
    f.write_all(&record)
}

/// A plain folder or file name for an id that comes from elsewhere.
fn segment(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// `n` bytes for a person.
pub fn size(n: u64) -> String {
    const UNITS: [&str; 4] = ["KiB", "MiB", "GiB", "TiB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut v = n as f64 / 1024.0;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    let text = format!("{v:.1}");
    format!("{} {}", text.trim_end_matches(".0"), UNITS[unit])
}
