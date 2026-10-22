//! The webview's own right-click menu (Back, Forward, Reload, Open Frame in
//! New Window). The app cancels it in JS (`lib/nativeMenu.ts`), but the
//! Markdown preview is a sandboxed frame that runs no scripts, so on macOS the
//! menu is also emptied as AppKit opens it. An empty menu never shows.

use tauri::{Runtime, WebviewWindow};

pub fn hide<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    // SAFETY: `inner` is the window's live WKWebView.
    if let Err(e) = window.with_webview(|w| unsafe { mac::empty_menus(w.inner()) }) {
        tracing::warn!("cannot hide the webview's own menu: {e}");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel};

    type WillOpenMenu = unsafe extern "C-unwind" fn(&AnyObject, Sel, &AnyObject, &AnyObject);

    /// Adds `willOpenMenu:withEvent:` to the webview's class (wry's own
    /// WKWebView subclass, which leaves it to WKWebView).
    ///
    /// # Safety
    /// `view` is null or a live WKWebView.
    pub unsafe fn empty_menus(view: *mut c_void) {
        // SAFETY: the caller's contract.
        let Some(view) = (unsafe { view.cast::<AnyObject>().as_ref() }) else {
            return;
        };
        let class = view.class() as *const AnyClass as *mut AnyClass;
        // SAFETY: `will_open_menu` matches `-(void)willOpenMenu:(NSMenu *)menu
        // withEvent:(NSEvent *)event`, whose type encoding is "v@:@@".
        unsafe {
            let imp = std::mem::transmute::<WillOpenMenu, Imp>(will_open_menu);
            class_addMethod(class, sel!(willOpenMenu:withEvent:), imp, c"v@:@@".as_ptr());
        }
    }

    unsafe extern "C-unwind" fn will_open_menu(this: &AnyObject, _: Sel, menu: &AnyObject, event: &AnyObject) {
        let Some(webkit) = AnyClass::get(c"WKWebView") else {
            return;
        };
        // SAFETY: `this` is a WKWebView and `menu` an NSMenu, as AppKit calls this.
        unsafe {
            let _: () = msg_send![super(this, webkit), willOpenMenu: menu, withEvent: event];
            let _: () = msg_send![menu, removeAllItems];
        }
    }
}
