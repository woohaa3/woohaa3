//! Minimal host fixture for the host-neutral embedding contract.
//! A real application supplies `NativeCanvasOptions::parent` from its child
//! HWND/NSView/X11 handle and a packaged manifest before calling `attach`.
fn main() {
    use woohaa_desktop_host::{EmbeddingBounds, EmbeddingOptions, NativeCanvasRuntime};
    let mut canvas = NativeCanvasRuntime::attach(EmbeddingOptions {
        logical_size: EmbeddingBounds { x: 0.0, y: 0.0, width: 640.0, height: 360.0 },
        ..Default::default()
    }).expect("contract validation");
    canvas.set_bounds(EmbeddingBounds { x: 0.0, y: 0.0, width: 800.0, height: 450.0 }, 1.0).unwrap();
    canvas.set_visible(false).unwrap();
    canvas.set_visible(true).unwrap();
    let _ = canvas.tick();
    canvas.dispose(0).unwrap();
}
