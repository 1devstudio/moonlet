//! The account state shared by every member of an account (X68, ADR 0014):
//! records made of named fields, changed one field at a time. Every member
//! keeps every change; a field's value is the one with the latest stamp, so
//! members that have seen the same changes agree, in whatever order the
//! changes came.

use std::collections::{BTreeMap, BTreeSet};

use moonlet_proto::types::{Change, ChangeOp, Stamp};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
}

/// One member's copy of the account state: every change it has seen.
#[derive(Debug, Clone)]
pub struct Log {
    member: String,
    /// The latest stamp's time and counter seen or made here.
    clock: (u64, u32),
    /// How many changes this member has made.
    seq: u64,
    /// Every change seen, by member and `seq`, so one that arrives twice
    /// is kept once.
    changes: BTreeMap<(String, u64), Change>,
    /// The names this machine's logs had before this one.
    former: Vec<String>,
}

impl Log {
    pub fn new(member: &str) -> Log {
        Log {
            member: member.into(),
            clock: (0, 0),
            seq: 0,
            changes: BTreeMap::new(),
            former: Vec::new(),
        }
    }

    pub fn from_file(file: LogFile) -> Log {
        let mut log = Log::new(&file.member);
        log.apply(file.changes);
        log.former = file.former;
        log
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
        let theirs: Vec<Change> = self.changes.values().filter(|c| c.stamp.member == old).cloned().collect();
        for c in theirs {
            self.seq = self.seq.saturating_add(1);
            let mine = Change {
                stamp: Stamp { member: self.member.clone(), ..c.stamp },
                seq: self.seq,
                ..c
            };
            self.changes.insert((self.member.clone(), self.seq), mine);
        }
        self.former.push(old.to_string());
    }

    pub fn to_file(&self) -> LogFile {
        LogFile {
            member: self.member.clone(),
            changes: self.changes.values().cloned().collect(),
            former: self.former.clone(),
        }
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
        }
    }

    /// Sets a field of a record here, at wall time `now_ms`.
    pub fn set(&mut self, now_ms: u64, kind: &str, id: &str, field: &str, value: Value) -> Change {
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

    /// Deletes a record here, at wall time `now_ms`.
    pub fn delete(&mut self, now_ms: u64, kind: &str, id: &str) -> Change {
        self.stamped(now_ms, kind, id, ChangeOp::Delete)
    }

    /// A change stamped later than every change seen, even when this
    /// machine's clock is behind another member's.
    fn stamped(&mut self, now_ms: u64, kind: &str, id: &str, op: ChangeOp) -> Change {
        let (ms, n) = self.clock;
        self.clock = if now_ms > ms {
            (now_ms, 0)
        } else if n == u32::MAX {
            // A counter at its limit, from a change received: the next
            // millisecond instead.
            (ms + 1, 0)
        } else {
            (ms, n + 1)
        };
        self.seq = self.seq.saturating_add(1);
        let c = Change {
            stamp: Stamp {
                ms: self.clock.0,
                n: self.clock.1,
                member: self.member.clone(),
            },
            seq: self.seq,
            kind: kind.into(),
            id: id.into(),
            op,
        };
        self.changes
            .insert((self.member.clone(), self.seq), c.clone());
        c
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

    /// Whether this log holds change `seq` of log `member`.
    pub fn has(&self, member: &str, seq: u64) -> bool {
        self.changes.contains_key(&(member.to_string(), seq))
    }

    /// Whether record `id` of `kind` was deleted: it never comes back.
    pub fn is_deleted(&self, kind: &str, id: &str) -> bool {
        self.changes
            .values()
            .any(|c| c.kind == kind && c.id == id && c.op == ChangeOp::Delete)
    }

    /// The records of `kind` by id, each field at its latest change.
    pub fn records(&self, kind: &str) -> BTreeMap<String, Record> {
        let mut latest: BTreeMap<(&str, &str), &Change> = BTreeMap::new();
        for c in self.changes.values().filter(|c| c.kind == kind) {
            if let ChangeOp::Set { field, .. } = &c.op {
                let slot = latest.entry((c.id.as_str(), field.as_str())).or_insert(c);
                if c.stamp > slot.stamp {
                    *slot = c;
                }
            }
        }
        // A delete is final: nothing brings a deleted record back, so two
        // members never disagree on whether it exists.
        let deleted: BTreeSet<&str> = self
            .changes
            .values()
            .filter(|c| c.kind == kind && c.op == ChangeOp::Delete)
            .map(|c| c.id.as_str())
            .collect();
        let mut out: BTreeMap<String, Record> = BTreeMap::new();
        for ((id, field), c) in latest
            .into_iter()
            .filter(|((id, _), _)| !deleted.contains(id))
        {
            if let ChangeOp::Set { value, .. } = &c.op {
                out.entry(id.to_string())
                    .or_default()
                    .insert(field.to_string(), value.clone());
            }
        }
        out
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
        assert_eq!(a.records("workspace")["w1"]["name"], json!("Home"));
        assert_eq!(b.records("workspace")["w1"]["name"], json!("Home"));
    }

    #[test]
    fn a_deleted_record_stays_deleted_whatever_changes_it_later() {
        let made = set(1_000, "mini", 1, "w1", "name", json!("Acme"));
        let deleted = delete(2_000, "book", 1, "w1");
        let renamed_later = set(3_000, "mini", 2, "w1", "name", json!("Acme Inc"));
        let mut log = Log::new("a");
        log.apply(vec![renamed_later, deleted, made]);
        assert!(
            !log.records("workspace").contains_key("w1"),
            "{:?}",
            log.records("workspace")
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
        let first = book.set(36_001_000, "workspace", "w1", "name", json!("Home"));
        let second = book.set(36_001_000, "workspace", "w1", "color", json!("blue"));
        assert_eq!(book.records("workspace")["w1"]["name"], json!("Home"));
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
        let later = book.delete(36_009_000, "workspace", "w1");
        assert_eq!(
            later.stamp,
            Stamp {
                ms: 36_009_000,
                n: 0,
                member: "book".into()
            }
        );
        assert_eq!(later.seq, 3);
        assert!(book.records("workspace").is_empty());
    }

    #[test]
    fn a_member_that_missed_a_change_gets_exactly_what_it_lacks_and_both_agree() {
        let mut mini = Log::new("mini");
        let m1 = mini.set(1_000, "workspace", "w1", "name", json!("Personal"));
        mini.set(2_000, "workspace", "w1", "color", json!("blue"));
        let m3 = mini.set(3_000, "section", "s1", "name", json!("1devstudio"));
        let mut book = Log::new("book");
        book.set(2_500, "workspace", "w1", "name", json!("Home"));
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
        for kind in ["workspace", "section"] {
            assert_eq!(book.records(kind), mini.records(kind));
        }
        assert_eq!(
            mini.records("workspace")["w1"],
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
        assert_eq!(log.records("workspace")["w1"]["name"], json!("Personal"));
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
            assert_eq!(log.records("workspace")["w1"]["name"], json!("Book"));
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
        let c = log.set(1_000, "workspace", "w1", "name", json!("Home"));
        assert_eq!(
            c.stamp,
            Stamp {
                ms: 5_001,
                n: 0,
                member: "book.k3x9q2".into()
            }
        );
        assert_eq!(log.records("workspace")["w1"]["name"], json!("Home"));
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
        book.set(1_000, "workspace", "w1", "name", json!("Home"));
        book.set(1_000, "workspace", "w1", "color", json!("blue"));
        let text = serde_json::to_string(&book.to_file()).unwrap();

        let mut again = Log::from_file(serde_json::from_str(&text).unwrap());
        assert_eq!(
            again.records("workspace")["w1"],
            Record::from([
                ("name".into(), json!("Home")),
                ("color".into(), json!("blue"))
            ])
        );
        assert_eq!(
            again.version(),
            BTreeMap::from([("book".to_string(), 2), ("mini".to_string(), 1)])
        );
        let next = again.set(1_000, "workspace", "w1", "name", json!("Studio"));
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
