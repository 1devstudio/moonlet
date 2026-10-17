//! Tracker timestamps as Unix milliseconds.

/// `2026-10-14T09:12:44.512Z`, `…+0200` or `…+02:00` as Unix milliseconds.
pub fn timestamp_ms(s: &str) -> Option<u64> {
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    if s.len() < 20 || s.as_bytes()[10] != b'T' {
        return None;
    }
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &s[19..];
    let mut ms = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        let padded = format!("{:0<3}", &frac[..digits.min(3)]);
        ms = padded.parse().ok()?;
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "Z" => 0,
        _ => {
            let sign = match rest.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 {
                return None;
            }
            sign * (digits[..2].parse::<i64>().ok()? * 60 + digits[2..].parse::<i64>().ok()?)
        }
    };
    // Days from 1970-01-01 to the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = ((days * 24 + hh) * 60 + mm) * 60 + ss - offset_min * 60;
    u64::try_from(secs * 1000 + ms).ok()
}

/// Unix milliseconds as their UTC day, `2026-10-26` (Howard Hinnant's algorithm).
pub fn date_of_ms(ms: u64) -> String {
    let z = (ms / 86_400_000) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc_3339_with_any_offset_and_fraction() {
        assert_eq!(
            timestamp_ms("2026-10-14T09:12:44.512Z"),
            Some(1_791_969_164_512)
        );
        // Jira writes the offset without a colon.
        assert_eq!(
            timestamp_ms("2026-10-14T11:12:44.512+0200"),
            Some(1_791_969_164_512)
        );
        assert_eq!(
            timestamp_ms("2026-10-14T09:12:44+00:00"),
            Some(1_791_969_164_000)
        );
        assert_eq!(timestamp_ms("yesterday"), None);
    }

    #[test]
    fn a_day_from_unix_milliseconds() {
        assert_eq!(date_of_ms(1_508_369_194_377), "2017-10-18");
        assert_eq!(date_of_ms(1_792_972_800_000), "2026-10-26");
        assert_eq!(date_of_ms(0), "1970-01-01");
    }
}
