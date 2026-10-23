//! 无 UI 编辑内核：React 前端的唯一对接面。
//!
//! 本模块把上游 `photocraft_engine::Session` 暴露成**纯字节 + JSON**的接口，不含任何 egui /
//! wgpu / DOM 依赖。React 负责全部界面与交互，通过 [`Editor::execute`] 执行同一套命令注册表，
//! 通过 [`Editor::state`] 读取文档状态，通过 [`Editor::render_preview`] 取合成预览像素。
//!
//! 边界（design D1/D3）：
//! - 输入输出只有字节（图片/工程）、JSON（状态/命令参数）和 RGBA8 预览像素；
//! - 没有文件路径、URL、环境或凭据进出本层；
//! - 撤销栈、图层树、选区与工具状态都由 engine 持有，React 不复制文档模型。

use photocraft_engine::{inspect, Session};
use serde_json::{json, Value};

use crate::document_content::{self, AssetRegistry};
use crate::error::{EditorError, Result};

/// 合成预览的像素上限（每边），防止把整幅大画布一次性读回 JS。
pub const MAX_PREVIEW_SIDE: u32 = 4096;
/// 存入工程内的预览图上限（每边）：只用于重开时的缩略/合成占位。
pub const PROJECT_PREVIEW_SIDE: u32 = 2048;
/// 工程缩略图上限（每边）。
pub const PROJECT_THUMBNAIL_SIDE: u32 = 256;

/// 一份合成预览：RGBA8、直通 alpha、行优先。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// 一次冻结导出的成对产物。
///
/// 同一个同步调用内取修订号、内容指纹、画布尺寸、工程字节与 PNG 字节，因此宿主保存时不可能
/// 把两个不同修订的产物拼在一起（design D3/D6）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportBundle {
    pub revision: u64,
    pub document_content_hash: String,
    pub canvas_width: u32,
    pub canvas_height: u32,
    /// `.pcraft` 工程字节。
    pub project: Vec<u8>,
    /// 带 alpha 的合成 PNG。
    pub output: Vec<u8>,
}

/// 编辑会话。持有 engine 的文档与历史；不持有任何 UI 状态。
pub struct Editor {
    pub(super) session: Session,
    pattern_library: crate::pattern_library::PatternLibrary,
    brush_library: crate::brush_library::BrushLibrary,
    pending_abr: Option<crate::brush_library::PendingAbr>,
    pub(super) smart_child: crate::smart_document::SmartChildState,
    /// P5/P6/P7 的隔离草稿与视图状态（预览不改正式文档）。
    pub(super) selection_draft: Option<crate::adjustment_ext::SelectionDraft>,
    pub(super) retouch_baseline: Option<crate::retouch::RetouchBaseline>,
    pub(super) retouch_preview: Option<std::sync::Arc<photocraft_doc::Document>>,
    pub(super) retouch_command: Option<String>,
    pub(super) retouch_params: Option<Value>,
    pub(super) filter_draft: Option<crate::retouch::FilterDraft>,
    pub(super) compose_draft: Option<crate::composition::ComposeDraft>,
    pub(super) view_aids: crate::composition::ViewAids,
    pub(super) registry: AssetRegistry,
    live_stroke: Option<(photocraft_engine::brush_cmds::LiveStroke, Value)>,
    stroke_damage: photocraft_geom::Rect,
    transform_preview: Option<crate::transform_preview::TransformPreview>,
    text_preview: Option<crate::text_preview::TextPreview>,
    adjustment_preview: Option<crate::adjustment_preview::AdjustmentPreview>,
    layer_properties_preview: Option<crate::layer_properties_preview::LayerPropertiesPreview>,
}

fn command_error_for(id: &str, message: &str) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.into() }
}

/// 打开工程时的核验通道。
///
/// 先走 `verify()`——它同时是普通上传与 CLI 的口径，对智能对象整体拒绝。只有它拒绝时才
/// 尝试专用于「含嵌入源工程」的 `smart_source::verify_project()`：那条通道把根容器与整棵
/// 嵌入源树纳入同一套预算（层数/层级/条目/解压字节），并继续拒绝外链、未开放效果、坏名称
/// 与不可逆仿射。
///
/// 为什么需要这一步：U66「转回图层」只解包**当前实例**，同一工程里其他共享实例仍是智能
/// 对象（这正是 spec 要求的成功证据「其他共享实例不变」）。如果打开入口不接受这类工程，
/// 「保存 → 重开」对只转回部分实例的文档就不成立。两个通道除「是否允许智能对象」外判定
/// 相同，因此这条回退不会放过任何其他拒绝原因；普通上传/CLI 的接收政策保持收紧。
fn verify_for_open(bytes: &[u8]) -> Result<()> {
    if photocraft_project_verify::verify(bytes).is_ok() {
        return Ok(());
    }
    photocraft_project_verify::smart_source::verify_project(bytes)
        .map(|_| ())
        .map_err(|failure| EditorError::LoadFailed(failure.message))
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

impl Editor {
    /// 新建一个空会话。
    pub fn new() -> Self {
        let mut editor = Self {
            session: Session::new(),
            pattern_library: Default::default(),
            brush_library: crate::brush_library::BrushLibrary::default(),
            pending_abr: None,
            smart_child: Default::default(),
            selection_draft: None,
            retouch_baseline: None,
            retouch_preview: None,
            retouch_command: None,
            retouch_params: None,
            filter_draft: None,
            compose_draft: None,
            view_aids: Default::default(),
            registry: AssetRegistry::default(),
            live_stroke: None,
            stroke_damage: photocraft_geom::Rect::EMPTY,
            transform_preview: None,
            text_preview: None,
            adjustment_preview: None,
            layer_properties_preview: None,
        };
        // 默认笔刷库在构造时同步到会话，工具栏在没有文档时也能选笔。
        editor.sync_brush_library();
        editor
    }

    /// 只注册随应用分发的固定中文字体；字节摘要不符即拒绝，不依赖系统字体。
    pub fn register_fixed_font(bytes: &[u8]) -> Result<()> {
        use sha2::{Digest, Sha256};
        static REGISTERED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        if format!("{:x}", Sha256::digest(bytes)) != "faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9" {
            return Err(EditorError::ImportFailed("固定字体摘要不符".into()));
        }
        REGISTERED.get_or_init(|| {
            let mut engine = photocraft_text::shared().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            engine.fonts.register_font_data(bytes.to_vec());
        });
        Ok(())
    }

    /// 打开一张图片，建立背景层文档；`asset_id` 是宿主稳定资产 id（可为空）。
    pub fn open_image(&mut self, name: &str, asset_id: Option<&str>, bytes: &[u8]) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let imported = photocraft_io::import(name, bytes).map_err(|e| EditorError::ImportFailed(e.to_string()))?;
        Self::validate_image_size(imported.document.size.width, imported.document.size.height)?;
        self.registry.clear();
        self.registry.base_asset_id = asset_id.map(str::to_string);
        let index = self.session.add_document(imported.document, None);
        self.session.set_active(index);
        let mut result = self.active_json()?;
        if let Some(obj) = result.as_object_mut() {
            obj.insert("warnings".into(), json!(imported.warnings));
            obj.insert("readOnly".into(), json!(imported.source_read_only));
        }
        Ok(result)
    }

    /// 打开一个 `.pcraft` 工程（React 侧从媒体存储取字节后传入）。
    ///
    /// `base_asset_id` 由宿主提供：内容指纹覆盖来源资产身份，重开时必须回填同一 id，否则
    /// 同一冻结文档会被算成不同内容。
    pub fn open_project(&mut self, bytes: &[u8], base_asset_id: Option<&str>) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !photocraft_format::is_pcraft(bytes) {
            return Err(EditorError::NotAProject);
        }
        verify_for_open(bytes)?;
        let doc = photocraft_format::load_from_bytes(bytes).map_err(|e| EditorError::LoadFailed(e.to_string()))?;
        // 颜色采样点的持久投影在文档元数据里（本域命名空间键）；载入时灌回会话状态，
        // 让 `view.colorSamplers.list`、单点读数与面板看到同一份点。
        let samplers = crate::features::views::samplers::samplers_from_metadata(&doc.metadata.text);
        self.registry.clear();
        self.registry.base_asset_id = base_asset_id.map(str::to_string);
        let index = self.session.add_document(doc, None);
        self.session.set_active(index);
        if let Some(state) = self.session.active_mut() {
            state.color_samplers = samplers;
        }
        self.active_json()
    }

    /// 内部字节转层，保留旧标注转换；用户置入命令不在白名单。
    pub fn place_image(&mut self, name: &str, asset_id: Option<&str>, bytes: &[u8], params: &Value) -> Result<Value> {
        self.require_no_stroke()?;
        if self.session.active().is_none() {
            return Err(EditorError::NoDocument);
        }
        self.check_layer_capacity()?;
        // 禁止上游默认的智能对象与自动缩图，首期只置入原尺寸像素层。
        let decoded = photocraft_codecs::decode_with(bytes, &photocraft_codecs::DecodeOptions {
            limits: photocraft_codecs::Limits { max_width: 8192, max_height: 8192, max_pixels: 67_108_864, max_alloc: 256 * 1024 * 1024 },
            ..Default::default()
        }).map_err(|e| EditorError::ImportFailed(e.to_string()))?;
        Self::validate_image_size(decoded.width(), decoded.height())?;
        drop(decoded);
        let mut params = params.as_object().cloned().unwrap_or_default();
        params.insert("smartObject".into(), json!(false));
        params.insert("fit".into(), json!(false));
        photocraft_engine::file_cmds::place_bytes(&mut self.session, name, bytes.to_vec(), None, &Value::Object(params))
            .map_err(|e| EditorError::CommandFailed { id: "file.placeEmbedded".into(), message: e.to_string() })?;
        if let Some(id) = self.active_layer_id() {
            if let Some(asset_id) = asset_id {
                self.registry.register_placed(id, asset_id);
            }
        }
        self.active_json()
    }

    /// 保存用的文档副本：把当前会话的颜色采样点写进元数据的命名空间键（U73）。
    ///
    /// 采样点是**会话视图状态**，上游明确不写进 `.pcraft`/PSD；本域把持久投影放在文档已有的
    /// 自由文本元数据里（[`crate::features::views::samplers`]）。只改副本：不动会话文档，
    /// 因此不推进 revision、不改内容指纹、不碰像素，也不会被撤销栈的快照回滚覆盖。
    fn document_for_save(&self) -> Result<std::borrow::Cow<'_, photocraft_doc::Document>> {
        let state = self.active_doc()?;
        let document = &state.doc;
        let key = crate::features::views::samplers::SAMPLERS_KEY;
        let has_key = document.metadata.text.iter().any(|(name, _)| name == key);
        // 没有采样点、元数据里也没有本域键：原样借用，保存字节连克隆都不经过（旧工程保存后
        // 仍是同一个形状，也不会为了一次保存复制整棵图层树）。
        if state.color_samplers.is_empty() && !has_key {
            return Ok(std::borrow::Cow::Borrowed(document));
        }
        let mut owned = (**document).clone();
        crate::features::views::samplers::apply_metadata(&mut owned, &state.color_samplers);
        Ok(std::borrow::Cow::Owned(owned))
    }

    /// 把当前文档序列化成 `.pcraft` 字节，并内嵌缩略图与合成预览。
    pub fn save_project(&self) -> Result<Vec<u8>> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let doc = &self.document_for_save()?;
        let opts = photocraft_format::SaveOptions {
            thumbnail: Some(photocraft_compose::thumbnail(doc, PROJECT_THUMBNAIL_SIDE)),
            composite: Some(photocraft_compose::thumbnail(doc, PROJECT_PREVIEW_SIDE)),
        };
        photocraft_format::save_to_bytes(doc, &opts).map_err(|e| EditorError::SaveFailed(e.to_string()))
    }

    fn preview_document(&self) -> Result<&photocraft_doc::Document> {
        // 草稿优先级：构图/滤镜/修饰/选区（P5–P7）→ 属性/调整/文字/变换（P0）→ 活动笔迹。
        if let Some(doc) = self.compose_draft.as_ref().map(|draft| draft.document.as_ref()) {
            return Ok(doc);
        }
        if let Some(doc) = self.filter_draft.as_ref().map(|draft| draft.document.as_ref()) {
            return Ok(doc);
        }
        if let Some(doc) = self.retouch_preview.as_deref() {
            return Ok(doc);
        }
        if let Some(doc) = self.selection_draft.as_ref().map(|draft| draft.document.as_ref()) {
            return Ok(doc);
        }
        if let Some(doc) = self.layer_properties_preview.as_ref().map(|draft| draft.doc.as_ref()) {
            return Ok(doc);
        }
        if let Some(doc) = self.adjustment_preview.as_ref().map(|draft| draft.doc.as_ref()) {
            return Ok(doc);
        }
        if let Some(doc) = self.text_preview.as_ref().map(|draft| draft.doc.as_ref()) {
            return Ok(doc);
        }
        if let Some(doc) = self.transform_preview.as_ref().map(|draft| draft.doc.as_ref()) {
            return Ok(doc);
        }
        if let Some((live, _)) = &self.live_stroke {
            return Ok(live.doc.as_ref());
        }
        Ok(&self.active_doc()?.doc)
    }

    fn preview_mask_layer(&self) -> Result<Option<photocraft_doc::LayerId>> {
        Ok(photocraft_engine::mask_view_cmds::current(self.active_doc()?)
            .filter(|_|self.text_preview.is_none() && self.adjustment_preview.is_none() && self.layer_properties_preview.is_none())
            .map(|shown|shown.layer))
    }

    /// 合成当前文档为 RGBA8 预览像素。
    pub fn render_preview(&self, max_side: u32) -> Result<Preview> {
        let doc = self.preview_document()?;
        if let Some(layer)=self.preview_mask_layer()? {
            return crate::layer_preview::isolated(doc,layer,true,max_side.clamp(1,MAX_PREVIEW_SIDE));
        }
        let image = photocraft_compose::thumbnail(doc, max_side.clamp(1, MAX_PREVIEW_SIDE));
        Ok(Preview { width: image.width, height: image.height, pixels: image.pixels })
    }

    /// 只合成指定文档区域，输出一源像素对应一个 RGBA8 像素，不缩放整图。
    pub fn render_region(&self, params: Value) -> Result<Preview> {
        crate::region_preview::render(self.preview_document()?,self.preview_mask_layer()?,params)
    }

    /// 画板/切片导出计划（U56）：只给「文件名 + 文档矩形」，不写盘。
    ///
    /// 分离计划与渲染，是因为写盘属于宿主端口（浏览器没有任意路径权限），而范围与命名属于
    /// 内核语义。调用方拿到计划后按 `rect` 逐项取像素，再交给自己的文件通道。
    pub fn composition_export_plan(&self, kind: &str) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let doc = &self.active_doc()?.doc;
        crate::composition_workflows::export_plan(doc, kind, &Value::Null)
    }

    /// 把计划里的一项导出成 PNG 字节（U56）。
    ///
    /// 编码留在内核：`render_region` 给的是 RGBA8 源像素，而 PNG 编码器只在这一侧有。让宿主
    /// 自己编码会引出第二套编码器，字节与整图导出一致性也就无人保证。
    pub fn composition_export_png(&self, rect: Value) -> Result<Vec<u8>> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let preview = self.render_region(rect)?;
        let image = photocraft_codecs::Image::from_u8(
            preview.width,
            preview.height,
            photocraft_codecs::ChannelLayout::Rgba,
            preview.pixels,
        )
        .map_err(|error| EditorError::RenderFailed(error.to_string()))?;
        photocraft_codecs::encode(&image, photocraft_codecs::Format::Png, &Default::default())
            .map_err(|error| EditorError::RenderFailed(error.to_string()))
    }

    /// 图层与蒙版缩略图按文档范围隔离，最多 64px；隐藏层仍可查看内容。
    pub fn layer_thumbnail(&self, layer: u64, mask: bool, max_side: u32) -> Result<Preview> {
        crate::layer_preview::isolated(&self.active_doc()?.doc,photocraft_doc::LayerId(layer),mask,max_side.clamp(1,64))
    }

    /// 吸管读取源像素处的可见合成，不采样缩略预览，也不修改文档。
    pub fn sample_color(&self, x: f64, y: f64) -> Result<Option<String>> {
        self.require_no_stroke()?;
        let doc = &self.active_doc()?.doc;
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x >= doc.size.width as f64 || y >= doc.size.height as f64 {
            return Ok(None);
        }
        if let Some(shown)=photocraft_engine::mask_view_cmds::current(self.active_doc()?) {
            if let Some(mask)=doc.layer(shown.layer).and_then(|layer|layer.mask.as_ref()) {
                let gray=(mask.surface.sample_channel(x.floor() as i32,y.floor() as i32,0).clamp(0.0,1.0)*255.0).round() as u8;
                return Ok(Some(format!("#{gray:02x}{gray:02x}{gray:02x}")));
            }
        }
        let pixel = photocraft_compose::render(doc, photocraft_geom::Rect::from_xywh(x.floor() as i32, y.floor() as i32, 1, 1)).to_rgba8();
        let rgba = &pixel.pixels;
        Ok((rgba[3] != 0).then(|| format!("#{:02x}{:02x}{:02x}", rgba[0], rgba[1], rgba[2])))
    }

    pub(super) fn require_no_stroke(&self) -> Result<()> {
        if self.layer_properties_preview.is_some() {return Err(crate::layer_properties_preview::error("请先确认或取消图层属性编辑"));}
        if self.adjustment_preview.is_some() { return Err(crate::adjustment_preview::error("请先确认或取消调整参数编辑")); }
        if self.text_preview.is_some() { return Err(crate::text_preview::error("请先确认或取消文字编辑")); }
        if self.transform_preview.is_some() { return Err(crate::transform_preview::error("请先确认或取消自由变换")); }
        if self.live_stroke.is_some() { return Err(Self::stroke_error("请先结束或取消当前笔迹")); }
        Ok(())
    }

    /// 笔刷库写入口的附加门禁：有草稿时改库会让预览与库不一致。
    fn require_no_brush_gesture(&self) -> Result<()> {
        if self.layer_properties_preview.is_some()
            || self.adjustment_preview.is_some()
            || self.text_preview.is_some()
            || self.transform_preview.is_some()
        {
            return Err(Self::brush_error("请先确认或取消当前草稿再修改笔刷库"));
        }
        Ok(())
    }

    /// P5/P6/P7 草稿门禁：任何内容写入前都要先结算这些草稿。
    pub(super) fn require_no_tool_draft(&self) -> Result<()> {
        if self.compose_draft.is_some() {
            return Err(command_error_for("image.compose", "请先确认或取消构图修改"));
        }
        if self.filter_draft.is_some() {
            return Err(command_error_for("filter.draft", "请先确认或取消滤镜草稿"));
        }
        if self.retouch_baseline.is_some() {
            return Err(command_error_for("paint.retouch", "请先结束或取消当前修饰笔迹"));
        }
        if self.selection_draft.is_some() {
            return Err(command_error_for("select.modify", "请先确认或取消选区修改"));
        }
        Ok(())
    }

    /// 冻结导出：一次同步调用内取齐修订、指纹、尺寸与成对产物。
    pub fn export_bundle(&self) -> Result<ExportBundle> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let doc = &state.doc;
        let content_hash = document_content::document_content_hash(doc, &self.registry).ok_or(EditorError::NoDocument)?;
        // 视图数据与像素内容同批冻结：采样点写进工程字节，但内容指纹仍只算图层与画布。
        let saved = self.document_for_save()?;
        let project = photocraft_format::save_to_bytes(
            &saved,
            &photocraft_format::SaveOptions {
                thumbnail: Some(photocraft_compose::thumbnail(doc, PROJECT_THUMBNAIL_SIDE)),
                composite: Some(photocraft_compose::thumbnail(doc, PROJECT_PREVIEW_SIDE)),
            },
        )
        .map_err(|e| EditorError::SaveFailed(e.to_string()))?;
        let output = photocraft_io::export(doc, "png", &photocraft_io::ExportOptions::default())
            .map_err(|e| EditorError::SaveFailed(e.to_string()))?
            .bytes;
        Ok(ExportBundle {
            revision: state.revision,
            document_content_hash: content_hash,
            canvas_width: doc.size.width.max(1),
            canvas_height: doc.size.height.max(1),
            project,
            output,
        })
    }

    /// 当前修订号（冻结时核对该值）。
    pub fn revision(&self) -> Result<u64> {
        Ok(self.active_doc()?.revision)
    }

    /// 当前文档的内容指纹（与 `web/contracts` 的 `documentContentHash` 逐字节一致）。
    pub fn content_hash(&self) -> Result<String> {
        let doc = &self.active_doc()?.doc;
        document_content::document_content_hash(doc, &self.registry).ok_or(EditorError::NoDocument)
    }

    /// 当前文档的资产登记表（宿主保存时写进 imageEdit 描述符）。
    pub fn asset_ids(&self) -> Value {
        json!({
            "baseAssetId": self.registry.base_asset_id,
            "placed": self.registry.placed.iter().map(|(layer, asset)| json!({"layerId": layer, "assetId": asset})).collect::<Vec<_>>(),
        })
    }

    /// 命令注册表快照（含启用状态与首期能力门）。React 用它渲染菜单/工具栏/快捷键。
    pub fn commands(&self) -> Value {
        Value::Array(
            photocraft_engine::command_specs()
                .iter()
                .map(|c| {
                    let mut entry =
                        photocraft_engine::commands::list_entry(&self.session, c,
                            if crate::clipboard_commands::IDS.contains(&c.id) {crate::clipboard_commands::disabled_reason(&self.session,c.id)} else {self.session.disabled_reason(c.id)}
                                .or_else(|| crate::mask_commands::creation_reason(&self.session, c.id, &Value::Null))
                                .or_else(|| crate::layer_locks::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::layer_layout::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::clipping_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::fill_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::clipboard_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::group_commands::disabled_reason(&self.session,c.id)));
                    if let Some(obj) = entry.as_object_mut() {
                        obj.insert("allowed".into(), json!(crate::capability::command_allowed(c.id)));
                        if crate::clipboard_commands::IDS.contains(&c.id) {
                            obj.insert("params".into(),json!(if c.id=="edit.cut" {r##"{"color":"#rrggbb"} (host background color; current target)"##} else if c.id=="edit.paste" {"{center:[x,y]?} (internal document clipboard; current target)"} else {"{} (internal document clipboard; current target)"}));
                        }
                        if crate::fill_commands::IDS.contains(&c.id) {
                            obj.insert("menu".into(),json!(["Edit"]));
                            obj.insert("params".into(),json!(r##"{"color":"#rrggbb"} (active layer or mask)"##));
                        }
                    }
                    entry
                })
                .collect(),
        )
    }

    /// 首期允许的命令 id 列表。
    pub fn allowed_command_ids(&self) -> Value {
        json!(crate::capability::allowed_command_ids())
    }

    /// 分阶段能力协商快照：阶段与能力清单（UI 核对后决定是否可写）。
    pub fn capability_handshake(&self) -> Value {
        json!({
            "stages": crate::capability::DELIVERED_STAGES,
            "capabilities": crate::capability::delivered_capabilities(),
            "allStages": crate::capability::STAGES,
            "nonGoals": crate::capability::NON_GOALS,
        })
    }

    /// 执行一条命令；这是 React 驱动引擎的唯一写入口。
    ///
    /// 未列入首期白名单的命令一律拒绝（阻止通过快捷键/命令面板绕过工具栏）。
    pub fn execute(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        // 按图像模式收紧其他域的写入命令（change: 2026-10-22-add-photocraft-image-mode-workflows）。
        // 位置在唯一命令门之后、任何草稿/预览分支之前：快捷键、命令面板与宿主脚本都无法绕过。
        if let Some(state) = self.session.active() {
            crate::features::modes::gate::check(&state.doc, id, &params)?;
        }
        if crate::group_commands::IDS.contains(&id) { return crate::group_commands::execute(&mut self.session, id, params); }
        crate::group_commands::check(&self.session, id, &params)?;
        if crate::clipboard_commands::IDS.contains(&id) {return crate::clipboard_commands::execute(&mut self.session,id,&params);}
        if crate::fill_commands::IDS.contains(&id) {return crate::fill_commands::execute(&mut self.session,id,&params);}
        crate::clipping_commands::check(&self.session,id,&params)?;
        crate::layer_locks::check(&self.session,id,&params)?;
        crate::layer_layout::check(&self.session,id,&params)?;
        if id == "layer.moveTo" { crate::layer_preview::check_reorder_depth(self.active_doc()?, &params)?; }
        if (id == "layer.duplicate" && params.get("layer").is_none())
            || (id == "layer.new.layerViaCopy" && self.active_doc()?.doc.selection.is_none()) {
            let state = self.active_doc()?;
            self.check_layer_capacity_for(crate::layer_preview::target_layer_count(&state.doc, &crate::layer_preview::selected_roots(state)))?;
        } else if id == "layer.duplicate" {
            let state = self.active_doc()?;
            let targets: Vec<_> = params.get("layer").and_then(Value::as_u64).map(photocraft_doc::LayerId).into_iter().collect();
            self.check_layer_capacity_for(crate::layer_preview::target_layer_count(&state.doc, &targets))?;
        } else if matches!(id, "layer.new.layer" | "layer.new.layerViaCopy" | "layer.duplicate" | "type.create") || id.starts_with("layer.newAdjustmentLayer.") {
            self.check_layer_capacity()?;
        }
        if id == "layer.moveTo" && params.get("copy").and_then(Value::as_bool) == Some(true) {
            let state = self.active_doc()?;
            let targets: Vec<_> = if let Some(layers) = params.get("layers").and_then(Value::as_array) {
                layers.iter().filter_map(Value::as_u64).map(photocraft_doc::LayerId).collect()
            } else {
                params.get("layer").and_then(Value::as_u64).map(photocraft_doc::LayerId).or(state.active_layer).into_iter().collect()
            };
            let count = crate::layer_preview::target_layer_count(&state.doc, &targets);
            self.check_layer_capacity_for(count)?;
        }
        if let Some(message) = crate::mask_commands::creation_reason(&self.session, id, &params) {
            return Err(EditorError::CommandFailed { id: id.into(), message });
        }
        let target_active_mask = crate::mask_commands::creates_on_active(&self.session,id,&params);
        let result = self.session.execute(id, params).map_err(|e| EditorError::CommandFailed { id: id.into(), message: e.to_string() })?;
        if target_active_mask {
            self.session.execute("channel.target.layerMask", Value::Null)
                .map_err(|e| EditorError::CommandFailed { id: id.into(), message: e.to_string() })?;
        }
        Ok(result)
    }

    /// 撤销一步。
    pub fn undo(&mut self) -> Result<Value> {
        self.execute("edit.undo", Value::Null)
    }

    /// 重做一步。
    pub fn redo(&mut self) -> Result<Value> {
        self.execute("edit.redo", Value::Null)
    }

    /// 完整状态：会话信息 + 活动文档（图层树、选区、历史、修订）。
    pub fn state(&self) -> Value {
        json!({
            "session": inspect::session(&self.session),
            "document": self.session.active().map(Self::document_json),
        })
    }

    /// 是否已有活动文档。
    pub fn has_document(&self) -> bool {
        self.session.active().is_some()
    }

    /// 关闭活动文档（释放像素与历史）。
    pub fn close(&mut self) -> Value {
        self.cancel_layer_properties();
        self.cancel_adjustment();
        self.cancel_text();
        self.cancel_stroke();
        self.cancel_transform();
        self.cancel_selection_modify();
        self.cancel_retouch();
        self.cancel_filter();
        self.cancel_compose();
        self.smart_child.clear();
        if let Some(index) = self.session.active_index() {
            self.session.close(index);
        }
        self.state()
    }

    pub(super) fn active_doc(&self) -> Result<&photocraft_engine::DocState> {
        self.session.active().ok_or(EditorError::NoDocument)
    }

    fn validate_image_size(width: u32, height: u32) -> Result<()> {
        if width == 0 || height == 0 || width > 8192 || height > 8192 || u64::from(width) * u64::from(height) > 67_108_864 {
            return Err(EditorError::ImportFailed("图片超过首期尺寸上限（单边 8192 像素）".into()));
        }
        Ok(())
    }

    fn check_layer_capacity(&self) -> Result<()> {
        self.check_layer_capacity_for(1)
    }

    fn check_layer_capacity_for(&self,additional:usize) -> Result<()> {
        if crate::layer_preview::layer_count(&self.active_doc()?.doc.layers).saturating_add(additional)>photocraft_project_verify::MAX_LAYERS {
            return Err(EditorError::CommandFailed { id: "layer.new".into(), message: "图层已达首期上限（64 层）".into() });
        }
        Ok(())
    }

    pub(super) fn active_layer_id(&self) -> Option<photocraft_doc::LayerId> {
        self.session.active().and_then(|d| d.active_layer)
    }

    // 补齐操作历史的前进分支，保持上游快照不变。
    fn document_json(doc: &photocraft_engine::DocState) -> Value {
        let mut value = inspect::document(doc);
        let frame=crate::layer_preview::transform_frame(doc);
        value["transformFrame"] = if frame.is_empty() {Value::Null} else {json!([frame.x0,frame.y0,frame.x1,frame.y1])};
        value["editTarget"]=json!(if crate::layer_preview::mask_target(doc) {"mask"} else {"pixels"});
        fn mask_state(rows: &mut Value, document: &photocraft_doc::Document) {
            if let Some(rows)=rows.as_array_mut() { for row in rows {
                if let Some(layer)=row["id"].as_u64().and_then(|id|document.layer(photocraft_doc::LayerId(id))) {
                    row["locks"]=json!(layer.locks);
                    row["effectiveLocks"]=json!(document.effective_locks(layer.id));
                }
                if let Some(mask)=row["id"].as_u64().and_then(|id|document.layer(photocraft_doc::LayerId(id))).and_then(|layer|layer.mask.as_ref()) {
                    row["maskEnabled"]=json!(mask.enabled); row["maskLinked"]=json!(mask.linked);
                }
                if let Some(children)=row.get_mut("children") {mask_state(children,document);}
            }}
        }
        mask_state(&mut value["layers"],&doc.doc);
        value["selectionFrame"] = doc.doc.selection.as_ref().and_then(|selection| {
            let rect = selection.content_bounds();
            (!rect.is_empty()).then(|| json!([rect.x0,rect.y0,rect.x1,rect.y1]))
        }).unwrap_or(Value::Null);
        value["redoHistory"] = json!(doc.history.redo_labels().collect::<Vec<_>>());
        // 只投影活动文字层的首个样式，不在宿主复制可写文字模型。
        value["activeTextStyle"] = doc.active_layer.and_then(|id| doc.doc.layer(id)).and_then(|layer| {
            let photocraft_doc::LayerContent::Text(text) = &layer.content else { return None; };
            let runs = text.char_runs();
            let paragraphs = text.paragraph_runs();
            Some(json!({ "character": runs.first().map(|run| &run.style),
                "paragraph": paragraphs.first().map(|run| &run.style) }))
        }).unwrap_or(Value::Null);
        value["selectionOutline"] = json!(doc.doc.selection.as_ref().map(crate::selection_outline::selection_outline).unwrap_or_default());
        value
    }

    /// 活动文档的 JSON 视图（`state()` 的 `document` 字段）。
    fn active_json(&self) -> Result<Value> {
        let doc = self.active_doc()?;
        Ok(json!({
            "session": inspect::session(&self.session),
            "document": Self::document_json(doc),
        }))
    }
}

#[cfg(test)]
#[path = "features/layers/tests_pattern_library_interaction.rs"]
mod pattern_library_interaction_tests;

#[cfg(test)]
#[path = "editor/tests_interaction.rs"]
mod interaction_tests;

#[cfg(test)]
#[path = "features/selections/tests_stroke_selection.rs"]
mod stroke_selection_tests;

#[cfg(test)]
#[path = "features/selections/tests_mask_creation.rs"]
mod mask_creation_tests;

#[cfg(test)]
#[path = "features/smart/tests_smart_entry.rs"]
mod smart_entry_tests;

#[cfg(test)]
#[path = "features/painting/tests_brush_library.rs"]
mod brush_library_tests;

#[cfg(test)]
#[path = "features/layers/tests_transfer.rs"]
mod transfer_tests;

#[path = "features/painting/editor_stroke.rs"]
mod stroke;
#[path = "features/layers/editor_properties.rs"]
mod properties;
#[path = "features/type/editor_text.rs"]
mod text;
#[path = "features/composition/editor_transform.rs"]
mod transform;
#[path = "features/painting/editor_brush.rs"]
mod brush;
#[path = "features/layers/editor_transfer.rs"]
mod transfer;
#[path = "features/io/editor_psd.rs"]
mod psd;
mod tools;

#[path = "features/adjustments/editor_adjustment.rs"]
mod adjustment_feature;
