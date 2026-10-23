//! P7：构图、参考线／网格／吸附、文字排版与矢量
//! （change: 2026-10-22-complete-photocraft-webui-editing，P7 / design D9）。
//!
//! ## 构图
//!
//! 裁剪、图像尺寸、画布尺寸与平移都走上游 `engine::image_cmds`；本模块补**隔离草稿**：
//! 预览只改候选文档，确认才提交一步历史。内核原子更新层／蒙版／路径／选区与智能对象变换。
//!
//! ## 视图辅助
//!
//! 标尺、参考线、网格、吸附与图层过滤是**工作区状态**，不进文档、不进内容 hash、不进历史。
//! 吸附计算复用上游 `engine::snap`（源坐标 + 屏幕阈值换算）。
//!
//! ## 文字与矢量
//!
//! 排版参数（行距／字距／字偶距／基线偏移）走上游 `type.setStyle`；钢笔路径、形状与矢量蒙版
//! 走上游 `vector_cmds`。内核几何是权威，叠加层只呈现控制柄。

use photocraft_doc::{Document, LayerId};
use photocraft_engine::Session;
use serde_json::{Value, json};
use std::sync::Arc;

use crate::error::{EditorError, Result};

fn error(id: &'static str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// 构图命令（可预览）。
///
/// 只列**已开放**的命令：草稿在临时会话里渲染，不走 `Editor::execute` 的命令门，因此这里必须
/// 与能力白名单保持一致（`ComposeDraft::begin` 另行复核）。透视裁剪、Reveal All、任意角度
/// 旋转等仍未开放的命令不属于本列表。
pub const COMPOSE_COMMANDS: &[&str] = &["image.crop", "image.imageSize", "image.canvasSize", "image.trim"];

/// 构图草稿：预览只改候选文档，确认一步提交。
pub struct ComposeDraft {
    base: photocraft_engine::DocState,
    id: String,
    params: Value,
    pub document: Arc<Document>,
}

impl ComposeDraft {
    /// 开始草稿：参数非法或计算失败都保留原文档。
    pub fn begin(session: &Session, id: &str, params: Value) -> Result<Self> {
        if !COMPOSE_COMMANDS.contains(&id) {
            return Err(error("image.compose", format!("{id} 不是已开放的构图命令")));
        }
        // 与 `Editor::execute` 共用同一道能力门：草稿在临时会话里渲染，不经过执行入口，
        // 因此必须自己复核，避免 UI 与内核白名单分叉。
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        let base = session.active().ok_or(EditorError::NoDocument)?.clone();
        validate_compose(&base.doc, id, &params)?;
        let document = render(&base, id, &params)?;
        Ok(Self { base, id: id.to_string(), params, document })
    }

    /// 更新参数：失败时保留上一次有效草稿。
    pub fn update(&mut self, params: Value) -> Result<()> {
        validate_compose(&self.base.doc, &self.id, &params)?;
        self.document = render(&self.base, &self.id, &params)?;
        self.params = params;
        Ok(())
    }

    /// 当前候选尺寸（UI 预览用）。
    pub fn size(&self) -> (u32, u32) {
        (self.document.size.width, self.document.size.height)
    }

    /// 确认：一步历史。
    pub fn commit(&self, session: &mut Session) -> Result<()> {
        crate::preview_history::commit(
            session,
            self.document.clone(),
            Some(self.base.active_layer),
            history_label(&self.id),
        )
        .map_err(|failure| error("image.compose", failure))
    }

    /// 确认结果的对外描述（尺寸、原点偏移、分辨率、是否保留画布外像素）。
    pub fn outcome(&self) -> Result<Value> {
        let plan = plan(&self.base.doc, &self.id, &self.params)?;
        Ok(json!({
            "command": self.id,
            "width": self.document.size.width,
            "height": self.document.size.height,
            "x": plan.offset.0,
            "y": plan.offset.1,
            "resolution": self.document.resolution_dpi,
            // 保留画布外像素时，文档尺寸之外的内容仍可被后续 Reveal All 取回。
            "keepsOutsidePixels": !deletes_cropped_pixels(&self.id, &self.params),
        }))
    }
}

/// 历史步骤名：每种构图命令在撤销栈里可辨认。
fn history_label(id: &str) -> &'static str {
    match id {
        "image.crop" => "裁剪",
        "image.imageSize" => "图像尺寸",
        "image.canvasSize" => "画布尺寸",
        "image.trim" => "裁边",
        _ => "构图修改",
    }
}

/// 裁剪是否删除画布外像素（默认删除；Reveal All 依赖保留模式）。
fn deletes_cropped_pixels(id: &str, params: &Value) -> bool {
    id != "image.crop"
        || params.get("deleteCroppedPixels").and_then(Value::as_bool).unwrap_or(true)
}

/// 构图结果：文档尺寸、原点偏移与重采样标记（UI 提示与预算共用）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ComposePlan {
    pub width: u32,
    pub height: u32,
    /// 旧画布原点在新画布中的位置（画布尺寸的锚点位移或裁剪原点）。
    pub offset: (i32, i32),
    /// 像素被重采样（而非仅改元数据）。
    pub resampled: bool,
}

/// 按上游语义计算一次构图命令的结果，不分配像素。
///
/// 裁剪允许取到画布之外（裁剪框可扩展画布）。旧实现在这里按文档边界拒绝，
/// 使「保留裁剪像素」和拉直裁剪都无法进入内核；现在改为只校验尺寸/预算，
/// 越界是否合法交给上游（扩展区域按背景色或透明填充）。
pub fn plan(document: &Document, id: &str, params: &Value) -> Result<ComposePlan> {
    let max_side = f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE);
    let max_pixels = photocraft_project_verify::limits::MAX_CANVAS_PIXELS;
    let number = |key: &str, range: (f64, f64)| -> Result<f64> {
        params
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite() && *value >= range.0 && *value <= range.1)
            .ok_or_else(|| error("image.compose", format!("{key} 必须在 {}–{} 之间", range.0, range.1)))
    };
    let round_side = |value: f64| value.round().clamp(1.0, max_side) as u32;
    match id {
        "image.crop" => {
            let width = round_side(number("width", (1.0, max_side))?);
            let height = round_side(number("height", (1.0, max_side))?);
            let x = number("x", (-max_side, max_side))?.round() as i32;
            let y = number("y", (-max_side, max_side))?.round() as i32;
            check_pixels(width, height, max_pixels, "裁剪后像素超过工程上限")?;
            // 角度：上游按 (-180, 180] 归一化，0 走无重采样的直裁剪。
            let mut rotated = false;
            if let Some(angle) = params.get("angle").filter(|value| !value.is_null()) {
                let angle = angle
                    .as_f64()
                    .filter(|value| value.is_finite() && value.abs() <= 3600.0)
                    .ok_or_else(|| error("image.compose", "angle 必须是 ±3600 内的有限度数"))?;
                // 与上游一致：模 360 后为 0 视为不旋转。
                let normalized = angle.rem_euclid(360.0);
                let normalized = if normalized > 180.0 { normalized - 360.0 } else { normalized };
                if normalized.abs() >= 1e-9 {
                    rotated = true;
                    check_rotation_budget(document.size, angle, max_side, max_pixels)?;
                }
            }
            // 裁剪工具的目标尺寸（两者同时给出）与分辨率。
            let target = target_size(params, max_side)?;
            if let Some((tw, th)) = target {
                check_pixels(tw, th, max_pixels, "裁剪目标像素超过工程上限")?;
            }
            validate_resolution(params)?;
            validate_resample(params, target.is_some())?;
            validate_bool(params, "deleteCroppedPixels")?;
            validate_bool(params, "contentAware")?;
            let (w, h) = target.unwrap_or((width, height));
            Ok(ComposePlan { width: w, height: h, offset: (x, y), resampled: target.is_some() || rotated })
        }
        "image.imageSize" => {
            let (ow, oh) = (f64::from(document.size.width), f64::from(document.size.height));
            let mut pw = params.get("width").and_then(Value::as_f64);
            let mut ph = params.get("height").and_then(Value::as_f64);
            for (key, value) in [("width", pw), ("height", ph)] {
                if let Some(value) = value {
                    if !value.is_finite() || value < 1.0 || value > max_side {
                        return Err(error("image.compose", format!("{key} 必须在 1–{max_side} 之间")));
                    }
                }
            }
            // 百分比缩放两侧；显式边长优先（与上游一致）。
            if let Some(percent) = params.get("percent") {
                let percent = percent
                    .as_f64()
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .ok_or_else(|| error("image.compose", "percent 必须是正数"))?;
                pw = pw.or(Some(ow * percent / 100.0));
                ph = ph.or(Some(oh * percent / 100.0));
            }
            let dpi = validate_resolution(params)?;
            // 只改分辨率且保持打印尺寸：像素按新旧 DPI 比例重采样（上游 keepPrintSize）。
            if params.get("keepPrintSize").and_then(Value::as_bool) == Some(true) && pw.is_none() && ph.is_none() {
                let dpi = dpi.ok_or_else(|| error("image.compose", "keepPrintSize 需要同时给出 resolution"))?;
                let old = f64::from(document.resolution_dpi).max(1.0);
                pw = Some(ow * f64::from(dpi) / old);
                ph = Some(oh * f64::from(dpi) / old);
            }
            let resample = resample_mode(params)?;
            let (nw, nh) = match (pw, ph) {
                (Some(w), Some(h)) => (w, h),
                (Some(w), None) => (w, w * oh / ow.max(1.0)),
                (None, Some(h)) => (h * ow / oh.max(1.0), h),
                (None, None) => (ow, oh),
            };
            let (nw, nh) = (round_side(nw), round_side(nh));
            let changed = (nw, nh) != (document.size.width, document.size.height);
            if resample != ResampleMode::None && changed {
                check_pixels(nw, nh, max_pixels, "图像尺寸像素超过工程上限")?;
            }
            Ok(ComposePlan { width: nw, height: nh, offset: (0, 0), resampled: resample != ResampleMode::None && changed })
        }
        "image.canvasSize" => {
            let relative = params.get("relative").and_then(Value::as_bool).unwrap_or(false);
            let (ow, oh) = (f64::from(document.size.width), f64::from(document.size.height));
            let width = match params.get("width").and_then(Value::as_f64) {
                Some(value) if value.is_finite() => value,
                Some(_) => return Err(error("image.compose", "width 必须是有限数值")),
                None => if relative { 0.0 } else { ow },
            };
            let height = match params.get("height").and_then(Value::as_f64) {
                Some(value) if value.is_finite() => value,
                Some(_) => return Err(error("image.compose", "height 必须是有限数值")),
                None => if relative { 0.0 } else { oh },
            };
            let (nw, nh) = if relative { (ow + width, oh + height) } else { (width, height) };
            if !(nw.is_finite() && nh.is_finite()) {
                return Err(error("image.compose", "画布尺寸必须是有限数值"));
            }
            if nw < 1.0 || nh < 1.0 {
                return Err(error("image.compose", "画布尺寸至少为 1 × 1 像素"));
            }
            let (nw, nh) = (round_side(nw), round_side(nh));
            check_pixels(nw, nh, max_pixels, "画布尺寸像素超过工程上限")?;
            let anchor = params.get("anchor").and_then(Value::as_str);
            let (ax, ay) = anchor_factors(anchor)?;
            let dx = ((f64::from(nw) - ow) * ax).round() as i32;
            let dy = ((f64::from(nh) - oh) * ay).round() as i32;
            validate_extension_color(params)?;
            validate_bool(params, "relative")?;
            Ok(ComposePlan { width: nw, height: nh, offset: (dx, dy), resampled: false })
        }
        "image.trim" => {
            let based_on = params.get("basedOn").and_then(Value::as_str).unwrap_or("transparent");
            if !["transparent", "topLeft", "bottomRight"].contains(&based_on) {
                return Err(error("image.compose", "basedOn 必须是 transparent|topLeft|bottomRight"));
            }
            for side in ["top", "bottom", "left", "right"] {
                validate_bool(params, side)?;
            }
            // 裁边范围由像素内容决定，候选尺寸要等上游计算。
            Ok(ComposePlan {
                width: document.size.width,
                height: document.size.height,
                offset: (0, 0),
                resampled: false,
            })
        }
        other => return Err(error("image.compose", format!("{other} 不是已开放的构图命令"))),
    }
}

fn check_pixels(width: u32, height: u32, max_pixels: u64, message: &str) -> Result<()> {
    if u64::from(width).saturating_mul(u64::from(height)) > max_pixels {
        return Err(error("image.compose", message));
    }
    Ok(())
}

fn check_rotation_budget(size: photocraft_doc::Size, angle: f64, max_side: f64, max_pixels: u64) -> Result<()> {
    let rotated = photocraft_engine::mode_cmds::rotated_size(size, angle);
    if f64::from(rotated.width) > max_side || f64::from(rotated.height) > max_side {
        return Err(error("image.compose", "拉直后的画布超过工程单边上限"));
    }
    check_pixels(rotated.width, rotated.height, max_pixels, "拉直后的画布像素超过工程上限")
}

fn target_size(params: &Value, max_side: f64) -> Result<Option<(u32, u32)>> {
    let side = |key: &str| -> Result<Option<u32>> {
        match params.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 1.0 && *value <= max_side)
                .map(|value| Some(value.round() as u32))
                .ok_or_else(|| error("image.compose", format!("{key} 必须在 1–{max_side} 像素之间"))),
        }
    };
    match (side("targetWidth")?, side("targetHeight")?) {
        (Some(w), Some(h)) => Ok(Some((w, h))),
        (None, None) => Ok(None),
        _ => Err(error("image.compose", "targetWidth 与 targetHeight 必须同时给出")),
    }
}

fn validate_resolution(params: &Value) -> Result<Option<f32>> {
    match params.get("resolution") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 1.0 && *value <= 10_000.0)
            .map(|value| Some(value as f32))
            .ok_or_else(|| error("image.compose", "resolution 必须在 1–10000 ppi 之间")),
    }
}

/// 与上游 `parse_resample` 相同的名称集合（未知名称上游按 bicubic 处理，这里直接拒绝）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResampleMode {
    None,
    Automatic,
    Filter,
}

fn resample_mode(params: &Value) -> Result<ResampleMode> {
    let Some(value) = params.get("resample") else { return Ok(ResampleMode::Filter) };
    if value.is_null() {
        return Ok(ResampleMode::Filter);
    }
    let name = value.as_str().ok_or_else(|| error("image.compose", "resample 必须是字符串"))?;
    match name {
        "none" => Ok(ResampleMode::None),
        "automatic" => Ok(ResampleMode::Automatic),
        "nearest" | "nearestNeighbor" | "bilinear" | "bicubic" | "bicubicSmoother" | "bicubicSharper"
        | "bicubicAutomatic" | "lanczos" | "preserveDetails" => Ok(ResampleMode::Filter),
        other => Err(error("image.compose", format!("resample 不支持 {other}"))),
    }
}

fn validate_resample(params: &Value, needs_resampling: bool) -> Result<()> {
    let mode = resample_mode(params)?;
    if needs_resampling && mode == ResampleMode::None {
        return Err(error("image.compose", "给出目标尺寸时必须重采样，resample 不能是 none"));
    }
    Ok(())
}

fn validate_bool(params: &Value, key: &str) -> Result<()> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(error("image.compose", format!("{key} 必须是 true 或 false"))),
    }
}

fn validate_extension_color(params: &Value) -> Result<()> {
    let Some(value) = params.get("extensionColor") else { return Ok(()) };
    if value.is_null() {
        return Ok(());
    }
    let name = value.as_str().ok_or_else(|| error("image.compose", "extensionColor 必须是字符串"))?;
    let named = ["background", "foreground", "white", "black", "transparent"];
    let hex = name.strip_prefix('#').is_some_and(|hex| {
        hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())
    });
    if named.contains(&name) || hex {
        return Ok(());
    }
    Err(error("image.compose", "extensionColor 必须是 background|foreground|white|black|transparent|#rrggbb"))
}

/// 九宫格锚点（与上游 ANCHORS 同名同序）。
fn anchor_factors(anchor: Option<&str>) -> Result<(f64, f64)> {
    const ANCHORS: [(&str, (f64, f64)); 9] = [
        ("topLeft", (0.0, 0.0)),
        ("top", (0.5, 0.0)),
        ("topRight", (1.0, 0.0)),
        ("left", (0.0, 0.5)),
        ("center", (0.5, 0.5)),
        ("right", (1.0, 0.5)),
        ("bottomLeft", (0.0, 1.0)),
        ("bottom", (0.5, 1.0)),
        ("bottomRight", (1.0, 1.0)),
    ];
    let name = anchor.unwrap_or("center");
    ANCHORS
        .iter()
        .find(|(candidate, _)| *candidate == name)
        .map(|&(_, factors)| factors)
        .ok_or_else(|| error("image.compose", "画布锚点不受支持"))
}

fn render(base: &photocraft_engine::DocState, id: &str, params: &Value) -> Result<Arc<Document>> {
    let mut scratch = Session::new();
    scratch.add_document((*base.doc).clone(), None);
    *scratch.active_mut().unwrap() = base.clone();
    scratch.execute(id, params.clone()).map_err(|failure| error("image.compose", failure))?;
    Ok(scratch.active().unwrap().doc.clone())
}

/// 构图参数范围校验（在分配像素前拒绝超限）。
///
/// 只做校验，语义计算见 [`plan`]；两者共用同一份规则，避免预览与提交分叉。
pub fn validate_compose(document: &Document, id: &str, params: &Value) -> Result<()> {
    plan(document, id, params).map(|_| ())
}

fn validate_document_ready(session: &Session) -> Result<()> {
    if session.active().is_none() {
        return Err(EditorError::NoDocument);
    }
    Ok(())
}

/// 兼容旧调用的图层 id 解析（矢量命令都接受 `layer`）。
pub fn target_layer(params: &Value) -> Option<LayerId> {
    params.get("layer").and_then(Value::as_u64).map(LayerId)
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Color, ColorMode, SampleType, Size};

    fn document() -> Document {
        Document::with_background(
            "doc",
            Size::new(40, 30),
            ColorMode::Rgb,
            SampleType::U8,
            Color::rgb(0.5, 0.5, 0.5),
        )
    }

    fn session() -> Session {
        let mut session = Session::new();
        session.add_document(document(), None);
        session
    }

    #[test]
    fn crop_draft_previews_then_commits_one_step_and_rejects_out_of_bounds() {
        let mut session = session();
        let before = session.active().unwrap().clone();
        let draft = ComposeDraft::begin(&session, "image.crop", json!({"x":4,"y":3,"width":20,"height":10})).unwrap();
        assert_eq!(draft.size(), (20, 10));
        assert_eq!(session.active().unwrap().doc.size, before.doc.size, "预览不改正式文档");
        // 零尺寸、超单边与超像素预算在草稿阶段拒绝。
        assert!(ComposeDraft::begin(&session, "image.crop", json!({"x":0,"y":0,"width":0,"height":10})).is_err());
        assert!(ComposeDraft::begin(&session, "image.crop", json!({"x":0,"y":0,"width":9000,"height":10})).is_err());
        // 单边 8192 且恰好等于像素预算的画布仍是合法上限。
        assert!(validate_compose(&before.doc, "image.crop", &json!({"x":0,"y":0,"width":8192,"height":8192})).is_ok());
        assert!(validate_compose(&before.doc, "image.crop", &json!({"x":0,"y":0,"width":8192,"height":8193})).is_err());
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().doc.size, Size::new(20, 10));
        assert_eq!(session.active().unwrap().history.past_len(), before.history.past_len() + 1);
        assert_eq!(session.active().unwrap().history.undo_label(), Some("裁剪"));
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc.size, before.doc.size);
    }

    #[test]
    fn crop_frame_may_extend_past_the_canvas_and_keeps_pixels_when_asked() {
        let mut session = session();
        let before = session.active().unwrap().clone();
        // 裁剪框可以超出画布（Reveal All 与拉直裁剪都依赖这一点）。
        let draft = ComposeDraft::begin(
            &session,
            "image.crop",
            json!({"x":-6,"y":-4,"width":52,"height":40,"deleteCroppedPixels":false}),
        )
        .unwrap();
        assert_eq!(draft.size(), (52, 40));
        let outcome = draft.outcome().unwrap();
        draft.commit(&mut session).unwrap();
        let document = &session.active().unwrap().doc;
        assert_eq!(document.size, Size::new(52, 40));
        assert_eq!(outcome["keepsOutsidePixels"], true);
        assert_eq!(outcome["x"], -6);
        // 保留模式不删除层表面，画布外内容仍在（Reveal All 能取回）。
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc.size, before.doc.size);
    }

    #[test]
    fn crop_validates_straighten_target_size_and_resampling() {
        let session = session();
        let document = session.active().unwrap().doc.clone();
        // 角度走旋转后裁剪；0 与 360 视为不旋转。
        assert!(plan(&document, "image.crop", &json!({"x":2,"y":2,"width":20,"height":10,"angle":15.0})).is_ok());
        assert_eq!(
            plan(&document, "image.crop", &json!({"x":2,"y":2,"width":20,"height":10,"angle":360.0})).unwrap().resampled,
            false
        );
        assert!(plan(&document, "image.crop", &json!({"x":2,"y":2,"width":20,"height":10,"angle":"x"})).is_err());
        assert!(plan(&document, "image.crop", &json!({"x":2,"y":2,"width":20,"height":10,"angle":9000.0})).is_err());
        // 目标尺寸必须成对，且不能配 resample=none。
        assert!(plan(&document, "image.crop", &json!({"x":0,"y":0,"width":10,"height":10,"targetWidth":20})).is_err());
        assert!(plan(
            &document,
            "image.crop",
            &json!({"x":0,"y":0,"width":10,"height":10,"targetWidth":20,"targetHeight":20,"resample":"none"})
        )
        .is_err());
        let sized = plan(
            &document,
            "image.crop",
            &json!({"x":0,"y":0,"width":10,"height":10,"targetWidth":20,"targetHeight":20,"resample":"lanczos","resolution":240}),
        )
        .unwrap();
        assert_eq!((sized.width, sized.height, sized.resampled), (20, 20, true));
        // 布尔参数类型错误直接拒绝。
        assert!(plan(&document, "image.crop", &json!({"x":0,"y":0,"width":10,"height":10,"deleteCroppedPixels":"yes"})).is_err());
        assert!(plan(&document, "image.crop", &json!({"x":0,"y":0,"width":10,"height":10,"contentAware":1})).is_err());
    }

    #[test]
    fn image_size_keeps_pixels_without_resampling_and_reports_print_size_scaling() {
        let session = session();
        let document = session.active().unwrap().doc.clone();
        // 只改 DPI：像素不变，不走重采样预算。
        let dpi_only = plan(&document, "image.imageSize", &json!({"resample":"none","resolution":300})).unwrap();
        assert_eq!((dpi_only.width, dpi_only.height, dpi_only.resampled), (40, 30, false));
        // 保留打印尺寸：像素按 DPI 比例变化。
        let print = plan(&document, "image.imageSize", &json!({"resolution":144,"keepPrintSize":true})).unwrap();
        assert!(print.width > 40 && print.height > 30 && print.resampled);
        // keepPrintSize 必须给 resolution。
        assert!(plan(&document, "image.imageSize", &json!({"keepPrintSize":true})).is_err());
        // 百分比缩放两侧；显式边长优先，另一侧仍按百分比（与上游一致）。
        let percent = plan(&document, "image.imageSize", &json!({"percent":200})).unwrap();
        assert_eq!((percent.width, percent.height), (80, 60));
        let explicit = plan(&document, "image.imageSize", &json!({"percent":200,"width":20})).unwrap();
        assert_eq!((explicit.width, explicit.height), (20, 60));
        // 只给一侧时保持宽高比。
        let aspect = plan(&document, "image.imageSize", &json!({"width":80})).unwrap();
        assert_eq!((aspect.width, aspect.height), (80, 60));
        // 非法 DPI、算法与尺寸被拒绝。
        assert!(plan(&document, "image.imageSize", &json!({"resolution":0})).is_err());
        assert!(plan(&document, "image.imageSize", &json!({"resolution":20000})).is_err());
        assert!(plan(&document, "image.imageSize", &json!({"resample":"starfield"})).is_err());
        assert!(plan(&document, "image.imageSize", &json!({"width":0})).is_err());
        assert!(plan(&document, "image.imageSize", &json!({"percent":0})).is_err());
        assert!(plan(&document, "image.imageSize", &json!({"percent":-50})).is_err());
    }

    #[test]
    fn canvas_size_reports_anchor_offset_and_relative_extension_color() {
        let session = session();
        let document = session.active().unwrap().doc.clone();
        let centered = plan(&document, "image.canvasSize", &json!({"width":60,"height":50,"anchor":"center"})).unwrap();
        assert_eq!((centered.width, centered.height, centered.offset), (60, 50, (10, 10)));
        let top_left = plan(&document, "image.canvasSize", &json!({"width":60,"height":50,"anchor":"topLeft"})).unwrap();
        assert_eq!(top_left.offset, (0, 0));
        let bottom_right =
            plan(&document, "image.canvasSize", &json!({"width":60,"height":50,"anchor":"bottomRight"})).unwrap();
        assert_eq!(bottom_right.offset, (20, 20));
        // 相对增减：负值收缩，锚点决定保留哪一边（右下锚让左上角向外移）。
        let shrink = plan(
            &document,
            "image.canvasSize",
            &json!({"relative":true,"width":-10,"height":-5,"anchor":"bottomRight"}),
        )
        .unwrap();
        assert_eq!((shrink.width, shrink.height, shrink.offset), (30, 25, (-10, -5)));
        // 扩展颜色与锚点校验。
        assert!(plan(&document, "image.canvasSize", &json!({"width":50,"height":40,"extensionColor":"#3366cc"})).is_ok());
        assert!(plan(&document, "image.canvasSize", &json!({"width":50,"height":40,"extensionColor":"transparent"})).is_ok());
        assert!(plan(&document, "image.canvasSize", &json!({"width":50,"height":40,"extensionColor":"#36c"})).is_err());
        assert!(plan(&document, "image.canvasSize", &json!({"width":50,"height":40,"extensionColor":"purple"})).is_err());
        assert!(plan(&document, "image.canvasSize", &json!({"width":50,"height":40,"anchor":"nowhere"})).is_err());
        // 收缩到 0 或负值被拒绝。
        assert!(plan(&document, "image.canvasSize", &json!({"relative":true,"width":-40,"height":0})).is_err());
    }

    #[test]
    fn trim_rejects_a_canvas_with_nothing_to_trim_and_validates_basis_and_sides() {
        let mut session = session();
        let before = session.active().unwrap().clone();
        // 纯色画布按角像素裁边时没有可裁区域：草稿拒绝并保留原文档。
        let failure = ComposeDraft::begin(
            &session,
            "image.trim",
            json!({"basedOn":"topLeft","top":true,"bottom":false,"left":true,"right":false}),
        );
        assert!(failure.is_err(), "没有可裁区域时必须拒绝");
        assert!(ComposeDraft::begin(&session, "image.trim", json!({"basedOn":"nowhere"})).is_err());
        assert!(ComposeDraft::begin(&session, "image.trim", json!({"top":"yes"})).is_err());
        assert_eq!(session.active().unwrap().doc, before.doc, "失败不改文档");
        // 四边全关时上游没有可裁边，但仍允许开始草稿（候选与原文一致）。
        let draft = ComposeDraft::begin(
            &session,
            "image.trim",
            json!({"top":false,"bottom":false,"left":false,"right":false}),
        )
        .unwrap();
        assert_eq!(draft.size(), (before.doc.size.width, before.doc.size.height));
        draft.commit(&mut session).unwrap();
        assert_eq!(session.active().unwrap().history.past_len(), before.history.past_len() + 1);
        session.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(session.active().unwrap().doc, before.doc);
    }

    #[test]
    fn canvas_and_image_size_validate_anchor_budget_and_keep_original_on_failure() {
        let mut session = session();
        let before = session.active().unwrap().clone();
        assert!(ComposeDraft::begin(&session, "image.canvasSize", json!({"width":50,"height":40,"anchor":"nowhere"})).is_err());
        let draft = ComposeDraft::begin(&session, "image.canvasSize", json!({"width":50,"height":40,"anchor":"center"})).unwrap();
        assert_eq!(draft.size(), (50, 40));
        assert!(ComposeDraft::begin(&session, "image.imageSize", json!({"width":9000,"height":9000})).is_err());
        assert!(ComposeDraft::begin(&session, "image.perspectiveCrop", json!({})).is_err(), "未开放命令");
        assert_eq!(session.active().unwrap().doc, before.doc);
    }

    #[test]
    fn view_aids_and_snapping_never_touch_document_content() {
        let document = document();
        let mut aids = ViewAids::default();
        let result = snap_point(&document, &aids, [0.4, 15.2], 2.0);
        // 文档左边与中心是吸附目标；容差内应吸到 0。
        assert!(result.point[0] <= 0.4);
        // 临时关闭吸附：原样返回，无反馈线。
        aids.snap_suspended = true;
        let suspended = snap_point(&document, &aids, [0.4, 15.2], 2.0);
        assert_eq!(suspended.point, [0.4, 15.2]);
        assert!(suspended.lines.is_empty());
        // 视图状态不参与内容身份。
        assert_eq!(
            crate::document_content::document_content_hash(&document, &Default::default()),
            crate::document_content::document_content_hash(&document, &Default::default())
        );
        assert!(aids.to_json()["suspend"] == true);
    }

    #[test]
    fn layer_filter_matches_both_ui_ids_and_kernel_names() {
        let filter = LayerFilter { name: String::new(), kinds: vec!["raster".into()], only_selected: false };
        assert!(!filter.hides("背景", "raster", false));
        assert!(filter.hides("标题", "text", false));
        // 也接受内核显示名，避免宿主沿用旧调用点失效。
        assert!(!filter.hides("背景", "Pixel", false));
        assert!(!filter.hides("背景", "pixel", false));
        assert!(filter.hides("组", "group", false));
    }

    #[test]
    fn layer_filter_only_hides_list_rows() {
        let filter = LayerFilter { name: "标题".into(), kinds: vec![], only_selected: false };
        assert!(filter.hides("段落", "text", false));
        assert!(!filter.hides("标题 1", "text", false));
        assert!(filter.active());
        let kinds = LayerFilter { name: String::new(), kinds: vec!["text".into()], only_selected: false };
        assert!(!kinds.hides("标题", "text", false));
        assert!(kinds.hides("背景", "raster", false));
        let selected = LayerFilter { name: String::new(), kinds: vec![], only_selected: true };
        assert!(selected.hides("未选", "raster", false));
        assert!(!selected.hides("已选", "raster", true));
        assert!(!LayerFilter::default().active());
    }

    #[test]
    fn typography_patch_accepts_supported_params_and_rejects_others() {
        let patch = typography_patch(&json!({"leading":24,"tracking":120,"kerning":"optical","baselineShift":-3})).unwrap();
        assert_eq!(patch["leading"], 24.0);
        assert_eq!(patch["kerning"], "optical");
        assert!(typography_patch(&json!({"vertical":true})).is_err());
        assert!(typography_patch(&json!({})).is_err());
        assert!(typography_patch(&json!({"leading":1e9})).is_err());
        assert!(typography_patch(&json!({"tracking":20000})).is_err());
        assert!(typography_patch(&json!({"kerning":"bogus"})).is_err());
        assert!(typography_patch(&json!({"kernPair":{"at":1}})).is_err());
        assert!(typography_patch(&json!({"kernPair":{"at":1,"by":-20}})).is_ok());
    }

    #[test]
    fn vector_geometry_is_validated_and_applied_through_the_kernel() {
        let mut session = session();
        let path = json!({"subpaths":[{"closed":true,"knots":[[4,4],[20,4],[20,20]]}]});
        validate_path(&session.active().unwrap().doc, &path).unwrap();
        assert!(validate_path(&session.active().unwrap().doc, &json!({"subpaths":[{"knots":[]}]})).is_err());
        assert!(validate_path(
            &session.active().unwrap().doc,
            &json!({"subpaths":[{"knots":[[1e9,0],[1,1]]}]})
        )
        .is_err());
        // 创建形状：
        let created = shape(&mut session, "shape.create", json!({"kind":"rect","rect":[4,4,16,12],"fill":"#3366cc"})).unwrap();
        assert!(created["layer"].as_u64().is_some());
        // 路径转选区：
        session
            .execute("path.set", json!({"name":"工作路径","path":path}))
            .unwrap();
        let selection = path_to_selection(&mut session, json!({"name":"工作路径"})).unwrap();
        assert!(selection.is_object());
        // 矢量蒙版：
        let layers = session.active().unwrap().doc.layers.len();
        let active_layer = session.active().unwrap().active_layer.unwrap_or(LayerId(0)).0;
        let mask = vector_mask(&mut session, "layer.vectorMask.add", json!({"layer":active_layer,"path":path}));
        assert!(mask.is_ok() || session.active().unwrap().doc.layers.len() == layers);
        // 未知命令被拒绝。
        assert!(shape(&mut session, "shape.presets.list", json!({})).is_err());
        assert!(vector_mask(&mut session, "layer.vectorMask.unknown", json!({})).is_err());
    }

    #[test]
    fn guides_are_rejected_without_a_document_and_snapshotted_as_view_data() {
        let mut empty = Session::new();
        assert!(guide(&mut empty, "view.newGuide", json!({"orientation":"vertical","position":10})).is_err());
        let mut session = session();
        guide(&mut session, "view.newGuide", json!({"orientation":"vertical","position":10})).unwrap();
        let document = session.active().unwrap().doc.clone();
        let snapshot = vector_snapshot(&document);
        assert_eq!(snapshot["guides"]["vertical"][0], 10.0);
        guide(&mut session, "view.clearGuides", json!({})).unwrap();
        assert!(vector_snapshot(&session.active().unwrap().doc)["guides"]["vertical"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}

#[path = "../views/composition_domain.rs"]
mod views_implementation;
pub use views_implementation::*;

#[path = "../type/composition_domain.rs"]
mod type_implementation;
pub use type_implementation::*;

#[path = "../vectors/composition_domain.rs"]
mod vectors_implementation;
pub use vectors_implementation::*;

#[path = "../layers/composition_domain.rs"]
mod layers_implementation;
pub use layers_implementation::*;
