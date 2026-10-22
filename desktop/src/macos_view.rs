//! A Metal-backed sibling beneath the WKWebView, in the same Tauri window.
//! AppKit objects and all surface operations stay on the Tauri main thread.
use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::{HasDisplayHandle, HasWindowHandle};
use std::{cell::{Cell, RefCell}, ptr::NonNull};

thread_local! {
    static VIEW: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
    static WEBVIEW: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
    static FRAME_READY: Cell<bool> = const { Cell::new(false) };
    static HAS_LAYOUT: Cell<bool> = const { Cell::new(false) };
}

/// Reveal the native surface only once a real frame exists and the DOM reported
/// a size — but never via `setHidden`. A hidden `NSView` pauses the CADisplayLink
/// created from it, so hiding it before the first frame deadlocks the two gates:
/// no tick → no frame → stays hidden. Alpha keeps the link alive instead.
fn apply_visibility(view: &NSView) {
    let visible = FRAME_READY.with(Cell::get) && HAS_LAYOUT.with(Cell::get);
    view.setAlphaValue(if visible { 1.0 } else { 0.0 });
}

// The owning Tauri window keeps its view hierarchy alive. HasWindowHandle is
// only called on the main thread; no AppKit object is dereferenced elsewhere.
struct SurfaceOwner {
    window: tauri::WebviewWindow,
    view: usize,
}
impl HasWindowHandle for SurfaceOwner {
    fn window_handle(
        &self,
    ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
        let _ = &self.window;
        MainThreadMarker::new().ok_or(raw_window_handle::HandleError::Unavailable)?;
        let ptr = NonNull::new(self.view as *mut std::ffi::c_void)
            .ok_or(raw_window_handle::HandleError::Unavailable)?;
        let raw = raw_window_handle::AppKitWindowHandle::new(ptr);
        // The parent window owns this NSView for the lifetime of this wrapper.
        Ok(unsafe { raw_window_handle::WindowHandle::borrow_raw(raw.into()) })
    }
}
impl HasDisplayHandle for SurfaceOwner {
    fn display_handle(
        &self,
    ) -> Result<raw_window_handle::DisplayHandle<'_>, raw_window_handle::HandleError> {
        Ok(raw_window_handle::DisplayHandle::appkit())
    }
}

pub fn attach(window: &tauri::WebviewWindow) -> Result<bevy::window::RawHandleWrapper, String> {
    let mtm = MainThreadMarker::new().ok_or("AppKit surface requires the main thread")?;
    let parent_ptr = window.ns_view().map_err(|e| e.to_string())?;
    // Tauri owns the parent NSView. We retain our child until after Bevy disposal.
    let parent = unsafe { &*parent_ptr.cast::<NSView>() };
    let view = NSView::initWithFrame(NSView::alloc(mtm), parent.bounds());
    view.setWantsLayer(true);
    // Not `setHidden`: this view is the CADisplayLink owner, and a hidden owner
    // stops the link (see `apply_visibility`). Alpha hides it instead.
    view.setAlphaValue(0.0);
    parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, None);
    let owner = SurfaceOwner {
        window: window.clone(),
        view: Retained::as_ptr(&view) as usize,
    };
    let handle = crate::native_canvas::raw_handle_from_window(owner)?;
    VIEW.with(|slot| *slot.borrow_mut() = Some(view));
    window
        .with_webview(|platform| {
            // The DOM viewport belongs to WKWebView, not the window content view.
            // Retain it on the UI thread for AppKit's coordinate conversion.
            let webview = unsafe { Retained::retain(platform.inner().cast::<NSView>()) };
            WEBVIEW.with(|slot| *slot.borrow_mut() = webview);
        })
        .map_err(|e| e.to_string())?;
    Ok(handle)
}

pub fn layout(x: f64, y: f64, width: f64, height: f64) {
    HAS_LAYOUT.with(|visible| visible.set(width > 0.0 && height > 0.0));
    VIEW.with(|slot| {
        if let Some(view) = slot.borrow().as_ref() {
            // Called on the main thread; parent is retained by Tauri's window.
            if let Some(parent) = unsafe { view.superview() } {
                apply_visibility(view);
                // DOM has a top-left origin. AppKit's unflipped content view starts at bottom-left.
                WEBVIEW.with(|slot| {
                    let webview = slot.borrow();
                    let origin: &NSView = webview.as_deref().unwrap_or(&parent);
                    let webview_bounds = origin.bounds();
                    // macOS can extend WKWebView behind the title bar while
                    // WebKit's DOM viewport excludes it. Use the unobscured
                    // window content in the webview coordinate system.
                    let bounds = origin.window().map(|window|
                        origin.convertRect_fromView(window.contentLayoutRect(), None)
                    ).unwrap_or(webview_bounds);
                    let top = if origin.isFlipped() { bounds.origin.y + y }
                        else { bounds.origin.y + bounds.size.height - y - height };
                    let local = NSRect::new(NSPoint::new(bounds.origin.x + x, top),
                        NSSize::new(width.max(1.0), height.max(1.0)));
                    let frame = parent.convertRect_fromView(local, Some(origin));
                    view.setFrame(frame);
                    let backing = view.convertRectToBacking(view.bounds());
                    crate::metrics::layout(serde_json::json!({
                        "dom":{"x":x,"y":y,"width":width,"height":height},
                        "webview":{"width":webview_bounds.size.width,"height":webview_bounds.size.height,"flipped":origin.isFlipped()},
                        "viewport":{"x":bounds.origin.x,"y":bounds.origin.y,"width":bounds.size.width,"height":bounds.size.height},
                        "parent":{"width":parent.bounds().size.width,"height":parent.bounds().size.height},
                        "native":{"x":frame.origin.x,"y":frame.origin.y,"width":frame.size.width,"height":frame.size.height},
                        "backing":{"width":backing.size.width,"height":backing.size.height}
                    }));
                });
            }
        }
    });
}

pub fn mark_frame_ready() {
    if FRAME_READY.with(|ready| ready.replace(true)) { return; }
    VIEW.with(|slot| {
        if let Some(view) = slot.borrow().as_ref() {
            apply_visibility(view);
        }
    });
}

pub fn detach() {
    FRAME_READY.with(|ready| ready.set(false));
    HAS_LAYOUT.with(|visible| visible.set(false));
    WEBVIEW.with(|slot| *slot.borrow_mut() = None);
    VIEW.with(|slot| {
        if let Some(view) = slot.borrow_mut().take() {
            view.removeFromSuperview();
        }
    });
}

pub fn start_frame_clock(callback: Box<dyn Fn()>) -> bool {
    VIEW.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|view| crate::macos_frame_clock::start(view, callback))
    })
}
