//! Owner-thread clipboard output for native editor UI. WebView async clipboard
//! permissions must not lose an egui copy that is delivered after the key event.
pub fn write_text(text: &str) -> Result<(), String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("clipboard text exceeds budget".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        let _main = objc2::MainThreadMarker::new().ok_or("clipboard requires owner thread")?;
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        // Apple's immutable, process-lifetime type identifier.
        if board.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
            Ok(())
        } else {
            Err("clipboard write failed".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Err("native text clipboard unavailable on this platform".into())
    }
}
