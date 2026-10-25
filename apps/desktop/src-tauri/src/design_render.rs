//! The hidden render window (X64, ADR 0013): the render check and `design
//! snap` need the app's own WebKit. The local daemon sends `design.render`
//! to this app alone (it said `design.render.ready` on connecting); the
//! window `design-render`, created hidden on first use and never shown,
//! loads the app's render page (`render.html`), which frames the card in a
//! sandboxed iframe, judges what the card measured of itself, and hands the
//! verdict back here. For a screenshot, the window's WKWebView is snapped
//! with `takeSnapshot`, as the spike did (branch `spike/design-snapshot`).
//! The answer goes back to the daemon as `design.render.done`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use moonlet_proto::RpcError;
use moonlet_proto::methods::{DESIGN_RENDER_DONE, DESIGN_RENDER_READY, DesignRender, RenderWant};
use serde_json::{Value, json};
use tauri::{AppHandle, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{oneshot, watch};

/// The hidden window's label.
pub const LABEL: &str = "design-render";

/// How long the render page has to answer for one card; it gives up on a
/// card itself after 15 s.
const PAGE_ANSWER: Duration = Duration::from_secs(20);

/// The card painted, from its frame's post until the snapshot.
const PAINT: Duration = Duration::from_millis(300);

/// The render page's verdict on a card.
#[derive(Debug)]
struct Measured {
    metrics: Option<Value>,
    error: Option<String>,
}

pub struct Renderer {
    /// One card at a time: the window shows one.
    turn: tokio::sync::Mutex<()>,
    /// The page's verdict on the card it renders, by job id.
    waiting: Mutex<HashMap<u64, oneshot::Sender<Measured>>>,
    /// True once the render page says it is ready for cards; false again
    /// while it loads.
    /// (`send_replace`, so it holds without anyone waiting.)
    page_ready: watch::Sender<bool>,
}

impl Default for Renderer {
    fn default() -> Self {
        Renderer {
            turn: Default::default(),
            waiting: Default::default(),
            page_ready: watch::Sender::new(false),
        }
    }
}

/// Tells the local daemon that this app renders its design cards.
pub fn announce(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // The host manager is put in place in setup, maybe after the local
        // daemon connected.
        for _ in 0..50 {
            if let Some(hosts) = app.try_state::<Arc<crate::hosts::HostManager>>() {
                if let Ok(local) = hosts.get(crate::hosts::LOCAL)
                    && let Err(e) = local.request(DESIGN_RENDER_READY, json!({})).await
                {
                    tracing::warn!("the daemon does not take design renders: {}", e.message);
                }
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
}

/// Renders the card the local daemon asked for, and answers it.
pub fn handle(app: &AppHandle, data: Value) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ask: DesignRender = match serde_json::from_value(data) {
            Ok(a) => a,
            Err(e) => return tracing::warn!("a design.render the app cannot read: {e}"),
        };
        let id = ask.id;
        let done = match render(&app, ask).await {
            Ok(done) => done,
            Err(e) => json!({"id": id, "error": e}),
        };
        let Some(hosts) = app.try_state::<Arc<crate::hosts::HostManager>>() else {
            return;
        };
        if let Ok(local) = hosts.get(crate::hosts::LOCAL)
            && let Err(e) = local.request(DESIGN_RENDER_DONE, done).await
        {
            tracing::warn!("the daemon did not take a design render: {}", e.message);
        }
    });
}

async fn render(app: &AppHandle, ask: DesignRender) -> Result<Value, String> {
    let renderer = app.state::<Arc<Renderer>>().inner().clone();
    let _turn = renderer.turn.lock().await;
    let window = window(app, &renderer)?;
    let mut ready = renderer.page_ready.subscribe();
    tokio::time::timeout(PAGE_ANSWER, ready.wait_for(|r| *r))
        .await
        .map_err(|_| "the render page did not load".to_string())?
        .map_err(|_| "the render page went away".to_string())?;
    let (w, h) = ask.viewport;
    window
        .set_size(LogicalSize::new(f64::from(w), f64::from(h)))
        .map_err(|e| e.to_string())?;
    let (tx, rx) = oneshot::channel();
    renderer.waiting.lock().unwrap().insert(ask.id, tx);
    let job = json!({
        "id": ask.id,
        "workspace": ask.workspace,
        "slug": ask.slug,
        "path": ask.path,
        "viewport": [w, h],
        "variant": ask.variant,
    });
    if let Err(e) = window.eval(format!("window.moonletRender({job})")) {
        renderer.waiting.lock().unwrap().remove(&ask.id);
        return Err(e.to_string());
    }
    let measured = match tokio::time::timeout(PAGE_ANSWER, rx).await {
        Ok(Ok(m)) => m,
        _ => {
            renderer.waiting.lock().unwrap().remove(&ask.id);
            return Err("the render page did not answer".into());
        }
    };
    if ask.want == RenderWant::Metrics {
        return Ok(json!({"id": ask.id, "metrics": measured.metrics, "error": measured.error}));
    }
    if let Some(e) = measured.error {
        return Err(e);
    }
    tokio::time::sleep(PAINT).await;
    let png = snapshot(&window, w).await?;
    use base64::Engine;
    Ok(json!({
        "id": ask.id,
        "png_base64": base64::engine::general_purpose::STANDARD.encode(png),
    }))
}

/// The hidden render window, created on first use and kept.
fn window(app: &AppHandle, renderer: &Arc<Renderer>) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    renderer.page_ready.send_replace(false);
    let r = renderer.clone();
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("render.html".into()))
        .title("moonlet render")
        .inner_size(900.0, 700.0)
        // Never shown, never focused, nowhere in the Dock's window list.
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .resizable(false)
        // The page says when it is ready (`design_render_page_ready`): a
        // finished load can come before its script has run.
        .on_page_load(move |_, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Started) {
                r.page_ready.send_replace(false);
            }
        })
        .build()
        .map_err(|e| format!("cannot open the render window: {e}"))
}

/// Whether a call comes from the app's own render page: the window
/// [`LABEL`], showing `render.html` from the app's bundle (`tauri://localhost`,
/// or `http://tauri.localhost`), or from `dev_url` while developing.
pub fn is_render_page(label: &str, url: &str, dev_url: Option<&str>) -> bool {
    // `scheme://host[:port]`, written out: a custom scheme's origin is opaque.
    let origin = |u: &tauri::Url| {
        let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
        format!(
            "{}://{}{port}",
            u.scheme(),
            u.host_str().unwrap_or_default()
        )
    };
    let Ok(page) = tauri::Url::parse(url) else {
        return false;
    };
    let from_app = ["tauri://localhost", "http://tauri.localhost"]
        .contains(&origin(&page).as_str())
        || dev_url
            .and_then(|d| tauri::Url::parse(d).ok())
            .is_some_and(|d| origin(&d) == origin(&page));
    label == LABEL
        && from_app
        && page.path() == "/render.html"
        && page.query().is_none()
        && page.fragment().is_none()
}

/// Refuses a call that does not come from the app's render page.
fn from_render_page(window: &WebviewWindow) -> Result<(), RpcError> {
    let url = window.url().map(|u| u.to_string()).unwrap_or_default();
    // A dev server serves the page only in a development build.
    let dev = tauri::is_dev()
        .then(|| {
            window
                .config()
                .build
                .dev_url
                .as_ref()
                .map(|u| u.to_string())
        })
        .flatten();
    if is_render_page(window.label(), &url, dev.as_deref()) {
        Ok(())
    } else {
        Err(RpcError::new(
            "forbidden",
            "only the app's render page renders cards",
        ))
    }
}

/// The render page is ready for cards. Only that page may say so.
#[tauri::command]
pub fn design_render_page_ready(
    window: WebviewWindow,
    renderer: tauri::State<'_, Arc<Renderer>>,
) -> Result<(), RpcError> {
    from_render_page(&window)?;
    renderer.page_ready.send_replace(true);
    Ok(())
}

/// The render page's verdict on job `id`. Only that page may give it.
#[tauri::command]
pub fn design_render_measured(
    window: WebviewWindow,
    renderer: tauri::State<'_, Arc<Renderer>>,
    id: u64,
    metrics: Option<Value>,
    error: Option<String>,
) -> Result<(), RpcError> {
    from_render_page(&window)?;
    if let Some(tx) = renderer.waiting.lock().unwrap().remove(&id) {
        let _ = tx.send(Measured { metrics, error });
    }
    Ok(())
}

/// A PNG of what the window's WKWebView shows, `width` points wide, at 1×.
#[cfg(target_os = "macos")]
async fn snapshot(window: &WebviewWindow, width: u32) -> Result<Vec<u8>, String> {
    let (tx, rx) = oneshot::channel();
    window
        .with_webview(move |webview| {
            // SAFETY: `inner` is the window's live WKWebView, and this runs
            // on the main thread.
            unsafe { snap::take(webview.inner(), f64::from(width), tx) }
        })
        .map_err(|e| e.to_string())?;
    tokio::time::timeout(PAGE_ANSWER, rx)
        .await
        .map_err(|_| "the snapshot did not come".to_string())?
        .map_err(|_| "the snapshot did not come".to_string())?
}

#[cfg(not(target_os = "macos"))]
async fn snapshot(_window: &WebviewWindow, _width: u32) -> Result<Vec<u8>, String> {
    Err("snapshots of cards need macOS".into())
}

#[cfg(target_os = "macos")]
mod snap {
    use std::cell::RefCell;
    use std::ffi::{CStr, c_char, c_void};

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use tokio::sync::oneshot;

    /// Asks `view` (a WKWebView) for a snapshot of what it shows, `width`
    /// points wide, one pixel a point as design-sync's captures (a Retina
    /// window would give two); the PNG, or why there is none, goes to `done`.
    ///
    /// # Safety
    /// `view` is a live WKWebView, and this runs on the main thread.
    pub unsafe fn take(
        view: *mut c_void,
        width: f64,
        done: oneshot::Sender<Result<Vec<u8>, String>>,
    ) {
        // SAFETY: the caller's contract.
        let view = unsafe { &*(view as *mut AnyObject) };
        let done = RefCell::new(Some(done));
        let block = RcBlock::new(move |image: *mut AnyObject, error: *mut AnyObject| {
            let result = if image.is_null() {
                // SAFETY: WebKit passes an NSError when there is no image.
                Err(unsafe { describe(error) })
            } else {
                // SAFETY: WebKit passes an NSImage.
                unsafe { png(image) }
            };
            if let Some(tx) = done.borrow_mut().take() {
                let _ = tx.send(result);
            }
        });
        // SAFETY: -[WKWebView takeSnapshotWithConfiguration:completionHandler:]
        // with a WKSnapshotConfiguration whose snapshotWidth (in points)
        // makes the image as many pixels wide as the page is points: the
        // window's backing scale divided out.
        unsafe {
            let window: *mut AnyObject = msg_send![view, window];
            let scale: f64 = if window.is_null() {
                1.0
            } else {
                msg_send![window, backingScaleFactor]
            };
            let scale = if scale > 0.0 { scale } else { 1.0 };
            let config: Retained<AnyObject> = msg_send![class!(WKSnapshotConfiguration), new];
            let points: *mut AnyObject =
                msg_send![class!(NSNumber), numberWithDouble: width / scale];
            let _: () = msg_send![&*config, setSnapshotWidth: points];
            let _: () = msg_send![view, takeSnapshotWithConfiguration: &*config, completionHandler: &*block];
        }
    }

    /// The `localizedDescription` of an NSError.
    unsafe fn describe(error: *mut AnyObject) -> String {
        if error.is_null() {
            return "WebKit took no snapshot".into();
        }
        // SAFETY: `error` is an NSError; its description an NSString.
        unsafe {
            let d: *mut AnyObject = msg_send![error, localizedDescription];
            if d.is_null() {
                return "WebKit took no snapshot".into();
            }
            let c: *const c_char = msg_send![d, UTF8String];
            format!(
                "WebKit took no snapshot: {}",
                CStr::from_ptr(c).to_string_lossy()
            )
        }
    }

    /// An NSImage as PNG bytes.
    unsafe fn png(image: *mut AnyObject) -> Result<Vec<u8>, String> {
        // SAFETY: AppKit calls on an NSImage and the objects it returns,
        // each checked for nil before use.
        unsafe {
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                return Err("the snapshot has no bitmap".into());
            }
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            if rep.is_null() {
                return Err("the snapshot has no bitmap".into());
            }
            let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            // NSBitmapImageFileTypePNG = 4
            let data: *mut AnyObject =
                msg_send![rep, representationUsingType: 4usize, properties: props];
            if data.is_null() {
                return Err("the snapshot could not be made a PNG".into());
            }
            let bytes: *const u8 = msg_send![data, bytes];
            let len: usize = msg_send![data, length];
            Ok(std::slice::from_raw_parts(bytes, len).to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_render_window_showing_the_apps_render_page_may_answer() {
        assert!(is_render_page(LABEL, "tauri://localhost/render.html", None));
        assert!(is_render_page(
            LABEL,
            "http://tauri.localhost/render.html",
            None
        ));
        assert!(is_render_page(
            LABEL,
            "http://localhost:1420/render.html",
            Some("http://localhost:1420/")
        ));
        for (label, url, dev) in [
            // The main window, even on the render page.
            ("main", "tauri://localhost/render.html", None),
            // The render window gone somewhere else.
            (LABEL, "tauri://localhost/index.html", None),
            (LABEL, "tauri://localhost/render.html?x=1", None),
            (LABEL, "tauri://evil/render.html", None),
            (LABEL, "moonlet-design://w1/systems/s/render.html", None),
            (LABEL, "https://example.com/render.html", None),
            // A dev server only while developing.
            (LABEL, "http://localhost:1420/render.html", None),
            (
                LABEL,
                "http://localhost:1421/render.html",
                Some("http://localhost:1420/"),
            ),
        ] {
            assert!(!is_render_page(label, url, dev), "{label} {url} {dev:?}");
        }
    }
}
