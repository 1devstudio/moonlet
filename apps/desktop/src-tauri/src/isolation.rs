//! WebKit site isolation for the app's main window (X64). Design cards are
//! untrusted HTML framed in the window, each on a host of its own
//! (`moonlet-design://<card key>.<workspace>`); with site isolation each of
//! those hosts gets its own web process, so a card that never stops running
//! blocks only itself, never the window or the other cards.
//!
//! The switch is WebKit's private, unstable `SiteIsolationEnabled` feature:
//! `+[WKPreferences _features]` lists them, `-[WKPreferences
//! _setEnabled:forFeature:]` turns one on. It must be on the configuration
//! the webview is made with: turned on after a load, frames never load. A
//! WebKit without it (a later macOS may rename or drop it) gets no
//! configuration, and the window is made as before.

use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::{msg_send, sel};
use objc2_foundation::{NSArray, NSString};
use objc2_web_kit::WKWebViewConfiguration;

/// The private feature's key.
const FEATURE: &str = "SiteIsolationEnabled";

/// A webview configuration with site isolation on, or why there is none.
pub fn configuration() -> Result<Retained<WKWebViewConfiguration>, &'static str> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let class = AnyClass::get(c"WKPreferences").ok_or("no WKPreferences")?;
    // SAFETY: plain Objective-C calls; each private selector is checked for
    // first, so a WebKit without it is never sent it.
    unsafe {
        let listed: bool = msg_send![class, respondsToSelector: sel!(_features)];
        if !listed {
            return Err("WebKit lists no features");
        }
        let features: Option<Retained<NSArray<AnyObject>>> = msg_send![class, _features];
        let feature = features
            .into_iter()
            .flat_map(|all| all.to_vec())
            .find(|f| {
                let key: Option<Retained<NSString>> = msg_send![&**f, key];
                key.is_some_and(|k| k.to_string() == FEATURE)
            })
            .ok_or("WebKit has no SiteIsolationEnabled feature")?;
        let config = WKWebViewConfiguration::new(mtm);
        let prefs = config.preferences();
        let settable: bool = msg_send![&*prefs, respondsToSelector: sel!(_setEnabled:forFeature:)];
        if !settable {
            return Err("WebKit cannot turn a feature on");
        }
        let _: () = msg_send![&*prefs, _setEnabled: Bool::YES, forFeature: &*feature];
        Ok(config)
    }
}
