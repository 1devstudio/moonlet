//! Machine-hours per calendar month, UTC (X63).

use std::collections::BTreeMap;

/// Seconds of machine time by month, `YYYY-MM`.
pub type Usage = BTreeMap<String, u64>;

/// The month, `YYYY-MM` in UTC, of unix ms `at`.
pub fn month_of(at: u64) -> String {
    utc(at).format("%Y-%m").to_string()
}

fn utc(ms: u64) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::from_timestamp_millis(ms as i64).unwrap_or_default()
}

/// The start of the month after the one of `at`, in unix ms.
fn next_month(at: u64) -> u64 {
    use chrono::{Datelike, TimeZone};
    let t = utc(at);
    let (y, m) = if t.month() == 12 {
        (t.year() + 1, 1)
    } else {
        (t.year(), t.month() + 1)
    };
    chrono::Utc
        .with_ymd_and_hms(y, m, 1, 0, 0, 0)
        .single()
        .map_or(u64::MAX, |d| d.timestamp_millis() as u64)
}

/// Adds a machine's time from `from` to `to` (unix ms), split by month.
pub fn add(usage: &mut Usage, from: u64, to: u64) {
    let mut at = from;
    while at < to {
        let end = next_month(at).min(to);
        *usage.entry(month_of(at)).or_default() += (end - at) / 1000;
        at = end;
    }
}

/// Machine-hours in the month of `at`.
pub fn hours(usage: &Usage, at: u64) -> f64 {
    usage.get(&month_of(at)).copied().unwrap_or(0) as f64 / 3600.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(rfc3339: &str) -> u64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp_millis() as u64
    }

    #[test]
    fn counts_machine_hours_across_a_month_boundary() {
        let mut u = Usage::new();
        add(
            &mut u,
            ms("2026-10-31T23:30:00Z"),
            ms("2026-11-01T00:45:00Z"),
        );
        add(
            &mut u,
            ms("2026-11-03T09:00:00Z"),
            ms("2026-11-03T11:00:00Z"),
        );
        assert_eq!(
            u,
            Usage::from([("2026-10".into(), 1_800), ("2026-11".into(), 9_900)])
        );
        assert_eq!(hours(&u, ms("2026-11-15T12:00:00Z")), 2.75);
        assert_eq!(hours(&u, ms("2026-12-01T00:00:00Z")), 0.0);
        assert_eq!(month_of(ms("2026-12-31T23:59:59Z")), "2026-12");
    }
}
