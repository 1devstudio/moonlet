//! The sweep (X63): what to do with the provider's machines labelled with
//! this central host, against moonlet's records.

/// A record's state, as far as the sweep cares.
#[derive(Debug, Clone, PartialEq)]
pub enum Recorded {
    /// Recorded before the create call; `call_started` while it runs.
    Creating { call_started: Option<u64> },
    /// Starting or ready: moonlet keeps it.
    Kept,
    /// Being removed, or removed.
    Removing,
}

/// A create call older than this is taken as stuck.
pub const CALL_TIMEOUT_MS: u64 = 5 * 60_000;

/// What the sweep does: machines to destroy (provider ids) and records to drop.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Sweep {
    pub destroy: Vec<String>,
    pub drop: Vec<String>,
}

/// `records` by machine id, `listed` as `(provider id, its moonlet-machine
/// label)`, at unix ms `now`.
pub fn sweep(
    records: &[(String, Recorded)],
    listed: &[(String, Option<String>)],
    now: u64,
) -> Sweep {
    let calling = |r: &Recorded| matches!(r, Recorded::Creating { call_started: Some(t) } if now.saturating_sub(*t) <= CALL_TIMEOUT_MS);
    let record = |id: &Option<String>| {
        id.as_ref()
            .and_then(|id| records.iter().find(|(r, _)| r == id))
            .map(|(_, r)| r)
    };
    let destroy = listed
        .iter()
        .filter(|(_, machine)| match record(machine) {
            // A machine moonlet has lost track of, or is removing.
            None | Some(Recorded::Removing) => true,
            Some(r @ Recorded::Creating { .. }) => !calling(r),
            Some(Recorded::Kept) => false,
        })
        .map(|(id, _)| id.clone())
        .collect();
    // Records of machines the provider no longer has, unless still being made.
    let drop = records
        .iter()
        .filter(|(id, r)| !calling(r) && !listed.iter().any(|(_, m)| m.as_deref() == Some(id)))
        .map(|(id, _)| id.clone())
        .collect();
    Sweep { destroy, drop }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, r: Recorded) -> (String, Recorded) {
        (id.into(), r)
    }

    fn found(ids: &[&str]) -> Vec<(String, Option<String>)> {
        ids.iter()
            .map(|id| (format!("p-{id}"), Some(id.to_string())))
            .collect()
    }

    #[test]
    fn sweeps_as_in_the_worked_examples() {
        let now = 1_000_000;
        // A ready, B removing; the provider lists A, B, C.
        assert_eq!(
            sweep(
                &[rec("A", Recorded::Kept), rec("B", Recorded::Removing)],
                &found(&["A", "B", "C"]),
                now
            ),
            Sweep {
                destroy: vec!["p-B".into(), "p-C".into()],
                drop: vec![]
            }
        );
        let stuck = || Recorded::Creating { call_started: None };
        // D creating, no call in progress; the provider lists D.
        assert_eq!(
            sweep(&[rec("D", stuck())], &found(&["D"]), now),
            Sweep {
                destroy: vec!["p-D".into()],
                drop: vec![]
            }
        );
        // D creating, no call in progress; the provider lists nothing.
        assert_eq!(
            sweep(&[rec("D", stuck())], &found(&[]), now),
            Sweep {
                destroy: vec![],
                drop: vec!["D".into()]
            }
        );
        // E creating, call in progress for 40 s.
        let going = Recorded::Creating {
            call_started: Some(now - 40_000),
        };
        assert_eq!(
            sweep(&[rec("E", going)], &found(&["E"]), now),
            Sweep::default()
        );
        // F ready; the provider lists nothing.
        assert_eq!(
            sweep(&[rec("F", Recorded::Kept)], &found(&[]), now),
            Sweep {
                destroy: vec![],
                drop: vec!["F".into()]
            }
        );
    }

    #[test]
    fn a_create_call_running_over_five_minutes_counts_as_stuck() {
        let now = 1_000_000;
        let old = Recorded::Creating {
            call_started: Some(now - 6 * 60_000),
        };
        assert_eq!(
            sweep(&[rec("G", old)], &found(&["G"]), now).destroy,
            ["p-G"]
        );
        // A machine without moonlet's machine label is not moonlet's to keep.
        assert_eq!(sweep(&[], &[("p-x".into(), None)], now).destroy, ["p-x"]);
    }
}
