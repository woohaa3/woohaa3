//! A view-bound display link: follows the window's display instead of sleep(16).
//! Callbacks, AppKit objects and Bevy updates all remain on the main thread.
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, sel,
};
use objc2_app_kit::NSView;
use objc2_foundation::{NSObject, NSObjectProtocol, NSRunLoop, NSRunLoopCommonModes};
use objc2_quartz_core::CADisplayLink;
use std::{
    cell::{Cell, RefCell},
    time::Instant,
};

struct TickIvars {
    callback: Box<dyn Fn()>,
    previous: Cell<Option<Instant>>,
}
define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = TickIvars]
    struct TickTarget;
    unsafe impl NSObjectProtocol for TickTarget {}
    impl TickTarget {
        #[unsafe(method(tick:))]
        fn tick(&self, _link: &CADisplayLink) {
            let now = Instant::now();
            if let Some(previous) = self.ivars().previous.replace(Some(now)) {
                crate::metrics::sample("display_link.interval_ms", now.duration_since(previous));
            }
            (self.ivars().callback)();
        }
    }
);
thread_local! { static CLOCK: RefCell<Option<(Retained<TickTarget>, Retained<CADisplayLink>)>> = const { RefCell::new(None) }; }

pub fn start(view: &NSView, callback: Box<dyn Fn()>) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    if !view.respondsToSelector(sel!(displayLinkWithTarget:selector:)) {
        return false;
    }
    let allocated = TickTarget::alloc(mtm).set_ivars(TickIvars {
        callback,
        previous: Cell::new(None),
    });
    // NSObject init and the one-argument selector match the declarations above.
    let target: Retained<TickTarget> = unsafe { msg_send![super(allocated), init] };
    let link = unsafe { view.displayLinkWithTarget_selector(&target, sel!(tick:)) };
    // Common modes keep the renderer ticking during window tracking/resize.
    unsafe {
        link.addToRunLoop_forMode(&NSRunLoop::mainRunLoop(), NSRunLoopCommonModes);
    }
    CLOCK.with(|slot| *slot.borrow_mut() = Some((target, link)));
    crate::diagnostics::stderr(format_args!("[native-frame-clock] NSView display link enabled"));
    true
}
pub fn stop() {
    CLOCK.with(|slot| {
        if let Some((_target, link)) = slot.borrow_mut().take() {
            link.invalidate();
        }
    });
}
