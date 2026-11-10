//! External canvas takeover: let something outside PhotoCraft draw the document area.
//!
//! The document canvas is drawn in exactly one place ([`crate::canvas::canvas_view`]). This
//! module is the seam that lets a host — another renderer in the same page, an offscreen
//! producer, a `<canvas>` or `<video>` element — supply the picture for that rectangle instead
//! of the document's own composite.
//!
//! Two ways in, both optional and off by default:
//!
//! * [`set_source`] with [`Source::Image`]: the host pushes RGBA pixels. The outer layer copies
//!   them into an egui texture and draws it through the canvas's own [`ViewXform`], so pan, zoom,
//!   rotation and flip all follow PhotoCraft's camera for free.
//! * [`Source::Transparent`]: the app draws nothing in the document area — no composite, no
//!   pasteboard, no dots — and the host covers that rectangle with its own element. The host
//!   element goes *on top* of the app's canvas (not underneath): a browser canvas surface is
//!   opaque, so the picture has to be composited above it. [`last_rect`] is where to put it.
//!
//! The seam is deliberately data-only: no UI, no engine types, no ownership of the app. A host
//! that wants nothing to do with it never calls in, and nothing changes.
//!
//! Underneath, pushed pixels go through egui as an ordinary texture, not a wgpu paint callback:
//! that keeps them working on the CPU canvas path, on WebGL2 and on WebGPU alike.

use std::sync::{Arc, Mutex, PoisonError};

use egui::{Color32, ColorImage, Painter, Pos2, Rect, TextureHandle, TextureOptions};

/// What the host wants the document rectangle to show.
#[derive(Clone, Debug, Default)]
pub enum Source {
    /// Nothing: PhotoCraft draws the document as usual.
    #[default]
    Off,
    /// The host paints this area itself, above the app's canvas (a browser canvas surface is
    /// opaque, so the app leaves the rectangle empty and the host covers it).
    Transparent,
    /// These pixels, drawn in place of the document composite.
    Image(Arc<Frame>),
}

/// One RGBA8 frame, top row first, already in display space (gamma-encoded, straight alpha).
#[derive(Clone, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// `width * height * 4` bytes.
    pub rgba: Vec<u8>,
    /// Drawn into the document rectangle: `true` fills the whole canvas view; `false` keeps the
    /// document's own aspect ratio, centred, so a fixed-size frame does not stretch on zoom.
    pub fill: bool,
}

impl Frame {
    /// Solid-colour frame — enough to see the seam working end to end.
    pub fn solid(width: u32, height: u32, color: [u8; 4]) -> Self {
        let mut rgba = Vec::with_capacity((width * height * 4) as usize);
        for _ in 0..width * height {
            rgba.extend_from_slice(&color);
        }
        Self { width, height, rgba, fill: true }
    }

    fn to_color_image(&self) -> ColorImage {
        let mut pixels = Vec::with_capacity((self.width * self.height) as usize);
        for px in self.rgba.chunks_exact(4) {
            pixels.push(Color32::from_rgba_unmultiplied(px[0], px[1], px[2], px[3]));
        }
        ColorImage { size: [self.width as usize, self.height as usize], pixels, source_size: egui::Vec2::new(self.width as f32, self.height as f32) }
    }
}

/// Host-owned state, kept out of the app so the seam stays a plain function call.
#[derive(Default)]
struct Seam {
    source: Source,
    capture_clean: bool,
    fit_requested: bool,
    export_requested: bool,
    export: Option<Vec<u8>>,
    export_error: Option<String>,
    state: String,
    /// Bumped by the host; the app re-uploads the texture when it changes.
    revision: u64,
    uploaded: u64,
    texture: Option<TextureHandle>,
    /// What the last frame reported, for hosts that poll.
    last_rect: Option<[f32; 4]>,
    /// Set by the host to have the app ask for repaints while a takeover is live.
    wants_repaint: bool,
    /// The egui context, captured on the first painted frame. A host pushing frames from outside
    /// needs a repaint *now*, and an idle app is otherwise never asked to draw again — asking from
    /// inside the paint path alone would wait for a frame that never comes.
    ctx: Option<egui::Context>,
}

static SEAM: Mutex<Option<Seam>> = Mutex::new(None);

fn with_seam<R>(f: impl FnOnce(&mut Seam) -> R) -> R {
    let mut guard = SEAM.lock().unwrap_or_else(PoisonError::into_inner);
    f(guard.get_or_insert_with(Seam::default))
}

/// Wake the app so the next frame shows what the host just set.
fn wake() {
    let ctx = with_seam(|seam| seam.ctx.clone());
    if let Some(ctx) = ctx {
        ctx.request_repaint();
    }
}

/// Remember the egui context on every frame, including frames that draw nothing.
///
/// [`wake`] can only ask for a repaint through a context, and the shell skips the rest of
/// `logic`/`ui` while the host keeps the app hidden. A host hides the runtime right after creating
/// it — before eframe's first frame — so a context captured only from a visible frame leaves the
/// first [`set_presentation`] with nothing to wake: the app then stays idle until an unrelated
/// event (a canvas resize) forces a paint.
pub fn remember_ctx(ctx: &egui::Context) {
    with_seam(|seam| {
        if seam.ctx.is_none() {
            seam.ctx = Some(ctx.clone());
        }
    });
}

/// Install (or replace) the frame the document area should show. Cheap to call every frame:
/// the app only re-uploads when the revision changes.
pub fn set_image(frame: Frame) {
    with_seam(|seam| {
        seam.source = Source::Image(Arc::new(frame));
        seam.revision = seam.revision.wrapping_add(1);
        seam.wants_repaint = true;
    });
    wake();
}

/// Hand the document area to the host: the app draws nothing there. The host must cover
/// [`last_rect`] itself, on top of the app's canvas.
pub fn set_transparent() {
    with_seam(|seam| {
        seam.source = Source::Transparent;
        seam.texture = None;
        seam.wants_repaint = true;
    });
    wake();
}

/// Stop the takeover; the document draws normally again.
pub fn clear() {
    with_seam(|seam| {
        seam.source = Source::Off;
        seam.texture = None;
        seam.wants_repaint = false;
        seam.last_rect = None;
    });
    wake();
}

/// Remember the app's egui context and the document rectangle, once per frame and whether or not
/// a takeover is live. Two reasons it cannot wait for [`paint`]:
///
/// * the first `set_image`/`set_transparent` must be able to schedule a repaint, but an idle app
///   is otherwise never asked to draw again;
/// * a "cover this rectangle" host needs [`last_rect`] *before* it asks for the takeover.
pub fn report(ctx: &egui::Context, rect: Rect) {
    with_seam(|seam| {
        seam.last_rect = Some([rect.left(), rect.top(), rect.width(), rect.height()]);
        if seam.ctx.is_none() {
            seam.ctx = Some(ctx.clone());
        }
    });
}

/// Is a takeover active?
pub fn is_active() -> bool {
    with_seam(|seam| !matches!(seam.source, Source::Off))
}

/// Whether the host asked for the area to stay blank ([`set_transparent`]).
pub fn is_transparent() -> bool {
    with_seam(|seam| matches!(seam.source, Source::Transparent))
}

/// Where the document area was last drawn, in egui points (`[x, y, w, h]`), for a host that
/// needs to line its own canvas up with it.
pub fn last_rect() -> Option<[f32; 4]> {
    with_seam(|seam| seam.last_rect)
}

/// Should the app keep repainting? True while a takeover is live.
pub fn wants_repaint() -> bool {
    with_seam(|seam| seam.wants_repaint)
}

/// Draw the takeover into `rect`, in place of the document composite. Returns `true` when it
/// handled the area, so the caller skips its own drawing.
///
/// `doc_rect` is the document's own on-screen rectangle, so a non-filling frame keeps the
/// document's aspect ratio while the camera moves around it.
pub fn paint(ctx: &egui::Context, painter: &Painter, rect: Rect, doc_rect: Rect) -> bool {
    let (source, revision, uploaded, texture) = with_seam(|seam| (seam.source.clone(), seam.revision, seam.uploaded, seam.texture.clone()));

    match source {
        Source::Off => false,
        Source::Transparent => true,
        Source::Image(frame) => {
            let needs_upload = texture.is_none() || uploaded != revision;
            let texture = if needs_upload { upload(ctx, texture, &frame) } else { texture.unwrap_or_else(|| upload(ctx, None, &frame)) };
            let target = if frame.fill {
                rect
            } else {
                // Keep the frame's aspect inside the document's rectangle.
                fit_aspect(doc_rect, frame.width as f32 / frame.height.max(1) as f32)
            };
            if target.width() > 0.0 && target.height() > 0.0 {
                painter.image(
                    texture.id(),
                    target,
                    Rect::from_min_max(Pos2::ZERO, Pos2::new(1.0, 1.0)),
                    Color32::WHITE,
                );
            }
            true
        }
    }
}

/// Draw the frame onto `rect` with no camera mapping at all (used when the document rectangle
/// is not meaningful, e.g. no open document).
pub fn paint_plain(ctx: &egui::Context, painter: &Painter, rect: Rect) -> bool {
    paint(ctx, painter, rect, rect)
}

fn upload(ctx: &egui::Context, existing: Option<TextureHandle>, frame: &Frame) -> TextureHandle {
    let image = frame.to_color_image();
    let options = TextureOptions::LINEAR;
    let handle = match existing {
        Some(mut handle) => {
            handle.set(image, options);
            handle
        }
        None => ctx.load_texture("photocraft-external-canvas", image, options),
    };
    let revision = with_seam(|seam| seam.revision);
    let clone = handle.clone();
    with_seam(move |seam| {
        seam.texture = Some(clone);
        seam.uploaded = revision;
    });
    handle
}

/// `base` shrunk to `aspect` (width / height), centred.
fn fit_aspect(base: Rect, aspect: f32) -> Rect {
    if !aspect.is_finite() || aspect <= 0.0 {
        return base;
    }
    let base_aspect = base.width() / base.height().max(f32::EPSILON);
    let size = if base_aspect > aspect {
        egui::vec2(base.height() * aspect, base.height())
    } else {
        egui::vec2(base.width(), base.width() / aspect)
    };
    Rect::from_center_size(base.center(), size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seam_is_off_until_a_host_asks() {
        clear();
        assert!(!is_active());
        assert!(!is_transparent());
        assert!(last_rect().is_none());
    }

    #[test]
    fn a_frame_round_trips_into_egui_colors() {
        let frame = Frame::solid(2, 2, [10, 20, 30, 255]);
        let image = frame.to_color_image();
        assert_eq!(image.size, [2, 2]);
        assert_eq!(image.pixels[0], Color32::from_rgba_unmultiplied(10, 20, 30, 255));
    }

    #[test]
    fn transparent_mode_reports_active_without_a_texture() {
        set_transparent();
        assert!(is_active());
        assert!(is_transparent());
        clear();
        assert!(!is_active());
    }

    #[test]
    fn a_non_filling_frame_keeps_its_aspect() {
        let base = Rect::from_min_size(Pos2::ZERO, egui::vec2(400.0, 200.0));
        let out = fit_aspect(base, 1.0);
        assert!((out.width() - out.height()).abs() < 0.01);
        assert!((out.width() - 200.0).abs() < 0.01);
        assert!((out.center() - base.center()).length() < 0.01);
    }
}

/// Preserve document/tools while clearing only the pasteboard for the host's backdrop.
pub fn set_capture_clean(on: bool) {
    with_seam(|s| { s.capture_clean = on; s.source = Source::Off; });
    wake();
}
pub fn capture_clean() -> bool { with_seam(|s| s.capture_clean) }
pub fn state() -> String { with_seam(|s| s.state.clone()) }
pub fn request_fit() { with_seam(|s| s.fit_requested = true); wake(); }
/// `max_side` is reserved: exports always retain source resolution (0 means unlimited).
pub fn request_export(_max_side: u32) {
    with_seam(|s| { s.export_requested = true; s.export = None; s.export_error = None; });
    wake();
}
pub fn take_export() -> Option<Vec<u8>> { with_seam(|s| s.export.take()) }
pub fn export_error() -> Option<String> { with_seam(|s| s.export_error.clone()) }

/// Process requests on the app thread; never hold SEAM while exporting or calling the app.
pub fn tick(app: &mut crate::PhotocraftApp, ctx: &egui::Context) {
    let (fit, export) = with_seam(|s| {
        s.ctx = Some(ctx.clone());
        s.last_rect = None;
        (std::mem::take(&mut s.fit_requested), std::mem::take(&mut s.export_requested))
    });
    if fit && let Some(i) = app.session.active_index() {
        if let Some(view) = app.ui.views.get_mut(i) { view.fit_pending = true; }
    }
    if export {
        let result = app.session.active().ok_or_else(|| "No active document".to_string())
            .and_then(|st| photocraft_io::export(&st.doc, "export.png", &Default::default()).map(|r| r.bytes).map_err(|e| e.to_string()));
        with_seam(|s| match result {
            Ok(bytes) => s.export = Some(bytes),
            Err(error) => s.export_error = Some(error),
        });
    }
}

/// State from the same UI pass that reported the document rectangle.
pub fn publish(app: &crate::PhotocraftApp, ctx: &egui::Context) {
    let modal = !app.ui.dialogs.is_empty() || ctx.memory(|m| m.top_modal_layer().is_some())
        || app.camera_raw.is_some() || app.wide_angle.is_some() || app.save_options_open();
    let operation = app.drag.is_some() || app.ui.transform.is_some() || app.ui.text_edit.is_some()
        || app.ui.pen.is_some() || !app.ui.polygon.is_empty() || app.ui.crop_rect.is_some()
        || app.ui.perspective_crop.is_some() || app.ui.symmetry_transform.is_some();
    let esc_owned = modal || operation || ctx.text_edit_focused() || ctx.any_popup_open()
        || crate::menu_nav::is_open(ctx) || crate::menu_keys::is_focused(ctx)
        || crate::widgets::dropdown_list_open(ctx) || app.ui.palette_open
        || app.ui.canvas_tool_menu.is_some() || app.ui.layer_menu.is_some()
        || app.ui.brush_picker.is_some() || app.ui.stroke_editor.is_some()
        || app.distort.gallery.is_some() || app.ui.view.screen_mode != "standard"
        || app.session.active().is_some_and(|st| st.doc.selection.is_some());
    let document = app.session.active();
    let css_scale = ctx.pixels_per_point() / ctx.native_pixels_per_point().unwrap_or(1.0);
    let document_view = document.and_then(|st| crate::canvas::ViewXform::active(app).map(|xf| {
        let center = xf.to_screen(st.doc.size.width as f32 / 2.0, st.doc.size.height as f32 / 2.0);
        serde_json::json!({"width": st.doc.size.width, "height": st.doc.size.height,
            "x": center.x * css_scale, "y": center.y * css_scale, "zoom": xf.zoom * css_scale})
    }));
    let view_ready = app.session.active_index().and_then(|i| app.ui.views.get(i))
        .is_some_and(|view| !view.fit_pending && !view.zoom_animating);
    with_seam(|s| {
        if document.is_none() { s.last_rect = None; }
        let rect = s.last_rect.map(|r| r.map(|v| v * ctx.pixels_per_point() / ctx.native_pixels_per_point().unwrap_or(1.0)));
        // egui points and CSS pixels normally coincide; account for custom UI scaling.
        s.state = serde_json::json!({
            "documents": app.session.documents().iter().map(|st| serde_json::json!({
                "id": st.doc.id.0.to_string(), "name": st.doc.name, "revision": st.revision.saturating_sub(st.view_revision), "dirty": st.is_dirty()
            })).collect::<Vec<_>>(),
            "documentId": document.map(|st| st.doc.id.0.to_string()),
            "documentName": document.map(|st| st.doc.name.clone()),
            "docWidth": document.map(|st| st.doc.size.width),
            "docHeight": document.map(|st| st.doc.size.height),
            "revision": document.map(|st| st.revision.saturating_sub(st.view_revision)),
            "dirty": document.is_some_and(|st| st.is_dirty()),
            "rect": rect, "modal": modal, "escOwned": esc_owned,
            "operation": operation, "documentView": document_view, "viewReady": view_ready
        }).to_string();
    });
}

pub fn reset() { let mut g = SEAM.lock().unwrap_or_else(PoisonError::into_inner); *g = None; }
pub fn wake_runtime() { wake(); }

static HOSTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static INPUT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);
static REQUESTS: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());
pub fn set_hosted(on: bool) { HOSTED.store(on, std::sync::atomic::Ordering::Relaxed); }
pub fn hosted() -> bool { HOSTED.load(std::sync::atomic::Ordering::Relaxed) }
pub fn visible() -> bool { VISIBLE.load(std::sync::atomic::Ordering::Relaxed) }
pub fn input_enabled() -> bool { INPUT.load(std::sync::atomic::Ordering::Relaxed) }
pub fn set_presentation(visible: bool, input: bool) { VISIBLE.store(visible, std::sync::atomic::Ordering::Relaxed); INPUT.store(input, std::sync::atomic::Ordering::Relaxed); wake(); }
pub fn request_document(kind: &str, id: String) { REQUESTS.lock().unwrap_or_else(PoisonError::into_inner).push(serde_json::json!({"kind":kind,"id":id})); }
pub fn take_requests() -> String { serde_json::to_string(&std::mem::take(&mut *REQUESTS.lock().unwrap_or_else(PoisonError::into_inner))).unwrap_or_default() }
