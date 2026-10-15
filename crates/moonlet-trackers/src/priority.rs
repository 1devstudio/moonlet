//! Priority as 0–3 bars on cards (X44 "States").

/// Linear's priority number: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
pub fn linear_bars(priority: u8) -> u8 {
    match priority {
        1 | 2 => 3,
        3 => 2,
        4 => 1,
        _ => 0,
    }
}

/// A Jira priority name (Highest … Lowest) or a ClickUp one (urgent, high,
/// normal, low).
pub fn named_bars(name: &str) -> u8 {
    match name.to_ascii_lowercase().as_str() {
        "highest" | "urgent" | "high" | "critical" | "blocker" => 3,
        "medium" | "normal" | "major" => 2,
        "low" | "lowest" | "minor" | "trivial" => 1,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_priority_numbers() {
        // Linear: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
        assert_eq!([0, 1, 2, 3, 4].map(linear_bars), [0, 3, 3, 2, 1]);
    }

    #[test]
    fn jira_and_clickup_priority_names() {
        assert_eq!(
            [
                "Highest", "High", "Medium", "Low", "Lowest", "urgent", "normal", ""
            ]
            .map(named_bars),
            [3, 3, 2, 1, 1, 3, 2, 0]
        );
        // Jira's older scheme.
        assert_eq!(
            ["Blocker", "Critical", "Major", "Minor", "Trivial"].map(named_bars),
            [3, 3, 2, 1, 1]
        );
    }
}
