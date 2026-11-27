//! The account state shared by every member of an account (X68, ADR 0014):
//! records made of named fields, changed one field at a time. Every member
//! keeps every change; a field's value is the one with the latest stamp, so
//! members that have seen the same changes agree, in whatever order the
//! changes came.

use std::collections::{BTreeMap, BTreeSet};

use moonlet_proto::types::{Change, ChangeOp, ChangeRef, Stamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What kind of record a change is about (X68). Changes carry it as text,
/// so a kind a newer moonlet adds is kept and passed on, never read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordKind {
    Workspace,
    Section,
    /// A workspace merged into another: its `into`.
    Merge,
    /// A member, by its log's name: its `name`.
    Member,
    /// A design system or workspace design (X71): its `workspace`, `kind`,
    /// `slug`, `name`, `owner` (a worker id), `tree` and `agent`.
    Design,
    /// A session (X72): its `name`, `project` (an identity), `workspace`,
    /// `branch`, `owner` (the worker id of the member running its agent),
    /// `created_at`, `archived`, and its place in the sidebar: `pinned_top`
    /// and `parent` (X112).
    Session,
    /// A project's copied files (X74), by project identity: its `patterns`
    /// and `cloud`.
    ProjectFiles,
    /// A sign-in of Settings › Machines › Sign-ins (X75): its `name`,
    /// `login`, `check` and `order`.
    SignIn,
    /// A member's worker settings (X89), by worker id: `heavy` (whether it
    /// takes other hosts' heavy commands) and `slots`.
    Worker,
    /// A project's approved heavy commands (X89), by project identity: its
    /// `commands` and `env`, approved together.
    HeavyApproval,
    /// The central host that referees the records that act as
    /// permissions ([`RecordKind::Worker`], [`RecordKind::HeavyApproval`],
    /// [`RecordKind::ProjectFiles`], [`RecordKind::SetupApproval`]), by its
    /// worker id: `since`, when it took them over. Until the central host
    /// wrote its own, every member's changes to the first three count, as
    /// before.
    Referee,
    /// A project's approved setup commands (X60), by project identity: one
    /// field per command, its exact text, set to `true`. Only the central
    /// host's changes count, once it referees permissions.
    SetupApproval,
    /// A project's setup on one member (X60, X62), by
    /// `<worker id>|<project identity>|<command>`: the member's `state`
    /// (`waiting`, `failed` or `ready`), `project`, `identity`, `command`,
    /// and a failure's `exit` and `line`; and the answers another member's
    /// app gives it, `skip` and `again`.
    Setup,
}

impl RecordKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RecordKind::Workspace => "workspace",
            RecordKind::Section => "section",
            RecordKind::Merge => "merge",
            RecordKind::Member => "member",
            RecordKind::Design => "design",
            RecordKind::Session => "session",
            RecordKind::ProjectFiles => "project_files",
            RecordKind::SignIn => "signin",
            RecordKind::Worker => "worker",
            RecordKind::HeavyApproval => "heavy_approval",
            RecordKind::Referee => "referee",
            RecordKind::SetupApproval => "setup_approval",
            RecordKind::Setup => "setup",
        }
    }
}

/// How far ahead of a member's wall clock a stamp may be (X68). A change
/// stamped further ahead would win every field from then on and pull every
/// member's clock forward with it, so members refuse it, and a member never
/// takes its own clock from one.
pub const AHEAD_MS: u64 = 24 * 60 * 60 * 1000;

/// The wall clock the account goes by, in ms. Tests shift it by
/// `MOONLET_TEST_ACCOUNT_CLOCK_MS` (signed) to play a Mac whose clock is
/// wrong, never changing the machine's own.
pub fn now_ms() -> u64 {
    let now = crate::paths::now_ms();
    match std::env::var("MOONLET_TEST_ACCOUNT_CLOCK_MS").ok().and_then(|v| v.parse::<i64>().ok()) {
        Some(off) => now.saturating_add_signed(off),
        None => now,
    }
}

/// A record's fields by name.
pub type Record = BTreeMap<String, Value>;

/// For each member, how many of its changes, counted from its first,
/// a member has seen.
pub type Version = BTreeMap<String, u64>;

/// A log as saved in `account.json`. The clock and this member's count
/// are worked out again from the changes, so they cannot disagree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFile {
    pub member: String,
    pub changes: Vec<Change>,
    /// The names this member's logs had before, newest last (X68).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub former: Vec<String>,
    /// The account this member shares, as its central host named it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// This member's own changes, made for its app, that it asks its
    /// central host to make its own (X89, X74).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<ChangeRef>,
}

/// One member's copy of the account state: every change it has seen.
#[derive(Debug, Clone)]
pub struct Log {
    member: String,
    /// The latest stamp's time and counter seen or made here. A change
    /// made here comes after it only while it is within [`AHEAD_MS`] of the
    /// wall clock ([`Self::stamped`]).
    clock: (u64, u32),
    /// How many of its own changes this log's central host counts, by
    /// their last exchange: those are never stamped again, as other
    /// members may hold them ([`Self::restamp_ahead`]).
    shared: u64,
    /// The numbers of its own changes [`Self::stamped`] stamped again and
    /// that were not handed on yet ([`Self::take_restamped`]). Not saved:
    /// after a restart, the next exchange sends what its central host
    /// lacks.
    restamped: BTreeSet<u64>,
    /// How many changes this member has made.
    seq: u64,
    /// Every change seen, by member and `seq`, so one that arrives twice
    /// is kept once.
    changes: BTreeMap<(String, u64), Change>,
    /// The names this machine's logs had before this one.
    former: Vec<String>,
    /// The account it shares, as its central host named it.
    account: Option<String>,
    /// Its own changes, made for its app, it asks its central host to make
    /// its own ([`LogFile::asks`]).
    asks: Vec<ChangeRef>,
    /// Which content this log holds: a number no other content of any log
    /// had, given again whenever its changes or its account change. What
    /// is worked out from a log can be kept while it stays the same
    /// ([`Self::rev`]).
    rev: u64,
}

/// The last [`Log::rev`] given out.
static REV: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_rev() -> u64 {
    REV.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

impl Log {
    pub fn new(member: &str) -> Log {
        Log {
            member: member.into(),
            clock: (0, 0),
            shared: 0,
            restamped: BTreeSet::new(),
            seq: 0,
            changes: BTreeMap::new(),
            former: Vec::new(),
            account: None,
            asks: Vec::new(),
            rev: next_rev(),
        }
    }

    /// Puts change `c` under `key`: every change but [`Self::apply`]'s goes
    /// in here, so the log's [`Self::rev`] moves on with it.
    fn put(&mut self, key: (String, u64), c: Change) {
        self.changes.insert(key, c);
        self.rev = next_rev();
    }

    /// Which content this log holds: the same number as long as its
    /// changes and its account stay the same, so a copy of it has the same
    /// one, and never one any other content had.
    pub fn rev(&self) -> u64 {
        self.rev
    }

    pub fn from_file(file: LogFile) -> Log {
        let mut log = Log::new(&file.member);
        log.apply(file.changes);
        log.former = file.former;
        log.account = file.account;
        log.asks = file.asks;
        log
    }

    /// The account this member shares, as its central host named it.
    pub fn account(&self) -> Option<&str> {
        self.account.as_deref()
    }

    pub fn set_account(&mut self, account: Option<String>) {
        self.account = account;
        self.rev = next_rev();
    }

    /// This log's name.
    pub fn member(&self) -> &str {
        &self.member
    }

    /// The names this machine's logs had before this one.
    pub fn former(&self) -> &[String] {
        &self.former
    }

    /// Takes over the changes of `old`, this machine's log before a rename:
    /// each one again as this log's own, with its time and counter, so the
    /// changes it made before reach its central host, which takes a
    /// member's changes only under its current name. `old` becomes a former
    /// name.
    pub fn adopt(&mut self, old: &str) {
        let theirs: Vec<Change> = self
            .changes
            .values()
            .filter(|c| c.stamp.member == old)
            .cloned()
            .collect();
        for c in theirs {
            self.seq = self.seq.saturating_add(1);
            let mine = Change {
                stamp: Stamp {
                    member: self.member.clone(),
                    ..c.stamp
                },
                seq: self.seq,
                ..c
            };
            self.put((self.member.clone(), self.seq), mine);
        }
        self.former.push(old.to_string());
    }

    pub fn to_file(&self) -> LogFile {
        LogFile {
            member: self.member.clone(),
            changes: self.changes.values().cloned().collect(),
            former: self.former.clone(),
            account: self.account.clone(),
            asks: self.asks.clone(),
        }
    }

    /// Its own changes it asks its central host to make its own.
    pub fn asks(&self) -> &[ChangeRef] {
        &self.asks
    }

    pub fn set_asks(&mut self, asks: Vec<ChangeRef>) {
        self.asks = asks;
    }

    /// Takes in changes from any member.
    pub fn apply(&mut self, changes: impl IntoIterator<Item = Change>) {
        for c in changes {
            // The first copy of a change stays: one under a number already
            // seen never rewrites what it said, nor moves the clock.
            let std::collections::btree_map::Entry::Vacant(slot) =
                self.changes.entry((c.stamp.member.clone(), c.seq))
            else {
                continue;
            };
            self.clock = self.clock.max((c.stamp.ms, c.stamp.n));
            if c.stamp.member == self.member {
                self.seq = self.seq.max(c.seq);
            }
            slot.insert(c);
            // Not through `put`, as the slot is already taken.
            self.rev = next_rev();
        }
    }

    /// Sets a field of a record here, at wall time `now_ms`.
    pub fn set(
        &mut self,
        now_ms: u64,
        kind: RecordKind,
        id: &str,
        field: &str,
        value: Value,
    ) -> Change {
        self.stamped(
            now_ms,
            kind,
            id,
            ChangeOp::Set {
                field: field.into(),
                value,
            },
        )
    }

    /// Sets a field of a record here with the oldest stamp there is, so any
    /// change another member made to it, at any time, wins: for values a
    /// member brings from before they were kept in the account (X89).
    pub fn set_oldest(&mut self, kind: RecordKind, id: &str, field: &str, value: Value) -> Change {
        self.at(0, 0, kind, id, ChangeOp::Set { field: field.into(), value })
    }

    /// Makes, as this log's own, a change with the time and counter `ms`
    /// and `n` of another member's change: a central host taking that
    /// change over keeps its place among the others (X89).
    pub fn set_at(&mut self, ms: u64, n: u32, kind: RecordKind, id: &str, field: &str, value: Value) -> Change {
        self.at(ms, n, kind, id, ChangeOp::Set { field: field.into(), value })
    }

    /// [`Self::set_at`] for a delete.
    pub fn delete_at(&mut self, ms: u64, n: u32, kind: RecordKind, id: &str) -> Change {
        self.at(ms, n, kind, id, ChangeOp::Delete)
    }

    fn at(&mut self, ms: u64, n: u32, kind: RecordKind, id: &str, op: ChangeOp) -> Change {
        self.seq = self.seq.saturating_add(1);
        let c = Change {
            stamp: Stamp { ms, n, member: self.member.clone() },
            seq: self.seq,
            kind: kind.as_str().into(),
            id: id.into(),
            op,
        };
        self.put((self.member.clone(), self.seq), c.clone());
        c
    }

    /// Deletes a record here, at wall time `now_ms`.
    pub fn delete(&mut self, now_ms: u64, kind: RecordKind, id: &str) -> Change {
        self.stamped(now_ms, kind, id, ChangeOp::Delete)
    }

    /// Notes that this log's central host counts `n` of its own changes,
    /// from their last exchange.
    pub fn set_shared(&mut self, n: u64) {
        self.shared = n;
    }

    /// The latest stamp a change may have at wall time `now_ms`: one later
    /// is from a clock that was wrong, here or on another member.
    pub fn limit(&self, now_ms: u64) -> u64 {
        now_ms.saturating_add(AHEAD_MS)
    }

    /// The clock a change made at wall time `now_ms` follows: the latest
    /// stamp seen or made here, leaving out any past [`Self::limit`]. A
    /// stamp this member made while its own clock was wrong would otherwise
    /// carry every change it makes after it, and the other members refuse
    /// those until real time catches up.
    fn clock_at(&self, now_ms: u64) -> (u64, u32) {
        let limit = self.limit(now_ms);
        if self.clock.0 <= limit {
            return self.clock;
        }
        self.changes
            .values()
            .map(|c| (c.stamp.ms, c.stamp.n))
            .filter(|&(ms, _)| ms <= limit)
            .max()
            .unwrap_or((0, 0))
    }

    /// A change stamped later than every change seen, even when this
    /// machine's clock is behind another member's, but never from a clock
    /// that was wrong ([`Self::clock_at`]). This log's own changes stamped
    /// past the limit are stamped again first ([`Self::restamp_ahead`]), so
    /// a change made now still comes after them, and they go out with it
    /// ([`Self::take_restamped`]).
    fn stamped(&mut self, now_ms: u64, kind: RecordKind, id: &str, op: ChangeOp) -> Change {
        let again = self.restamp_ahead(now_ms, 0, &[]);
        self.restamped.extend(again.iter().map(|c| c.seq));
        let stamp = self.next_stamp(now_ms);
        self.seq = self.seq.saturating_add(1);
        let c = Change {
            stamp,
            seq: self.seq,
            kind: kind.as_str().into(),
            id: id.into(),
            op,
        };
        self.put((self.member.clone(), self.seq), c.clone());
        c
    }

    /// The next stamp of a change made here at wall time `now_ms`. The
    /// clock stays the latest stamp seen or made, so a stamp left out now
    /// counts again once the wall clock is within a day of it.
    fn next_stamp(&mut self, now_ms: u64) -> Stamp {
        let (ms, n) = self.clock_at(now_ms);
        let next = if now_ms > ms {
            (now_ms, 0)
        } else if n == u32::MAX {
            // A counter at its limit, from a change received: the next
            // millisecond instead.
            (ms + 1, 0)
        } else {
            (ms, n + 1)
        };
        self.clock = self.clock.max(next);
        Stamp {
            ms: next.0,
            n: next.1,
            member: self.member.clone(),
        }
    }

    /// This log's own changes after the first `counted`, oldest first.
    fn own_after(&self, counted: u64) -> impl Iterator<Item = &Change> {
        self.changes
            .range((self.member.clone(), counted.saturating_add(1))..)
            .take_while(|((m, _), _)| *m == self.member)
            .map(|(_, c)| c)
    }

    /// Whether any of this log's own changes after the first `counted` is
    /// stamped past [`Self::limit`] at wall time `now_ms`: made while this
    /// member's clock was wrong, so its central host may have refused it.
    pub fn own_ahead_after(&self, now_ms: u64, counted: u64) -> bool {
        let limit = self.limit(now_ms);
        self.own_after(counted).any(|c| c.stamp.ms > limit)
    }

    /// Stamps again, at wall time `now_ms`, this log's own changes stamped
    /// past [`Self::limit`]: made while this member's clock was wrong, and
    /// refused by every member whose clock was right. Each keeps its number
    /// with its new stamp, which closes the gap they left in what the
    /// others count, and a field one of them set can change again. Those
    /// its central host counts (`counted`, or [`Self::set_shared`]) or
    /// holds past them (`theirs`) are left as they are: another member may
    /// hold them, and takes no other change under their numbers. Returns
    /// the changes stamped again, oldest first; none while the clock is
    /// still wrong, as the stamps are then within its limit.
    pub fn restamp_ahead(&mut self, now_ms: u64, counted: u64, theirs: &[Change]) -> Vec<Change> {
        let limit = self.limit(now_ms);
        let held: BTreeSet<u64> = theirs
            .iter()
            .filter(|c| c.stamp.member == self.member)
            .map(|c| c.seq)
            .collect();
        let refused: Vec<Change> = self
            .own_after(counted.max(self.shared))
            .filter(|c| c.stamp.ms > limit && !held.contains(&c.seq))
            .cloned()
            .collect();
        let mut again = Vec::new();
        for c in refused {
            let c = Change { stamp: self.next_stamp(now_ms), ..c };
            self.put((self.member.clone(), c.seq), c.clone());
            again.push(c);
        }
        again
    }

    /// This log's own changes stamped again before a change made here
    /// ([`Self::stamped`]) and not handed on yet, oldest first, each as the
    /// log holds it now: they are sent with the change, as no exchange
    /// may come to send them until the next one. Each is handed on once.
    pub fn take_restamped(&mut self) -> Vec<Change> {
        let me = self.member.clone();
        std::mem::take(&mut self.restamped)
            .into_iter()
            .filter_map(|seq| self.get(&me, seq).cloned())
            .collect()
    }

    /// What this member has seen: for each member, the changes up to the
    /// first one missing. A change that came early, after a gap, counts
    /// once the gap is filled.
    pub fn version(&self) -> Version {
        let mut v = Version::new();
        for (member, seq) in self.changes.keys() {
            let seen = v.entry(member.clone()).or_insert(0);
            if *seq == *seen + 1 {
                *seen = *seq;
            }
        }
        v
    }

    /// The changes a member at `version` has not seen, oldest first for
    /// each member.
    pub fn missing_for(&self, version: &Version) -> Vec<Change> {
        self.changes
            .iter()
            .filter(|((member, seq), _)| *seq > version.get(member).copied().unwrap_or(0))
            .map(|(_, c)| c.clone())
            .collect()
    }

    /// The first of the changes a member at `version` has not seen
    /// ([`Self::missing_for`]), in the same order, as many as fit `budget`
    /// bytes of JSON, and whether more are missing: a log too large for one
    /// message goes a part at a time. Each member's changes come oldest
    /// first, so the member asks for the next part from past them
    /// ([`seen_through`]). A part holds at least one change, however large.
    pub fn missing_page(&self, version: &Version, budget: usize) -> (Vec<Change>, bool) {
        let missing = self
            .changes
            .iter()
            .filter(|((member, seq), _)| *seq > version.get(member).copied().unwrap_or(0))
            .map(|(_, c)| c);
        let mut page = Vec::new();
        // The brackets of the list, then each change and its comma.
        let mut used = 2;
        for c in missing {
            let size = json_len(c) + 1;
            if !page.is_empty() && used + size > budget {
                return (page, true);
            }
            used += size;
            page.push(c.clone());
        }
        (page, false)
    }

    /// Whether this log holds change `seq` of log `member`.
    pub fn has(&self, member: &str, seq: u64) -> bool {
        self.changes.contains_key(&(member.to_string(), seq))
    }

    /// Change `seq` of log `member`, when this log holds it.
    pub fn get(&self, member: &str, seq: u64) -> Option<&Change> {
        self.changes.get(&(member.to_string(), seq))
    }

    /// Whether any of this log's own changes in `theirs`, what another
    /// member holds, differs from the one this log holds under that number:
    /// this log went back in time ([`Self::take_back`]).
    pub fn differs_from(&self, theirs: &[Change]) -> bool {
        theirs
            .iter()
            .filter(|c| c.stamp.member == self.member)
            .any(|c| self.get(&self.member, c.seq).is_some_and(|mine| mine != c))
    }

    /// Takes back this log's own changes from `theirs`, what another member
    /// holds of them, after this log went back in time (restored from a
    /// backup, or a write lost): every member takes only the first change
    /// under a number, so the changes this log made since, under numbers
    /// its lost changes had, never got anywhere. The lost changes come
    /// back under their numbers, and those made since go again under new
    /// numbers after every one: returned, to send on. Their stamps stay,
    /// so they still win or give way as they did.
    pub fn take_back(&mut self, theirs: Vec<Change>) -> Vec<Change> {
        let mut again = Vec::new();
        let me = self.member.clone();
        for c in theirs.into_iter().filter(|c| c.stamp.member == me) {
            let key = (me.clone(), c.seq);
            match self.changes.get(&key) {
                Some(mine) if *mine == c => continue,
                Some(mine) => again.push(mine.clone()),
                None => {}
            }
            self.clock = self.clock.max((c.stamp.ms, c.stamp.n));
            self.seq = self.seq.max(c.seq);
            self.put(key, c);
        }
        again.sort_by_key(|c| c.seq);
        for c in &mut again {
            self.seq = self.seq.saturating_add(1);
            c.seq = self.seq;
            self.put((self.member.clone(), self.seq), c.clone());
        }
        again
    }

    /// The earliest change to record `id` of `kind`: the one that made it.
    pub fn first_change(&self, kind: RecordKind, id: &str) -> Option<&Change> {
        self.changes
            .values()
            .filter(|c| c.kind == kind.as_str() && c.id == id)
            .min_by(|a, b| a.stamp.cmp(&b.stamp))
    }

    /// Whether record `id` of `kind` was deleted: it never comes back.
    pub fn is_deleted(&self, kind: RecordKind, id: &str) -> bool {
        self.changes
            .values()
            .any(|c| c.kind == kind.as_str() && c.id == id && c.op == ChangeOp::Delete)
    }

    /// The records of `kind` by id, counting only the changes of the
    /// member that made each record (by worker id, X41): another member's
    /// change to it is left out, as if it never came.
    pub fn records_by_maker(&self, kind: RecordKind) -> BTreeMap<String, Record> {
        let maker: BTreeMap<&str, Option<&str>> = self
            .changes
            .values()
            .filter(|c| c.kind == kind.as_str())
            .fold(BTreeMap::new(), |mut first: BTreeMap<&str, &Change>, c| {
                let slot = first.entry(c.id.as_str()).or_insert(c);
                if c.stamp < slot.stamp {
                    *slot = c;
                }
                first
            })
            .into_iter()
            .map(|(id, c)| (id, log_owner(&c.stamp.member)))
            .collect();
        self.records_where(kind, |c| {
            maker.get(c.id.as_str()).copied().flatten().is_some_and(|m| log_owner(&c.stamp.member) == Some(m))
        })
    }

    /// The records of `kind` by id, counting only the changes `keep` takes.
    pub fn records_where(&self, kind: RecordKind, keep: impl Fn(&Change) -> bool) -> BTreeMap<String, Record> {
        records_of(self.changes_of(kind).filter(|c| keep(c)))
    }

    /// The changes to records of `kind`, from every member.
    pub fn changes_of(&self, kind: RecordKind) -> impl Iterator<Item = &Change> {
        self.changes.values().filter(move |c| c.kind == kind.as_str())
    }

    /// [`Self::changes_of`], for a kind by its name.
    pub fn changes_of_kind<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = &'a Change> + 'a {
        self.changes.values().filter(move |c| c.kind == kind)
    }

    /// The records of `kind` by id, each field at its latest change.
    pub fn records(&self, kind: RecordKind) -> BTreeMap<String, Record> {
        records_of(self.changes_of(kind))
    }
}

/// The records `changes` make, all of one kind, by id: each field at its
/// latest change.
fn records_of<'a>(changes: impl Iterator<Item = &'a Change>) -> BTreeMap<String, Record> {
    let mut latest: BTreeMap<(&str, &str), &Change> = BTreeMap::new();
    // A delete is final: nothing brings a deleted record back, so two
    // members never disagree on whether it exists.
    let mut deleted: BTreeSet<&str> = BTreeSet::new();
    for c in changes {
        match &c.op {
            ChangeOp::Set { field, .. } => {
                let slot = latest.entry((c.id.as_str(), field.as_str())).or_insert(c);
                if c.stamp > slot.stamp {
                    *slot = c;
                }
            }
            ChangeOp::Delete => {
                deleted.insert(c.id.as_str());
            }
        }
    }
    let mut out: BTreeMap<String, Record> = BTreeMap::new();
    for ((id, field), c) in latest.into_iter().filter(|((id, _), _)| !deleted.contains(id)) {
        if let ChangeOp::Set { value, .. } = &c.op {
            out.entry(id.to_string()).or_default().insert(field.to_string(), value.clone());
        }
    }
    out
}

/// How many bytes `c` takes as JSON.
fn json_len(c: &Change) -> usize {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 += buf.len();
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut n = Count(0);
    let _ = serde_json::to_writer(&mut n, c);
    n.0
}

/// `changes` in parts of at most `budget` bytes of JSON each, counted as
/// [`Log::missing_page`] counts them, in their order, so each fits one
/// `account.sync`; one part, empty, for none. A change larger than
/// `budget` goes alone.
pub fn in_parts(changes: Vec<Change>, budget: usize) -> Vec<Vec<Change>> {
    let mut parts = vec![Vec::new()];
    let mut used = 2;
    for c in changes {
        let size = json_len(&c) + 1;
        if parts.last().is_some_and(|p| !p.is_empty()) && used + size > budget {
            parts.push(Vec::new());
            used = 2;
        }
        used += size;
        parts.last_mut().unwrap().push(c);
    }
    parts
}

/// Moves `version`, what a member asks from, past the changes of `page`,
/// what its central host sent of what it lacks: the next page starts after
/// them, even past a change the central host never got.
pub fn seen_through(version: &mut Version, page: &[Change]) {
    for c in page {
        let seen = version.entry(c.stamp.member.clone()).or_insert(0);
        *seen = (*seen).max(c.seq);
    }
}

/// The name of a new log of worker `worker`, `<worker id>.<6 letters or
/// digits>`: a log made again gets a name of its own, so it never numbers
/// its changes as an earlier one did.
pub fn new_log_name(worker: &str) -> String {
    format!(
        "{worker}.{}",
        &uuid::Uuid::new_v4().simple().to_string()[..6]
    )
}

/// A project identity as the account keys records by it (X68):
/// `<origin>|<root>`; none for a project without a root, which is one
/// member's alone.
pub fn identity_key(i: &moonlet_proto::types::ProjectIdentity) -> Option<String> {
    Some(format!("{}|{}", i.origin.as_deref().unwrap_or(""), i.root.as_deref()?))
}

/// The id of [`RecordKind::Setup`]'s record of `worker`'s setup `command`
/// of project `identity` (X60): `<worker>|<origin>|<root>|<command>`.
/// Read back with [`setup_record_worker`].
pub fn setup_record_id(worker: &str, identity: &moonlet_proto::types::ProjectIdentity, command: &str) -> Option<String> {
    Some(format!("{worker}|{}|{command}", identity_key(identity)?))
}

/// The worker a [`setup_record_id`] names.
pub fn setup_record_worker(id: &str) -> &str {
    id.split('|').next().unwrap_or_default()
}

/// The worker a log belongs to, from the log's name, when it is one.
pub fn log_owner(name: &str) -> Option<&str> {
    let (worker, suffix) = name.rsplit_once('.')?;
    let fits = !worker.is_empty()
        && suffix.len() == 6
        && suffix.bytes().all(|b| b.is_ascii_alphanumeric());
    fits.then_some(worker)
}

const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// A sort key between `a` and `b`, either of which may be open: a key is a
/// base-36 fraction (`"i"` is one half), and two members placing items at
/// once never move each other's. Keys never end in `0`, so there is always
/// room before one.
///
/// Two members placing an item at once can give two items the same key,
/// so `b` may equal `a` or even come first: the key is then after `a`.
pub fn key_between(a: Option<&str>, b: Option<&str>) -> String {
    let b = b.filter(|b| a.is_none_or(|a| a < *b));
    midpoint(a.unwrap_or("").as_bytes(), b.map(str::as_bytes))
}

fn digit(d: u8) -> usize {
    DIGITS.iter().position(|&x| x == d).unwrap_or(0)
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> String {
    if let Some(b) = b {
        // Past their common prefix, so `a` and `b` differ in their first digit.
        let n = (0..b.len())
            .take_while(|&i| a.get(i).copied().unwrap_or(b'0') == b[i])
            .count();
        if n > 0 {
            let rest = midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]));
            return format!("{}{rest}", String::from_utf8_lossy(&b[..n]));
        }
    }
    let low = a.first().map_or(0, |&d| digit(d));
    let high = b
        .and_then(|b| b.first())
        .map_or(DIGITS.len(), |&d| digit(d));
    if high > low + 1 {
        return (DIGITS[(low + high) / 2] as char).to_string();
    }
    match b {
        // `b` goes on past its first digit, which alone is then between.
        Some(b) if b.len() > 1 => (b[0] as char).to_string(),
        _ => format!(
            "{}{}",
            DIGITS[low] as char,
            midpoint(a.get(1..).unwrap_or(&[]), None)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn set(
        ms: u64,
        member: &str,
        seq: u64,
        id: &str,
        field: &str,
        value: serde_json::Value,
    ) -> Change {
        Change {
            stamp: Stamp {
                ms,
                n: 0,
                member: member.into(),
            },
            seq,
            kind: "workspace".into(),
            id: id.into(),
            op: ChangeOp::Set {
                field: field.into(),
                value,
            },
        }
    }

    fn delete(ms: u64, member: &str, seq: u64, id: &str) -> Change {
        Change {
            op: ChangeOp::Delete,
            ..set(ms, member, seq, id, "", json!(null))
        }
    }

    #[test]
    fn a_field_takes_the_latest_change_whatever_order_the_changes_come_in() {
        let older = set(1_000, "mini", 1, "w1", "name", json!("Personal"));
        let newer = set(2_000, "book", 1, "w1", "name", json!("Home"));
        let mut a = Log::new("a");
        a.apply(vec![older.clone(), newer.clone()]);
        let mut b = Log::new("b");
        b.apply(vec![newer, older]);
        assert_eq!(
            a.records(RecordKind::Workspace)["w1"]["name"],
            json!("Home")
        );
        assert_eq!(
            b.records(RecordKind::Workspace)["w1"]["name"],
            json!("Home")
        );
    }

    #[test]
    fn a_deleted_record_stays_deleted_whatever_changes_it_later() {
        let made = set(1_000, "mini", 1, "w1", "name", json!("Acme"));
        let deleted = delete(2_000, "book", 1, "w1");
        let renamed_later = set(3_000, "mini", 2, "w1", "name", json!("Acme Inc"));
        let mut log = Log::new("a");
        log.apply(vec![renamed_later, deleted, made]);
        assert!(
            !log.records(RecordKind::Workspace).contains_key("w1"),
            "{:?}",
            log.records(RecordKind::Workspace)
        );
    }

    #[test]
    fn a_change_made_here_comes_after_every_change_seen_even_with_a_clock_behind() {
        let mut book = Log::new("book");
        // studio-mini's clock is ahead: its change says 10:00:05.
        book.apply(vec![set(
            36_005_000,
            "mini",
            1,
            "w1",
            "name",
            json!("Personal"),
        )]);
        // This Mac's clock says 10:00:01 when the user renames it.
        let first = book.set(
            36_001_000,
            RecordKind::Workspace,
            "w1",
            "name",
            json!("Home"),
        );
        let second = book.set(
            36_001_000,
            RecordKind::Workspace,
            "w1",
            "color",
            json!("blue"),
        );
        assert_eq!(
            book.records(RecordKind::Workspace)["w1"]["name"],
            json!("Home")
        );
        assert_eq!(
            first.stamp,
            Stamp {
                ms: 36_005_000,
                n: 1,
                member: "book".into()
            }
        );
        assert_eq!(
            second.stamp,
            Stamp {
                ms: 36_005_000,
                n: 2,
                member: "book".into()
            }
        );
        assert_eq!((first.seq, second.seq), (1, 2));
        // Once the wall clock passes it, stamps follow the wall clock again.
        let later = book.delete(36_009_000, RecordKind::Workspace, "w1");
        assert_eq!(
            later.stamp,
            Stamp {
                ms: 36_009_000,
                n: 0,
                member: "book".into()
            }
        );
        assert_eq!(later.seq, 3);
        assert!(book.records(RecordKind::Workspace).is_empty());
    }

    #[test]
    fn a_member_whose_clock_was_a_year_ahead_once_stamps_by_its_wall_clock_once_it_is_right() {
        // 2026-11-16 10:00 on the MacBook, whose clock said 2027-11-16 for a
        // minute while it renamed a workspace.
        let now = 1_794_823_200_000;
        let year = 365 * 24 * 60 * 60 * 1000;
        let mut book = Log::new("book.k3x9q2");
        let wrong = book.set(now + year, RecordKind::Workspace, "w1", "name", json!("Home"));
        assert_eq!(wrong.stamp.ms, 1_826_359_200_000);
        // Its clock is right again a minute later; the log, saved and
        // loaded again, still holds the stamp a year ahead. The next change
        // stamps "Home" again first, and comes after it.
        let mut book = Log::from_file(book.to_file());
        let right = book.set(now + 60_000, RecordKind::Workspace, "w1", "color", json!("blue"));
        let at = |ms: u64, n: u32| Stamp { ms, n, member: "book.k3x9q2".into() };
        assert_eq!(book.get("book.k3x9q2", 1).unwrap().stamp, at(1_794_823_260_000, 0));
        assert_eq!(right.stamp, at(1_794_823_260_000, 1));
        // So a rename made here now wins over it.
        book.set(now + 90_000, RecordKind::Workspace, "w1", "name", json!("Work"));
        assert_eq!(book.records(RecordKind::Workspace)["w1"]["name"], json!("Work"));
        // A change another member stamped an hour ahead still comes first:
        // a clock that drifts is not a clock that is wrong.
        book.apply(vec![set(now + 3_600_000, "mini.a1b2c3", 1, "w1", "name", json!("Studio"))]);
        let next = book.set(now + 120_000, RecordKind::Workspace, "w1", "name", json!("Office"));
        assert_eq!(next.stamp, at(1_794_826_800_000, 1));
        assert_eq!(book.records(RecordKind::Workspace)["w1"]["name"], json!("Office"));
    }

    #[test]
    fn a_stamp_left_out_of_the_clock_counts_again_once_the_wall_clock_is_within_a_day_of_it() {
        let now = 1_794_823_200_000;
        let hour = 60 * 60 * 1000;
        let mut book = Log::new("book.k3x9q2");
        // studio-mini's change, taken while this Mac's clock said a day
        // later than it says now.
        book.apply(vec![set(now + 36 * hour, "mini.a1b2c3", 1, "w1", "name", json!("Studio"))]);
        let first = book.set(now, RecordKind::Workspace, "w1", "color", json!("blue"));
        assert_eq!(first.stamp.ms, 1_794_823_200_000);
        // Fifteen hours on, it is within a day: a change comes after it.
        let next = book.set(now + 15 * hour, RecordKind::Workspace, "w1", "name", json!("Home"));
        assert_eq!((next.stamp.ms, next.stamp.n), (1_794_952_800_000, 1));
        assert_eq!(book.records(RecordKind::Workspace)["w1"]["name"], json!("Home"));
    }

    #[test]
    fn changes_refused_for_a_clock_that_was_wrong_are_stamped_again_and_their_fields_change_again() {
        let now = 1_794_823_200_000;
        let year = 365 * 24 * 60 * 60 * 1000;
        let book = "book.k3x9q2";
        let mut log = Log::new(book);
        let home = log.set(now - 600_000, RecordKind::Workspace, "w1", "name", json!("Home"));
        // A minute with the clock a year ahead: studio-mini refuses both.
        log.set(now + year, RecordKind::Workspace, "w1", "name", json!("Future"));
        log.set(now + year, RecordKind::Section, "s1", "name", json!("Train"));
        let mut central = Log::new("mini.a1b2c3");
        central.apply(vec![home]);

        // Nothing is stamped again while the clock is still a year ahead.
        assert!(!log.own_ahead_after(now + year + 5_000, 1));
        assert_eq!(log.clone().restamp_ahead(now + year + 5_000, 1, &[]), vec![]);
        assert!(log.own_ahead_after(now + 2_000, 1));
        let again = log.restamp_ahead(now + 2_000, 1, &[]);
        let at = |n: u32| Stamp { ms: 1_794_823_202_000, n, member: book.into() };
        assert_eq!(
            again.iter().map(|c| (c.seq, c.stamp.clone(), c.kind.as_str(), c.op.clone())).collect::<Vec<_>>(),
            vec![
                (2, at(0), "workspace", ChangeOp::Set { field: "name".into(), value: json!("Future") }),
                (3, at(1), "section", ChangeOp::Set { field: "name".into(), value: json!("Train") }),
            ]
        );
        assert!(!log.own_ahead_after(now + 2_000, 1));
        central.apply(again);
        assert_eq!(central.version()[book], 3);
        for l in [&log, &central] {
            assert_eq!(l.records(RecordKind::Workspace)["w1"]["name"], json!("Future"));
            assert_eq!(l.records(RecordKind::Section)["s1"]["name"], json!("Train"));
        }
        // Another member renames it a second later, and both take that.
        let studio = central.set(now + 3_000, RecordKind::Workspace, "w1", "name", json!("Studio"));
        log.apply(vec![studio]);
        for l in [&log, &central] {
            assert_eq!(l.records(RecordKind::Workspace)["w1"]["name"], json!("Studio"));
        }
    }

    #[test]
    fn changes_stamped_again_before_a_new_change_are_handed_on_once() {
        let now = 1_794_823_200_000;
        let year = 365 * 24 * 60 * 60 * 1000;
        let book = "book.k3x9q2";
        let mut log = Log::new(book);
        log.set(now - 600_000, RecordKind::Workspace, "w1", "name", json!("Home"));
        log.set_shared(1);
        log.set(now + year, RecordKind::Workspace, "w1", "name", json!("Future"));
        // Nothing stamped again while the clock is a year ahead.
        log.set(now + year, RecordKind::Section, "s1", "name", json!("Train"));
        assert_eq!(log.take_restamped(), vec![]);
        // Its clock is right again: a section made now stamps both again.
        let later = log.set(now + 2_000, RecordKind::Section, "s2", "name", json!("Later"));
        assert_eq!(later.seq, 4);
        let at = |n: u32| Stamp { ms: 1_794_823_202_000, n, member: book.into() };
        assert_eq!(
            log.take_restamped().iter().map(|c| (c.seq, c.stamp.clone(), c.op.clone())).collect::<Vec<_>>(),
            vec![
                (2, at(0), ChangeOp::Set { field: "name".into(), value: json!("Future") }),
                (3, at(1), ChangeOp::Set { field: "name".into(), value: json!("Train") }),
            ]
        );
        assert_eq!((later.stamp.ms, later.stamp.n), (1_794_823_202_000, 2));
        // Handed on once: the next change has none.
        log.set(now + 3_000, RecordKind::Section, "s2", "name", json!("Afterwards"));
        assert_eq!(log.take_restamped(), vec![]);
    }

    #[test]
    fn a_change_another_member_holds_is_never_stamped_again() {
        let now = 1_794_823_200_000;
        let year = 365 * 24 * 60 * 60 * 1000;
        let book = "book.k3x9q2";
        let mut log = Log::new(book);
        // studio-mini's clock was a year ahead too, and took the first one.
        let held = log.set(now + year, RecordKind::Workspace, "w1", "name", json!("Future"));
        log.set(now + year, RecordKind::Workspace, "w1", "color", json!("red"));
        log.set(now + year, RecordKind::Workspace, "w1", "view", json!("list"));
        assert_eq!(
            log.clone().restamp_ahead(now, 0, std::slice::from_ref(&held)).iter().map(|c| c.seq).collect::<Vec<_>>(),
            [2, 3]
        );
        assert_eq!(log.clone().restamp_ahead(now, 2, &[]).iter().map(|c| c.seq).collect::<Vec<_>>(), [3]);
        // Once an exchange said it counts the first two, a change made here
        // stamps only the third again.
        log.set_shared(2);
        log.set(now, RecordKind::Workspace, "w1", "name", json!("Home"));
        assert_eq!(log.get(book, 1), Some(&held));
        assert_eq!(log.get(book, 2).unwrap().stamp.ms, 1_826_359_200_000);
        assert_eq!(log.get(book, 3).unwrap().stamp.ms, 1_794_823_200_000);
    }

    /// A log of `n` session changes from two members, `mini` and `book`,
    /// about 170 bytes each as JSON, as a heavy user's log holds.
    fn big_log(n: u64) -> Log {
        let mut log = Log::new("mini.a1b2c3");
        log.apply((1..=n).map(|i| Change {
            stamp: Stamp { ms: 1_760_000_000_000 + i, n: 0, member: if i % 4 == 0 { "mini.a1b2c3" } else { "book.k3x9q2" }.into() },
            seq: if i % 4 == 0 { i / 4 } else { i - i / 4 },
            kind: "session".into(),
            id: format!("{:012x}", i / 13),
            op: ChangeOp::Set { field: "branch".into(), value: json!(format!("moonlet/fix-checkout-total-rounding-{i}")) },
        }));
        log
    }

    #[test]
    fn a_member_catching_up_on_a_log_larger_than_one_frame_gets_all_of_it_in_pages_that_each_fit_one() {
        let mini = big_log(110_000);
        let all = serde_json::to_vec(&mini.missing_for(&Version::new())).unwrap().len();
        assert!(all > moonlet_proto::MAX_FRAME_LEN, "the log is {all} bytes");
        let mut book = Log::new("book.k3x9q2");
        let mut asked = Version::new();
        let mut pages = 0;
        loop {
            let (page, more) = mini.missing_page(&asked, moonlet_proto::methods::ACCOUNT_PAGE_BYTES);
            let reply = moonlet_proto::methods::AccountSynced { changes: page.clone(), version: mini.version(), account: None, now_ms: Some(1), more };
            let frame = moonlet_proto::encode_frame(&moonlet_proto::Frame::Json(moonlet_proto::Message::ok(7, reply)));
            assert!(frame.is_ok(), "page {pages} does not fit one frame");
            pages += 1;
            seen_through(&mut asked, &page);
            book.apply(page);
            if !more {
                break;
            }
        }
        assert_eq!(pages, 2);
        assert_eq!(book.version(), mini.version());
        assert_eq!(book.version(), BTreeMap::from([("book.k3x9q2".to_string(), 82_500), ("mini.a1b2c3".to_string(), 27_500)]));
    }

    #[test]
    fn a_page_goes_on_past_a_gap_and_always_holds_a_change_however_large() {
        let mut mini = Log::new("mini.a1b2c3");
        let change = |seq: u64, value: &str| Change {
            stamp: Stamp { ms: 1_000 + seq, n: 0, member: "book.k3x9q2".into() },
            seq,
            kind: "workspace".into(),
            id: "w1".into(),
            op: ChangeOp::Set { field: "name".into(), value: json!(value) },
        };
        // The central host holds the MacBook's 1, 2 and 4: 3 never came.
        mini.apply([change(1, "a"), change(2, "b"), change(4, "d")]);
        let mut asked = Version::new();
        let (page, more) = mini.missing_page(&asked, 1);
        assert_eq!((page.iter().map(|c| c.seq).collect::<Vec<_>>(), more), (vec![1], true));
        seen_through(&mut asked, &page);
        let (page, more) = mini.missing_page(&asked, 1);
        assert_eq!((page.iter().map(|c| c.seq).collect::<Vec<_>>(), more), (vec![2], true));
        seen_through(&mut asked, &page);
        // Past the gap, so the member asks from 4 on, not from 2 again.
        let (page, more) = mini.missing_page(&asked, 1);
        assert_eq!((page.iter().map(|c| c.seq).collect::<Vec<_>>(), more), (vec![4], false));
        seen_through(&mut asked, &page);
        assert_eq!(asked, BTreeMap::from([("book.k3x9q2".to_string(), 4)]));
        assert_eq!(mini.missing_page(&asked, 1), (Vec::new(), false));
        // With room for all, one page.
        let (page, more) = mini.missing_page(&Version::new(), 1 << 20);
        assert_eq!((page.len(), more), (3, false));
    }

    /// A change as the MacBook's log would send it, `value` its branch.
    fn change(seq: u64, value: &str) -> Change {
        Change {
            stamp: Stamp { ms: 1_794_823_200_000 + seq, n: 0, member: "book.k3x9q2".into() },
            seq,
            kind: "session".into(),
            id: "fix-cart".into(),
            op: ChangeOp::Set { field: "branch".into(), value: json!(value) },
        }
    }

    #[test]
    fn changes_too_many_for_one_message_go_in_parts_that_each_fit_one_in_their_order() {
        // Each of these is 159 bytes of JSON: two with their brackets and
        // commas (322) fit 330 bytes, three (482) do not.
        assert_eq!(serde_json::to_vec(&change(1, "moonlet/fix-cart")).unwrap().len(), 159);
        let all: Vec<_> = (1..=5).map(|i| change(i, "moonlet/fix-cart")).collect();
        let parts = in_parts(all, 330);
        let seqs: Vec<Vec<u64>> = parts.iter().map(|p| p.iter().map(|c| c.seq).collect()).collect();
        assert_eq!(seqs, [vec![1, 2], vec![3, 4], vec![5]]);
        // A change larger than a part goes alone; none is one empty part.
        let big = change(6, &"x".repeat(400));
        let parts = in_parts(vec![change(1, "a"), big, change(7, "b")], 330);
        assert_eq!(parts.iter().map(Vec::len).collect::<Vec<_>>(), [1, 1, 1]);
        assert_eq!(in_parts(Vec::new(), 330), [Vec::new()]);
    }

    #[test]
    fn a_member_that_missed_a_change_gets_exactly_what_it_lacks_and_both_agree() {
        let mut mini = Log::new("mini");
        let m1 = mini.set(
            1_000,
            RecordKind::Workspace,
            "w1",
            "name",
            json!("Personal"),
        );
        mini.set(2_000, RecordKind::Workspace, "w1", "color", json!("blue"));
        let m3 = mini.set(
            3_000,
            RecordKind::Section,
            "s1",
            "name",
            json!("1devstudio"),
        );
        let mut book = Log::new("book");
        book.set(2_500, RecordKind::Workspace, "w1", "name", json!("Home"));
        // The event carrying the colour never arrived.
        book.apply(vec![m1, m3.clone()]);
        assert_eq!(
            book.version(),
            BTreeMap::from([("book".to_string(), 1), ("mini".to_string(), 1)])
        );

        let for_book = mini.missing_for(&book.version());
        assert_eq!(
            for_book
                .iter()
                .map(|c| (c.stamp.member.as_str(), c.seq))
                .collect::<Vec<_>>(),
            [("mini", 2), ("mini", 3)]
        );
        book.apply(for_book);
        // m3 came twice and counts once.
        book.apply(vec![m3]);
        mini.apply(book.missing_for(&mini.version()));

        let both = BTreeMap::from([("book".to_string(), 1), ("mini".to_string(), 3)]);
        assert_eq!((book.version(), mini.version()), (both.clone(), both));
        assert!(mini.missing_for(&book.version()).is_empty());
        assert!(book.missing_for(&mini.version()).is_empty());
        for kind in [RecordKind::Workspace, RecordKind::Section] {
            assert_eq!(book.records(kind), mini.records(kind));
        }
        assert_eq!(
            mini.records(RecordKind::Workspace)["w1"],
            Record::from([
                ("name".into(), json!("Home")),
                ("color".into(), json!("blue"))
            ])
        );
    }

    #[test]
    fn a_change_that_comes_again_with_other_content_does_not_replace_the_first() {
        let mut log = Log::new("book.k3x9q2");
        log.apply(vec![set(
            1_000,
            "mini.a1b2c3",
            1,
            "w1",
            "name",
            json!("Personal"),
        )]);
        // Another change under the same member and number: never history
        // rewritten after the fact.
        log.apply(vec![set(
            1_000,
            "mini.a1b2c3",
            1,
            "w1",
            "name",
            json!("Forged"),
        )]);
        assert_eq!(
            log.records(RecordKind::Workspace)["w1"]["name"],
            json!("Personal")
        );
    }

    #[test]
    fn a_log_that_went_back_takes_back_its_lost_changes_and_numbers_its_new_ones_after_them() {
        let book = "book.k3x9q2";
        let home = set(1_000, book, 1, "w1", "name", json!("Home"));
        let work = set(2_000, book, 2, "w1", "name", json!("Work"));
        let color = set(2_001, book, 3, "w1", "color", json!("green"));
        // Restored from a backup that has only "Home", the MacBook renames
        // the workspace again: under number 2, which "Work" had.
        let mut log = Log::new(book);
        log.apply(vec![home.clone()]);
        let studio = log.set(3_000, RecordKind::Workspace, "w1", "name", json!("Studio"));
        assert_eq!(studio.seq, 2);

        // Its central host holds what it lost: "Work" differs from
        // "Studio", and "Home" is the same on both.
        assert!(log.differs_from(&[home.clone(), work.clone()]));
        assert!(!log.differs_from(&[home.clone(), color.clone()]));
        let again = log.take_back(vec![home.clone(), work.clone(), color.clone()]);
        assert_eq!(
            again,
            vec![set(3_000, book, 4, "w1", "name", json!("Studio"))]
        );
        assert_eq!(log.version(), Version::from([(book.to_string(), 4)]));
        assert_eq!(
            log.records(RecordKind::Workspace)["w1"],
            Record::from([
                ("name".into(), json!("Studio")),
                ("color".into(), json!("green"))
            ])
        );
        // What the central host holds and what the log sends again are the
        // log's whole history: they meet anywhere at the same record.
        let mut central = Log::new("mini.a1b2c3");
        central.apply(vec![home, work, color]);
        central.apply(again);
        assert_eq!(central.missing_for(&Version::new()), log.missing_for(&Version::new()));
        // A log that lost nothing has nothing to send again.
        assert!(!log.differs_from(&central.missing_for(&Version::new())));
        let mut whole = log.clone();
        assert_eq!(whole.take_back(central.missing_for(&Version::new())), vec![]);
    }

    #[test]
    fn sort_keys_fit_between_before_and_after_any_keys() {
        assert_eq!(key_between(None, None), "i");
        assert_eq!(key_between(Some("i"), None), "r");
        assert_eq!(key_between(None, Some("i")), "9");
        // Neighbouring digits leave no room, so the key grows a digit.
        assert_eq!(key_between(Some("i"), Some("j")), "ii");
        assert_eq!(key_between(None, Some("01")), "00i");
        assert_eq!(key_between(Some("z"), None), "zi");

        // A section dragged to the top 60 times, and one to the bottom,
        // always land where they were dropped.
        let mut keys = vec![key_between(None, None)];
        for _ in 0..60 {
            let first = key_between(None, Some(&keys[0]));
            keys.insert(0, first);
            let last = key_between(keys.last().map(String::as_str), None);
            keys.push(last);
        }
        // And one between every neighbouring pair.
        let between: Vec<String> = keys
            .windows(2)
            .map(|w| key_between(Some(&w[0]), Some(&w[1])))
            .collect();
        for (w, k) in keys.windows(2).zip(&between) {
            assert!(w[0] < *k && *k < w[1], "{} < {k} < {}", w[0], w[1]);
        }
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "{keys:?}");
        assert!(
            keys.iter().chain(&between).all(|k| !k.ends_with('0')),
            "{keys:?}"
        );
    }

    #[test]
    fn a_key_between_keys_that_leave_little_room_stays_between_them() {
        // Qodo's case: a key at most one digit longer than its bounds.
        let k = key_between(Some("i"), Some("i0i"));
        assert!(
            "i" < k.as_str() && k.as_str() < "i0i" && !k.ends_with('0'),
            "{k}"
        );
        let again = key_between(Some("i"), Some(&k));
        assert!(
            "i" < again.as_str() && again < k && !again.ends_with('0'),
            "{again}"
        );
        // Two members that placed a section at once got the same key, or
        // keys came in the wrong order: a key after the first, never a panic.
        assert_eq!(key_between(Some("r"), Some("r")), "v");
        assert_eq!(key_between(Some("r"), Some("i")), "v");
    }

    #[test]
    fn a_key_from_another_member_outside_base_36_still_gets_a_key_between() {
        // CodeRabbit's case: `A` is no base-36 digit here, but sorts after `9`.
        assert_eq!(key_between(Some("9"), Some("A")), "9i");
    }

    #[test]
    fn changes_stamped_at_the_same_time_are_ordered_by_member() {
        let a = set(1_000, "air.a1b2c3", 1, "w1", "name", json!("Air"));
        let b = set(1_000, "book.k3x9q2", 1, "w1", "name", json!("Book"));
        for order in [vec![a.clone(), b.clone()], vec![b, a]] {
            let mut log = Log::new("mini.f0e1d2");
            log.apply(order);
            assert_eq!(
                log.records(RecordKind::Workspace)["w1"]["name"],
                json!("Book")
            );
        }
    }

    #[test]
    fn a_change_reads_and_writes_as_the_protocol_says() {
        let wire = r#"[{"stamp":{"ms":1793000000000,"n":2,"member":"book.k3x9q2"},"seq":7,"kind":"section","id":"s1","op":{"set":{"field":"name","value":"Clients"}}},{"stamp":{"ms":1793000000001,"n":0,"member":"book.k3x9q2"},"seq":8,"kind":"section","id":"s1","op":"delete"}]"#;
        let changes: Vec<Change> = serde_json::from_str(wire).unwrap();
        assert_eq!(
            changes[0].op,
            ChangeOp::Set {
                field: "name".into(),
                value: json!("Clients")
            }
        );
        assert_eq!(changes[1].op, ChangeOp::Delete);
        assert_eq!(serde_json::to_string(&changes).unwrap(), wire);
    }

    #[test]
    fn a_counter_at_its_limit_moves_the_clock_on_instead_of_overflowing() {
        let mut log = Log::new("book.k3x9q2");
        log.apply(vec![Change {
            stamp: Stamp {
                ms: 5_000,
                n: u32::MAX,
                member: "mini.a1b2c3".into(),
            },
            ..set(5_000, "mini.a1b2c3", 1, "w1", "name", json!("Personal"))
        }]);
        let c = log.set(1_000, RecordKind::Workspace, "w1", "name", json!("Home"));
        assert_eq!(
            c.stamp,
            Stamp {
                ms: 5_001,
                n: 0,
                member: "book.k3x9q2".into()
            }
        );
        assert_eq!(
            log.records(RecordKind::Workspace)["w1"]["name"],
            json!("Home")
        );
    }

    #[test]
    fn a_log_name_is_its_worker_id_and_six_letters_or_digits() {
        let name = new_log_name("7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37");
        assert_eq!(
            log_owner(&name),
            Some("7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37")
        );
        assert_ne!(name, new_log_name("7d3f1c2a-5b8e-4e61-9a0f-2c4d6e8b1f37"));
        assert_eq!(log_owner("a.b.k3x9q2"), Some("a.b"));
        for not in [
            "book",
            "book.",
            ".k3x9q2",
            "book.k3x9q",
            "book.k3x9q2z",
            "book.k3x9-2",
        ] {
            assert_eq!(log_owner(not), None, "{not}");
        }
    }

    #[test]
    fn a_saved_log_reloads_with_its_changes_and_goes_on_counting() {
        let mut book = Log::new("book");
        book.apply(vec![set(9_000, "mini", 1, "w1", "name", json!("Personal"))]);
        book.set(1_000, RecordKind::Workspace, "w1", "name", json!("Home"));
        book.set(1_000, RecordKind::Workspace, "w1", "color", json!("blue"));
        let text = serde_json::to_string(&book.to_file()).unwrap();

        let mut again = Log::from_file(serde_json::from_str(&text).unwrap());
        assert_eq!(
            again.records(RecordKind::Workspace)["w1"],
            Record::from([
                ("name".into(), json!("Home")),
                ("color".into(), json!("blue"))
            ])
        );
        assert_eq!(
            again.version(),
            BTreeMap::from([("book".to_string(), 2), ("mini".to_string(), 1)])
        );
        let next = again.set(1_000, RecordKind::Workspace, "w1", "name", json!("Studio"));
        assert_eq!(
            (next.seq, next.stamp),
            (
                3,
                Stamp {
                    ms: 9_000,
                    n: 3,
                    member: "book".into()
                }
            )
        );
    }
}
