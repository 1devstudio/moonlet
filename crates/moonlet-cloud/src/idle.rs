//! When an idle cloud machine is removed (X63).

/// What a ready machine has done: when it became ready, its routed
/// commands (start, and end once ended) and whether a command waits for it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Activity {
    pub ready_at: u64,
    pub runs: Vec<(u64, Option<u64>)>,
    pub waiting: bool,
}

/// The least time a machine that has run nothing yet stays, whatever the
/// idle time: overflow makes it for the next command.
pub const FIRST_USE_MINUTES: u32 = 5;

/// When the machine is removed, in the same unit as `a`'s times (ms):
/// after `idle_minutes` of continuous idleness, counted from ready or from
/// its last command's end, and not before `FIRST_USE_MINUTES` after ready
/// while it has run nothing. None while a command runs, or while one
/// waits for a machine that has run nothing yet.
pub fn removal_at(a: &Activity, idle_minutes: u32) -> Option<u64> {
    if a.runs.iter().any(|(_, end)| end.is_none()) {
        return None;
    }
    // Waited for by a command, it is not removed before it has run one.
    if a.waiting && a.runs.is_empty() {
        return None;
    }
    let idle_since = a
        .runs
        .iter()
        .filter_map(|(_, end)| *end)
        .fold(a.ready_at, u64::max);
    let idle = if a.runs.is_empty() {
        idle_minutes.max(FIRST_USE_MINUTES)
    } else {
        idle_minutes
    };
    Some(idle_since + u64::from(idle) * 60_000)
}

/// When a machine idle since `at` is removed, given that it was created at
/// `created_at` and how its provider bills it: when the time it has paid
/// for ends, less a margin for the removal itself (3 minutes, or a fifth of
/// a shorter unit), and never before `at`. `minute_ms` is a minute's
/// length in ms: tests shorten it, and the provider's units with it.
pub fn paid_end(at: u64, created_at: u64, billing: crate::Billing, minute_ms: u64) -> u64 {
    let scale = |secs: u64| secs * minute_ms / 60;
    let unit = scale(billing.unit_secs.max(1));
    let margin = scale(180).min(unit / 5);
    let elapsed = at.saturating_sub(created_at);
    let paid = elapsed
        .max(scale(billing.minimum_secs))
        .div_ceil(unit.max(1))
        * unit.max(1);
    (created_at + paid).saturating_sub(margin).max(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `hh:mm` as ms of the day.
    fn t(hm: &str) -> u64 {
        let (h, m) = hm.split_once(':').unwrap();
        (h.parse::<u64>().unwrap() * 60 + m.parse::<u64>().unwrap()) * 60_000
    }

    #[test]
    fn removes_at_the_times_in_the_worked_examples() {
        let ready = |runs: &[(&str, &str)]| Activity {
            ready_at: t("10:00"),
            runs: runs.iter().map(|(s, e)| (t(s), Some(t(e)))).collect(),
            waiting: false,
        };
        assert_eq!(removal_at(&ready(&[]), 15), Some(t("10:15")));
        assert_eq!(
            removal_at(&ready(&[("10:05", "10:12")]), 15),
            Some(t("10:27"))
        );
        assert_eq!(
            removal_at(&ready(&[("10:05", "10:20"), ("10:10", "10:30")]), 15),
            Some(t("10:45"))
        );
        assert_eq!(
            removal_at(&ready(&[("10:01", "10:04")]), 0),
            Some(t("10:04"))
        );
        // Nothing run yet: at least 5 minutes, for the command it was made for.
        assert_eq!(removal_at(&ready(&[]), 0), Some(t("10:05")));
        assert_eq!(removal_at(&ready(&[]), 3), Some(t("10:05")));
    }

    #[test]
    fn an_idle_machine_stays_until_its_paid_time_ends() {
        let hourly = crate::Billing {
            unit_secs: 3600,
            minimum_secs: 0,
        };
        let created = t("10:00");
        // Idle from 10:17: the hour it is in is paid until 11:00. It goes
        // 3 minutes before, so the removal ends inside it.
        assert_eq!(paid_end(t("10:17"), created, hourly, 60_000), t("10:57"));
        // Idle from 11:05: the second hour is paid, until 12:00.
        assert_eq!(paid_end(t("11:05"), created, hourly, 60_000), t("11:57"));
        // Idle from 10:58: already inside the last 3 minutes, so now.
        assert_eq!(paid_end(t("10:58"), created, hourly, 60_000), t("10:58"));
        // By the second, nothing is paid ahead: the idle time decides.
        let per_second = crate::Billing {
            unit_secs: 1,
            minimum_secs: 60,
        };
        assert_eq!(
            paid_end(t("10:15"), created, per_second, 60_000),
            t("10:15")
        );
        // In tests a "minute" is shorter: the hour shrinks with it.
        assert_eq!(paid_end(1_700, 0, hourly, 100), 5_700);
    }

    #[test]
    fn a_running_or_awaited_machine_is_not_removed() {
        let running = Activity {
            ready_at: t("10:00"),
            runs: vec![(t("10:05"), Some(t("10:12"))), (t("10:10"), None)],
            waiting: false,
        };
        assert_eq!(removal_at(&running, 15), None);
        let awaited = Activity {
            ready_at: t("10:00"),
            runs: vec![],
            waiting: true,
        };
        assert_eq!(removal_at(&awaited, 0), None);
    }
}
