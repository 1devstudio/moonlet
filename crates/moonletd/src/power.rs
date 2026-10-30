//! When the Mac goes to sleep and wakes (X73). macOS tells a process in
//! the user's session before every system sleep, and waits up to 30 s for
//! its answer; the daemon hands its sessions to the central host in that
//! time, then lets the Mac sleep.

use std::sync::Arc;
use std::time::Duration;

use crate::daemon::Daemon;

/// How long the daemon holds sleep at most: inside macOS's 30 s.
pub const HOLD: Duration = Duration::from_secs(25);

/// What the Mac is about to do, or did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Power {
    Sleep,
    Wake,
}

/// A chat frozen as the Mac went to sleep: its session, and that
/// session's owner as this member knows it at wake.
pub struct Frozen<'a> {
    pub chat: moonlet_proto::TerminalId,
    pub session: &'a str,
    pub owner: Option<&'a str>,
}

/// The frozen chats that go on at wake (X73): those of a session this
/// member `me` still owns and that the central host did not answer it took
/// (`taken`), even when the news of its new owner has not arrived yet. The
/// rest stay stopped until the member lets go of their session.
pub fn to_thaw(
    frozen: &[Frozen],
    taken: &std::collections::HashSet<String>,
    me: &str,
) -> Vec<moonlet_proto::TerminalId> {
    frozen
        .iter()
        .filter(|f| f.owner == Some(me) && !taken.contains(f.session))
        .map(|f| f.chat)
        .collect()
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
            },
            // The central host said it took this one, though the news of
            // its new owner has not arrived yet.
            Frozen {
                chat: 2,
                session: "big-refactor",
                owner: Some("macbook"),
            },
            Frozen {
                chat: 3,
                session: "docs",
                owner: Some("studio-mini"),
            },
            Frozen {
                chat: 4,
                session: "fix-cart",
                owner: Some("macbook"),
            },
        ];
        let taken = ["big-refactor".to_string()].into_iter().collect();
        assert_eq!(to_thaw(&frozen, &taken, "macbook"), vec![1, 4]);
    }
}
