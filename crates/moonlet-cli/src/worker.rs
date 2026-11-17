//! `moonlet worker down` (X63): what a machine still runs, said before it
//! is removed once those commands end.

use moonlet_proto::methods::CloudMachine;

/// What `moonlet worker down` says of machine `m` before it asks for its
/// removal: the commands it runs, for which session on which host, which
/// it waits for. None when it runs nothing, and goes at once.
pub fn down_note(m: &CloudMachine) -> Option<String> {
    let n = m.running.max(m.runs.len() as u32);
    if n == 0 {
        return None;
    }
    let (what, end) = if n == 1 {
        ("1 command".to_string(), "it ends")
    } else {
        (format!("{n} commands"), "they end")
    };
    // A central host before members' commands counted names none.
    let name = printable(&m.name);
    if m.runs.is_empty() {
        return Some(format!("{name} runs {what}; it is removed once {end}.\n"));
    }
    let mut out = format!("{name} runs {what}; it is removed once {end}:\n");
    for r in &m.runs {
        let session = match &r.host {
            Some(host) => format!("{} on {}", printable(&r.session), printable(host)),
            None => printable(&r.session),
        };
        let command = r.command.as_deref().map_or("copying the session".into(), printable);
        out.push_str(&format!("  {session}: {command}\n"));
    }
    Some(out)
}

/// `s` safe for the terminal: names and commands come from other
/// members, so control characters go, and line breaks and tabs become
/// spaces.
fn printable(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c {
            '\t' | '\r' | '\n' => Some(' '),
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn machine(running: u32, runs: serde_json::Value) -> CloudMachine {
        serde_json::from_value(json!({
            "id": "m1", "name": "moonlet-shop-4hn0", "project": "shop", "project_key": " abc",
            "provider": "fake", "type": "small", "location": "here", "state": "ready",
            "since": 0, "steps": [], "running": running, "runs": runs
        }))
        .unwrap()
    }

    #[test]
    fn an_idle_machine_goes_without_a_word() {
        assert_eq!(down_note(&machine(0, json!([]))), None);
    }

    #[test]
    fn names_each_command_and_whose_session_it_is_for() {
        let m = machine(
            2,
            json!([
                { "session": "fix-cart", "command": "pnpm test", "since": 1 },
                { "session": "Fix cart", "host": "Alex's MacBook Pro", "since": 2 }
            ]),
        );
        assert_eq!(
            down_note(&m).unwrap(),
            "moonlet-shop-4hn0 runs 2 commands; it is removed once they end:\n  fix-cart: pnpm test\n  Fix cart on Alex's MacBook Pro: copying the session\n"
        );
    }

    #[test]
    fn a_name_with_terminal_escapes_prints_without_them() {
        // Session names and commands come from other members.
        let m = machine(
            1,
            json!([{ "session": "x\u{1b}]0;pwned\u{7}", "host": "Mac\u{1b}[2J", "command": "make\r\nall", "since": 1 }]),
        );
        assert_eq!(
            down_note(&m).unwrap(),
            "moonlet-shop-4hn0 runs 1 command; it is removed once it ends:\n  x]0;pwned on Mac[2J: make  all\n"
        );
    }

    #[test]
    fn a_central_host_that_names_no_command_still_says_it_waits() {
        // One before members' commands counted: `runs` is absent.
        let m: CloudMachine = serde_json::from_value(json!({
            "id": "m1", "name": "moonlet-shop-4hn0", "project": "shop", "project_key": " abc",
            "provider": "fake", "type": "small", "location": "here", "state": "ready",
            "since": 0, "steps": [], "running": 1
        }))
        .unwrap();
        assert_eq!(
            down_note(&m).unwrap(),
            "moonlet-shop-4hn0 runs 1 command; it is removed once it ends.\n"
        );
    }
}
