//! External-canvas seam tests, on a real egui frame.
//!
//! `overlay::tests` covers the data path. These check the parts that only a frame can show: that
//! a takeover makes the document area draw the host's picture, that `clear` gives it back, that
//! `report` publishes the rectangle the app drew into, and that a push from outside wakes the loop.

use crate::overlay::{self, Frame};

fn frame_ready() -> egui::Context {
    let ctx = egui::Context::default();
    // One warm-up pass so fonts and the first texture uploads are settled.
    let mut out = ctx.run_ui(Default::default(), |_| {});
    out.textures_delta.clear();
    ctx
}

/// Run one frame with `ui_fn`, returning the output with its texture deltas consumed (a real
/// runner uploads them; a test that drops them trips epaint's debug assertion).
fn run_frame(ctx: &egui::Context, ui_fn: impl FnMut(&mut egui::Ui)) -> egui::FullOutput {
    let mut out = ctx.run_ui(Default::default(), ui_fn);
    out.textures_delta.clear();
    out
}

#[test]
fn a_pushed_frame_paints() {
    let ctx = frame_ready();
    overlay::clear();
    let area = egui::Rect::from_min_size(egui::pos2(10.0, 20.0), egui::vec2(300.0, 200.0));

    overlay::set_image(Frame::solid(8, 8, [191, 75, 40, 255]));
    let out = run_frame(&ctx, |ui| {
        let painter = ui.painter_at(area);
        assert!(overlay::paint(ui.ctx(), &painter, area, area), "a takeover handles the area");
    });
    assert!(!out.shapes.is_empty(), "something was painted");
    overlay::clear();
}

#[test]
fn clearing_gives_the_area_back() {
    let ctx = frame_ready();
    overlay::set_image(Frame::solid(4, 4, [1, 2, 3, 255]));
    let area = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(50.0, 50.0));
    run_frame(&ctx, |ui| {
        let painter = ui.painter_at(area);
        assert!(overlay::paint(ui.ctx(), &painter, area, area));
    });
    overlay::clear();
    run_frame(&ctx, |ui| {
        let painter = ui.painter_at(area);
        assert!(!overlay::paint(ui.ctx(), &painter, area, area), "no takeover, nothing painted");
    });
    assert!(!overlay::is_active());
}

#[test]
fn transparent_mode_handles_the_area_without_a_texture() {
    let ctx = frame_ready();
    overlay::set_transparent();
    let area = egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(80.0, 60.0));
    run_frame(&ctx, |ui| {
        let painter = ui.painter_at(area);
        // Handled: the caller skips the document composite. Nothing is drawn by the seam itself.
        assert!(overlay::paint(ui.ctx(), &painter, area, area));
    });
    assert!(overlay::is_transparent());
    overlay::clear();
}

#[test]
fn the_area_is_reported_before_any_takeover() {
    // A host that covers the rectangle needs it *before* asking, so `report` must not depend on a
    // takeover being live.
    overlay::clear();
    let ctx = egui::Context::default();
    let area = egui::Rect::from_min_size(egui::pos2(5.0, 7.0), egui::vec2(120.0, 90.0));
    overlay::report(&ctx, area);
    assert_eq!(overlay::last_rect(), Some([5.0, 7.0, 120.0, 90.0]));
    assert!(!overlay::is_active());
}


#[test]
fn capture_clean_keeps_document_ownership_and_transparent_clear() {
    use eframe::App;
    overlay::clear();
    overlay::set_transparent();
    overlay::set_capture_clean(true);
    assert!(!overlay::is_active(), "capture must not replace the document composite");
    let app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
    assert_eq!(app.clear_color(&Default::default()), [0.0; 4]);
    overlay::set_capture_clean(false);
    assert!(app.clear_color(&Default::default())[3] > 0.0);
}

#[test]
fn state_fit_and_export_requests_use_the_active_document_without_advancing_revision() {
    overlay::clear();
    let ctx = egui::Context::default();
    let mut session = photocraft_engine::Session::new();
    session.execute("file.new", serde_json::json!({"width": 8, "height": 6})).unwrap();
    let mut app = crate::PhotocraftApp::new(session, Default::default());
    app.sync_views();
    app.ui.views[0].fit_pending = false;
    let revision = app.session.active().unwrap().revision;
    overlay::request_fit();
    overlay::request_export(1); // preview limit must not downsample the exported source.
    overlay::tick(&mut app, &ctx);
    assert!(app.ui.views[0].fit_pending);
    let bytes = overlay::take_export().unwrap();
    assert_eq!(&bytes[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), 8);
    assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), 6);
    assert!(overlay::take_export().is_none(), "export is consumed once");
    assert!(overlay::export_error().is_none());
    assert_eq!(app.session.active().unwrap().revision, revision);
    overlay::report(&ctx, egui::Rect::from_min_size(egui::pos2(5.0, 6.0), egui::vec2(120.0, 90.0)));
    overlay::publish(&app, &ctx);
    let state: serde_json::Value = serde_json::from_str(&overlay::state()).unwrap();
    assert_eq!(state["docWidth"], 8);
    assert_eq!(state["docHeight"], 6);
    assert_eq!(state["rect"], serde_json::json!([5.0, 6.0, 120.0, 90.0]));
    assert_eq!(state["escOwned"], false);
    app.ui.crop_rect = Some([0.0, 0.0, 4.0, 3.0]);
    overlay::publish(&app, &ctx);
    let state: serde_json::Value = serde_json::from_str(&overlay::state()).unwrap();
    assert_eq!(state["escOwned"], true);
    assert_eq!(state["operation"], true);
}

#[test]
fn closing_the_last_document_clears_rect_and_export_failure_is_recoverable() {
    overlay::clear();
    let ctx = egui::Context::default();
    let mut app = crate::PhotocraftApp::new(photocraft_engine::Session::new(), Default::default());
    overlay::report(&ctx, egui::Rect::from_min_size(egui::Pos2::ZERO, egui::vec2(100.0, 100.0)));
    overlay::publish(&app, &ctx);
    let state: serde_json::Value = serde_json::from_str(&overlay::state()).unwrap();
    assert!(state["documentId"].is_null());
    assert!(state["rect"].is_null());
    overlay::request_export(0);
    overlay::tick(&mut app, &ctx);
    assert!(overlay::export_error().is_some());
    app.session.execute("file.new", serde_json::json!({"width": 2, "height": 2})).unwrap();
    overlay::request_export(0);
    overlay::tick(&mut app, &ctx);
    assert!(overlay::export_error().is_none());
    assert!(overlay::take_export().is_some());
}

#[test]
fn published_document_camera_changes_when_the_viewport_rectangle_does_not() {
    overlay::clear();
    let ctx = egui::Context::default();
    let mut session = photocraft_engine::Session::new();
    session.execute("file.new", serde_json::json!({"width": 40, "height": 30})).unwrap();
    let mut app = crate::PhotocraftApp::new(session, Default::default());
    app.sync_views();
    let rect = egui::Rect::from_min_size(egui::pos2(5.0, 6.0), egui::vec2(400.0, 300.0));
    app.last_canvas_rect = rect;
    app.ui.views[0].fit_pending = false;
    app.ui.views[0].center = [20.0, 15.0];
    app.ui.views[0].zoom = 2.0 * app.canvas_ppp();
    overlay::report(&ctx, rect);
    overlay::publish(&app, &ctx);
    let before: serde_json::Value = serde_json::from_str(&overlay::state()).unwrap();
    app.ui.views[0].center[0] += 10.0;
    app.ui.views[0].zoom *= 2.0;
    overlay::publish(&app, &ctx);
    let after: serde_json::Value = serde_json::from_str(&overlay::state()).unwrap();
    assert_eq!(before["rect"], after["rect"]);
    assert_eq!(after["documentView"]["width"], 40);
    assert_eq!(after["documentView"]["height"], 30);
    assert_eq!(after["documentView"]["zoom"].as_f64().unwrap(), before["documentView"]["zoom"].as_f64().unwrap() * 2.0);
    assert!(after["documentView"]["x"].as_f64().unwrap() < before["documentView"]["x"].as_f64().unwrap());
    assert_eq!(after["viewReady"], true);
    app.ui.views[0].fit_pending = true;
    overlay::publish(&app, &ctx);
    let waiting: serde_json::Value = serde_json::from_str(&overlay::state()).unwrap();
    assert_eq!(waiting["viewReady"], false);
}
