//! When the Mac goes to sleep and wakes (X73). macOS tells a process in
//! the user's session before every system sleep, and waits up to 30 s for
//! its answer; the daemon hands its sessions to the central host in that
//! time, then lets the Mac sleep.

use std::sync::Arc;
use std::time::Duration;

use crate::daemon::Daemon;

/// How long the daemon holds sleep at most: inside macOS's 30 s.
pub const HOLD: Duration = Duration::from_secs(25);

/// [`HOLD`], or what a test sets in `MOONLET_TEST_HOLD_MS` for
/// `power.simulate`.
pub fn test_hold() -> Duration {
    std::env::var("MOONLET_TEST_HOLD_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map_or(HOLD, Duration::from_millis)
}

/// What the Mac is about to do, or did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Power {
    Sleep,
    Wake,
}

/// A chat frozen as the Mac went to sleep: its session, and that
/// session's owner and `epoch` as this member knows them at wake.
pub struct Frozen<'a> {
    pub chat: moonlet_proto::TerminalId,
    pub session: &'a str,
    pub owner: Option<&'a str>,
    pub epoch: u64,
    /// The session's `epoch` as the Mac went to sleep, when it was this
    /// member's then.
    pub slept_at: Option<u64>,
}

impl Frozen<'_> {
    /// Whether its session is still this member `me`'s as far as it knows:
    /// it owns it, and the central host did not answer it took it.
    fn still_mine(&self, taken: &std::collections::HashSet<String>, me: &str) -> bool {
        self.owner == Some(me) && !taken.contains(self.session)
    }
}

/// The frozen chats that go on at wake (X73): those of a session this
/// member `me` still owns at the `epoch` it had as the Mac slept, and that
/// the central host did not answer it took (`taken`), even when the news
/// of its new owner has not arrived yet. The rest stay stopped until the
/// member lets go of their session.
pub fn to_thaw(
    frozen: &[Frozen],
    taken: &std::collections::HashSet<String>,
    me: &str,
) -> Vec<moonlet_proto::TerminalId> {
    frozen
        .iter()
        .filter(|f| f.still_mine(taken, me))
        .filter(|f| f.slept_at.is_none_or(|e| e == f.epoch))
        .map(|f| f.chat)
        .collect()
}

/// The frozen chats whose agent ends at wake (X73), its conversation kept
/// for the next message: those of a session this member `me` owns again,
/// but at another `epoch` than as the Mac slept. The other chats that do
/// not go on end as their session is let go of.
pub fn to_end(
    frozen: &[Frozen],
    taken: &std::collections::HashSet<String>,
    me: &str,
) -> Vec<moonlet_proto::TerminalId> {
    frozen
        .iter()
        .filter(|f| f.still_mine(taken, me))
        .filter(|f| f.slept_at.is_some_and(|e| e != f.epoch))
        .map(|f| f.chat)
        .collect()
}

/// Whether a session whose chats are in `states` goes to the central host
/// as the Mac goes to sleep (X73): only while one of them is at work or
/// waits on something, a turn running, an ask open, a message queued or a
/// subagent running. An idle session stays, so a short idle sleep with the
/// lid open moves nothing.
pub fn hand_over_at_sleep(states: &[moonlet_proto::types::ChatState]) -> bool {
    states.iter().any(moonlet_core::chat::at_work)
}

/// A session's record as a member knows it: its owner, ownership number,
/// and whether it is pinned or archived.
pub struct Known<'a> {
    pub owner: Option<&'a str>,
    pub epoch: u64,
    pub pinned: bool,
    pub archived: bool,
}

/// The hand-overs a member `me` has not heard answered (X73), sorted by its
/// records once the central host was heard from.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Settled {
    /// The account gives them another member: taken while the Mac slept,
    /// each with the ownership number it was handed over at, to come back.
    pub taken: Vec<(String, u64)>,
    /// Still the member's at the number they were handed over at: sent
    /// again.
    pub again: Vec<(String, u64)>,
    /// Neither, any more: dropped.
    pub dropped: Vec<String>,
}

/// Sorts `pending` and `withdrawn`, each session with the ownership number
/// it was handed over at, by what `known` says of each now (X73). A
/// withdrawn one, whose agents went on here with no answer, is never sent
/// again: taken, it comes back; else it is dropped.
pub fn settle<'a>(
    pending: &std::collections::BTreeMap<String, u64>,
    withdrawn: &std::collections::BTreeMap<String, u64>,
    known: impl Fn(&str) -> Option<Known<'a>>,
    me: &str,
) -> Settled {
    let mut out = Settled::default();
    let all = pending.iter().map(|(id, at)| (id, *at, false)).chain(withdrawn.iter().map(|(id, at)| (id, *at, true)));
    for (id, at, withdrawn) in all {
        match known(id) {
            Some(k) if !k.archived && k.owner.is_some_and(|o| o != me) => out.taken.push((id.clone(), at)),
            Some(k) if !withdrawn && !k.archived && !k.pinned && k.owner == Some(me) && k.epoch == at => out.again.push((id.clone(), at)),
            _ => out.dropped.push(id.clone()),
        }
    }
    out
}

/// Whether a session whose chats are in `states` still waits on something
/// after the daemon started again (X73): an ask open or a message queued.
/// A turn or subagent running then is one started since, the user at work
/// here.
pub fn still_waits(states: &[moonlet_proto::types::ChatState]) -> bool {
    states.iter().any(|st| st.status != "working" && (!st.pending.is_empty() || !st.queued.is_empty()))
}

/// One session a member hands the central host (X73), as the central host
/// sees it when it comes to it.
pub struct Yielded<'a> {
    /// Its record's owner, ownership number and pin.
    pub owner: Option<&'a str>,
    pub epoch: u64,
    pub pinned: Option<&'a str>,
    /// The member handing it over, and the central host.
    pub from: &'a str,
    pub here: &'a str,
    /// The ownership number the member named; none from a member from
    /// before, which named ids alone.
    pub named: Option<u64>,
    /// Move to… (pin): one kept on its member goes too.
    pub moving: bool,
    /// The member linked again or sent a newer hand-over since this one
    /// came: it is awake, and says itself what it still hands over.
    pub superseded: bool,
}

/// What the central host does with a session handed to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnYield {
    /// Takes it: continues it here.
    Take,
    /// Answers it took it: it did, at a later ownership number than the
    /// member named, by this hand-over sent before or as the member slept.
    Taken,
    /// Leaves it where it is.
    Leave,
}

/// Whether the central host takes session `y` a member hands it (X73):
/// only the member's own, at the ownership number it named, not pinned,
/// and while the member has not linked again or sent a newer hand-over
/// since. A hand-over sent again after an answer was lost answers that
/// the central host took it.
pub fn on_yield(y: &Yielded) -> OnYield {
    if y.named.is_some_and(|e| y.epoch > e) && y.owner == Some(y.here) {
        return OnYield::Taken;
    }
    let pinned_ok = y.pinned.is_none() || (y.moving && y.pinned == Some(y.from));
    if y.owner != Some(y.from) || !pinned_ok || y.named.is_some_and(|e| e != y.epoch) || y.superseded {
        return OnYield::Leave;
    }
    OnYield::Take
}

/// Listens for the Mac's sleep and wake, for the daemon's life.
pub fn spawn(daemon: Arc<Daemon>) {
    #[cfg(target_os = "macos")]
    mac::listen(daemon);
    #[cfg(not(target_os = "macos"))]
    let _ = daemon;
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::{HOLD, Power};
    use crate::daemon::Daemon;

    type IONotificationPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;
    type CFStringRef = *const c_void;
    type Callback = extern "C" fn(*mut c_void, u32, u32, *mut c_void);

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IORegisterForSystemPower(
            refcon: *mut c_void,
            port: *mut IONotificationPortRef,
            callback: Callback,
            notifier: *mut u32,
        ) -> u32;
        fn IONotificationPortGetRunLoopSource(port: IONotificationPortRef) -> CFRunLoopSourceRef;
        fn IOAllowPowerChange(kernel_port: u32, notification_id: isize) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: CFStringRef);
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: CFStringRef;
    }

    // IOKit's message numbers; its macros for them don't reach Rust.
    const CAN_SLEEP: u32 = 0xE000_0270;
    const WILL_SLEEP: u32 = 0xE000_0280;
    const HAS_POWERED_ON: u32 = 0xE000_0300;

    static ROOT: AtomicU32 = AtomicU32::new(0);

    struct Ctx {
        daemon: Arc<Daemon>,
        rt: tokio::runtime::Handle,
    }

    extern "C" fn callback(
        refcon: *mut c_void,
        _service: u32,
        message: u32,
        argument: *mut c_void,
    ) {
        // SAFETY: `refcon` is the `Ctx` leaked in `listen`, alive for good.
        let ctx = unsafe { &*(refcon as *const Ctx) };
        let id = argument as isize;
        match message {
            // Idle sleep asks first: never refused.
            CAN_SLEEP => unsafe {
                IOAllowPowerChange(ROOT.load(Ordering::SeqCst), id);
            },
            WILL_SLEEP => {
                let daemon = ctx.daemon.clone();
                // Answered once the sessions are handed over, or when the
                // hold runs out, whichever comes first.
                ctx.rt.block_on(async move {
                    let _ = tokio::time::timeout(HOLD, daemon.power(Power::Sleep)).await;
                });
                unsafe {
                    IOAllowPowerChange(ROOT.load(Ordering::SeqCst), id);
                }
            }
            HAS_POWERED_ON => {
                let daemon = ctx.daemon.clone();
                ctx.rt.spawn(async move { daemon.power(Power::Wake).await });
            }
            _ => {}
        }
    }

    pub fn listen(daemon: Arc<Daemon>) {
        let rt = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            .name("power".into())
            .spawn(move || {
                let ctx = Box::into_raw(Box::new(Ctx { daemon, rt })) as *mut c_void;
                let mut port: IONotificationPortRef = std::ptr::null_mut();
                let mut notifier: u32 = 0;
                // SAFETY: plain IOKit and CoreFoundation calls on this
                // thread's own run loop, which runs for good.
                unsafe {
                    let root = IORegisterForSystemPower(ctx, &mut port, callback, &mut notifier);
                    if root == 0 || port.is_null() {
                        tracing::warn!("cannot hear the Mac go to sleep");
                        return;
                    }
                    ROOT.store(root, Ordering::SeqCst);
                    CFRunLoopAddSource(
                        CFRunLoopGetCurrent(),
                        IONotificationPortGetRunLoopSource(port),
                        kCFRunLoopCommonModes,
                    );
                    CFRunLoopRun();
                }
            })
            .expect("a thread for the Mac's sleep and wake");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn on_waking_only_chats_of_sessions_still_this_members_and_not_taken_go_on() {
        let frozen = [
            Frozen {
                chat: 1,
                session: "fix-cart",
                owner: Some("macbook"),
                epoch: 1,
                slept_at: Some(1),
            },
            // The central host said it took this one, though the news of
            // its new owner has not arrived yet.
            Frozen {
                chat: 2,
                session: "big-refactor",
                owner: Some("macbook"),
                epoch: 1,
                slept_at: Some(1),
            },
            Frozen {
                chat: 3,
                session: "docs",
                owner: Some("studio-mini"),
                epoch: 2,
                slept_at: Some(1),
            },
            Frozen {
                chat: 4,
                session: "fix-cart",
                owner: Some("macbook"),
                epoch: 1,
                slept_at: Some(1),
            },
        ];
        let taken = ["big-refactor".to_string()].into_iter().collect();
        assert_eq!(to_thaw(&frozen, &taken, "macbook"), vec![1, 4]);
    }

    #[test]
    fn on_waking_a_chat_goes_on_only_at_the_epoch_its_session_had_as_the_mac_slept() {
        let frozen = [
            Frozen {
                chat: 1,
                session: "fix-cart",
                owner: Some("macbook"),
                epoch: 3,
                slept_at: Some(3),
            },
            // This member's again, but from a later move: the agent frozen
            // in its old turn is not the session's any more.
            Frozen {
                chat: 2,
                session: "big-refactor",
                owner: Some("macbook"),
                epoch: 5,
                slept_at: Some(3),
            },
            // Started frozen while asleep: no epoch from before to go by.
            Frozen {
                chat: 3,
                session: "docs",
                owner: Some("macbook"),
                epoch: 1,
                slept_at: None,
            },
        ];
        assert_eq!(to_thaw(&frozen, &Default::default(), "macbook"), vec![1, 3]);
        assert_eq!(to_end(&frozen, &Default::default(), "macbook"), vec![2]);
    }

    #[test]
    fn a_hand_over_not_answered_is_sent_again_while_still_this_members_at_its_epoch_and_one_taken_comes_back() {
        let pending: std::collections::BTreeMap<String, u64> = [
            ("fix-cart", 3),
            ("big-refactor", 1),
            ("docs", 2),
            ("pinned", 1),
            ("gone", 1),
            ("archived", 1),
            ("elsewhere", 4),
        ]
        .into_iter()
        .map(|(id, e)| (id.to_string(), e))
        .collect();
        let known = |id: &str| {
            let k = |owner, epoch, pinned, archived| Some(Known { owner: Some(owner), epoch, pinned, archived });
            match id {
                // Still the MacBook's, as it was handed over.
                "fix-cart" => k("macbook", 3, false, false),
                // studio-mini took it; its answer never came.
                "big-refactor" => k("studio-mini", 2, false, false),
                // The MacBook's again, from a later move.
                "docs" => k("macbook", 4, false, false),
                "pinned" => k("macbook", 1, true, false),
                "archived" => k("studio-mini", 2, false, true),
                // Given to another member meanwhile.
                "elsewhere" => k("macbook-air", 6, false, false),
                _ => None,
            }
        };
        assert_eq!(
            settle(&pending, &Default::default(), known, "macbook"),
            Settled {
                taken: vec![("big-refactor".into(), 1), ("elsewhere".into(), 4)],
                again: vec![("fix-cart".into(), 3)],
                dropped: vec!["archived".into(), "docs".into(), "gone".into(), "pinned".into()],
            }
        );
        // Withdrawn, its agents gone on here with no answer: never sent
        // again, but one studio-mini took all the same comes back.
        let withdrawn = pending.clone();
        assert_eq!(
            settle(&Default::default(), &withdrawn, known, "macbook"),
            Settled {
                taken: vec![("big-refactor".into(), 1), ("elsewhere".into(), 4)],
                again: vec![],
                dropped: vec!["archived".into(), "docs".into(), "fix-cart".into(), "gone".into(), "pinned".into()],
            }
        );
    }

    #[test]
    fn after_a_restart_a_session_is_handed_over_again_only_while_an_ask_or_a_message_still_waits() {
        let state = |v: serde_json::Value| -> moonlet_proto::types::ChatState { serde_json::from_value(v).unwrap() };
        let cut_off = state(serde_json::json!({ "status": "idle" }));
        let asking = state(serde_json::json!({
            "status": "blocked",
            "pending": [{ "id": "a1", "tool": "ExitPlanMode", "summary": "Plan", "input": {} }]
        }));
        let queued = state(serde_json::json!({ "status": "idle", "queued": [{ "id": "q1", "text": "and the tests" }] }));
        let working = state(serde_json::json!({ "status": "working" }));
        let working_with_queue = state(serde_json::json!({ "status": "working", "queued": [{ "id": "q1", "text": "and the tests" }] }));
        let cases: [(&[moonlet_proto::types::ChatState], bool); 6] = [
            (&[], false),
            (std::slice::from_ref(&cut_off), false),
            (std::slice::from_ref(&asking), true),
            (std::slice::from_ref(&queued), true),
            // Started since the restart: the user is at work here.
            (std::slice::from_ref(&working), false),
            (std::slice::from_ref(&working_with_queue), false),
        ];
        for (states, waits) in cases {
            assert_eq!(still_waits(states), waits, "{states:?}");
        }
    }

    #[test]
    fn the_central_host_takes_a_handed_over_session_only_at_the_epoch_named_while_its_member_has_not_woken() {
        let y = |owner: &'static str, epoch: u64, pinned: Option<&'static str>, named: Option<u64>, moving: bool, superseded: bool| Yielded {
            owner: Some(owner),
            epoch,
            pinned,
            from: "macbook",
            here: "studio-mini",
            named,
            moving,
            superseded,
        };
        let cases = [
            // Named at the number its record has: taken.
            (y("macbook", 3, None, Some(3), false, false), OnYield::Take),
            // A member from before names no number: taken as before.
            (y("macbook", 3, None, None, false, false), OnYield::Take),
            // Its number moved on since the member handed it over: the
            // session moved away and back meanwhile.
            (y("macbook", 5, None, Some(3), false, false), OnYield::Leave),
            // The member woke and linked again, or sent a newer hand-over.
            (y("macbook", 3, None, Some(3), false, true), OnYield::Leave),
            // Taken already, its answer lost: sent again, it says so.
            (y("studio-mini", 4, None, Some(3), false, false), OnYield::Taken),
            (y("studio-mini", 4, None, Some(3), false, true), OnYield::Taken),
            // Without a number, one the central host runs is not the
            // member's to hand over, as before.
            (y("studio-mini", 4, None, None, false, false), OnYield::Leave),
            // Another member's.
            (y("macbook-air", 3, None, Some(3), false, false), OnYield::Leave),
            (y("macbook-air", 4, None, Some(3), false, false), OnYield::Leave),
            // Kept on its member: only Move to… takes it.
            (y("macbook", 3, Some("macbook"), Some(3), false, false), OnYield::Leave),
            (y("macbook", 3, Some("macbook"), Some(3), true, false), OnYield::Take),
        ];
        for (case, then) in cases {
            assert_eq!(
                on_yield(&case),
                then,
                "{:?} at {} named {:?}, superseded {}",
                case.owner,
                case.epoch,
                case.named,
                case.superseded
            );
        }
    }

    #[test]
    fn only_a_session_at_work_or_waiting_on_something_goes_to_the_central_host_at_sleep() {
        let state = |v: serde_json::Value| -> moonlet_proto::types::ChatState { serde_json::from_value(v).unwrap() };
        let idle = state(serde_json::json!({ "status": "idle" }));
        let done = state(serde_json::json!({ "status": "done" }));
        let working = state(serde_json::json!({ "status": "working" }));
        let blocked = state(serde_json::json!({ "status": "blocked" }));
        let asking = state(serde_json::json!({
            "status": "idle",
            "pending": [{ "id": "a1", "tool": "ExitPlanMode", "summary": "Plan", "input": {} }]
        }));
        let queued = state(serde_json::json!({ "status": "done", "queued": [{ "id": "q1", "text": "and the tests" }] }));
        let subagent = state(serde_json::json!({
            "status": "done",
            "subagents": [{ "id": "t1", "tool_use_id": "toolu_1", "description": "Explore", "status": "running", "started_at": 1794576000000_u64 }]
        }));
        let subagent_done = state(serde_json::json!({
            "status": "done",
            "subagents": [{ "id": "t1", "tool_use_id": "toolu_1", "description": "Explore", "status": "done", "started_at": 1794576000000_u64 }]
        }));
        let cases: [(&[moonlet_proto::types::ChatState], bool); 10] = [
            (&[], false),
            (std::slice::from_ref(&idle), false),
            (std::slice::from_ref(&done), false),
            (std::slice::from_ref(&subagent_done), false),
            (std::slice::from_ref(&working), true),
            (std::slice::from_ref(&blocked), true),
            (std::slice::from_ref(&asking), true),
            (std::slice::from_ref(&queued), true),
            (std::slice::from_ref(&subagent), true),
            // One chat at work is enough.
            (&[done.clone(), working.clone()], true),
        ];
        for (states, goes) in cases {
            assert_eq!(hand_over_at_sleep(states), goes, "{states:?}");
        }
    }
}
