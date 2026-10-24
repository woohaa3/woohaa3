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

mod scripts;
mod duplicate;

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
    history_follow:crate::history_follow::HistoryFollowKey,
    session: Session,
    pattern_library: crate::pattern_library::PatternLibrary,
    registry: AssetRegistry,
    live_stroke: Option<(photocraft_engine::brush_cmds::LiveStroke, Value, &'static str, Option<[f32;4]>)>,
    stroke_damage: photocraft_geom::Rect,
    transform_preview: Option<crate::transform_preview::TransformPreview>,
    text_preview: Option<crate::text_preview::TextPreview>,
    rotation_preview:Option<crate::image_geometry_commands::RotationPreview>,
    adjustment_preview: Option<crate::adjustment_preview::AdjustmentPreview>,
    layer_properties_preview: Option<crate::layer_properties_preview::LayerPropertiesPreview>,
    reorder_preview: Option<crate::reorder_preview::ReorderPreview>,
}

impl Default for Editor {
    fn default() -> Self {
        Self::new()
    }
}

impl Editor {
    /// 新建一个空会话。
    pub fn new() -> Self {
        Self { history_follow:Default::default(),session: Session::new(), pattern_library:Default::default(), registry: AssetRegistry::default(), live_stroke: None, stroke_damage:photocraft_geom::Rect::EMPTY, transform_preview: None, text_preview: None, adjustment_preview: None, rotation_preview:None, layer_properties_preview: None, reorder_preview: None }
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
        if !photocraft_format::is_pcraft(bytes) {
            return Err(EditorError::NotAProject);
        }
        photocraft_project_verify::verify(bytes).map_err(|e| EditorError::LoadFailed(e.message))?;
        let doc = photocraft_format::load_from_bytes(bytes).map_err(|e| EditorError::LoadFailed(e.to_string()))?;
        self.registry.clear();
        self.registry.base_asset_id = base_asset_id.map(str::to_string);
        let index = self.session.add_document(doc, None);
        self.session.set_active(index);
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

    /// 把当前文档序列化成 `.pcraft` 字节，并内嵌缩略图与合成预览。
    pub fn save_project(&self) -> Result<Vec<u8>> {
        self.require_no_stroke()?;
        let doc = &self.active_doc()?.doc;
        let opts = photocraft_format::SaveOptions {
            thumbnail: Some(photocraft_compose::thumbnail(doc, PROJECT_THUMBNAIL_SIDE)),
            composite: Some(photocraft_compose::thumbnail(doc, PROJECT_PREVIEW_SIDE)),
        };
        photocraft_format::save_to_bytes(doc, &opts).map_err(|e| EditorError::SaveFailed(e.to_string()))
    }

    fn preview_document(&self) -> Result<&photocraft_doc::Document> {
        Ok(self.rotation_preview.as_ref().map(|draft| &draft.doc).or_else(||self.layer_properties_preview.as_ref().map(|draft| &draft.doc)).or_else(||self.adjustment_preview.as_ref().map(|draft| &draft.doc)).or_else(|| self.text_preview.as_ref().map(|draft| &draft.doc)).or_else(|| self.transform_preview.as_ref().map(|draft| &draft.doc))
            .or_else(|| self.reorder_preview.as_ref().and_then(|draft| draft.doc.as_ref()))
            .or_else(|| self.live_stroke.as_ref().map(|(live, _,_,_)| &live.doc)).unwrap_or(&self.active_doc()?.doc))
    }

    fn preview_mask_layer(&self) -> Result<Option<photocraft_doc::LayerId>> {
        Ok(photocraft_engine::mask_view_cmds::current(self.active_doc()?)
            .filter(|_|self.rotation_preview.is_none() && self.text_preview.is_none() && self.adjustment_preview.is_none() && self.layer_properties_preview.is_none())
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

    /// 图层与蒙版缩略图按文档范围隔离，最多 64px；隐藏层仍可查看内容。
    pub fn layer_thumbnail(&self, layer: u64, mask: bool, max_side: u32) -> Result<Preview> {
        crate::layer_preview::isolated(&self.active_doc()?.doc,photocraft_doc::LayerId(layer),mask,max_side.clamp(1,64))
    }

    /// 吸管读取源像素处的可见合成，不采样缩略预览，也不修改文档。
    pub fn sample_color(&self, x: f64, y: f64) -> Result<Option<String>> {
        self.require_no_stroke()?;self.active_doc()?;
        if !x.is_finite() || !y.is_finite(){return Ok(None);}
        self.sample_color_options(json!({"x":x,"y":y}))
    }

    /// Shared native sampling settings for the Eyedropper and temporary painting sampler.
    pub fn sample_color_options(&self, params: Value) -> Result<Option<String>> {
        self.require_no_stroke()?;
        let fail=|message:&str|EditorError::CommandFailed{id:"document.sampleColor".into(),message:message.into()};
        let fields=params.as_object().filter(|fields|fields.keys().all(|key|["x","y","size","sampleLayer"].contains(&key.as_str()))).ok_or_else(||fail("取色参数无效"))?;
        let coordinate=|key:&str|fields.get(key).and_then(Value::as_f64).filter(|n|n.is_finite()).ok_or_else(||fail("取色坐标须为有限数值"));
        let (x,y)=(coordinate("x")?,coordinate("y")?);
        let size=match fields.get("size") {None=>1,Some(value)=>value.as_u64().and_then(|v|u32::try_from(v).ok()).filter(|n|photocraft_engine::sample_cmds::SAMPLE_SIZES.contains(n)).ok_or_else(||fail("取样尺寸无效"))?};
        let source=match fields.get("sampleLayer") {None=>photocraft_engine::sample_cmds::SampleLayers::All,Some(value)=>value.as_str().and_then(photocraft_engine::sample_cmds::SampleLayers::parse).ok_or_else(||fail("取样图层来源无效"))?};
        let state=self.active_doc()?;let doc=&state.doc;
        let Some(rect)=photocraft_engine::sample_cmds::sample_rect(x,y,size,doc.bounds()) else{return Ok(None);};
        if let Some(shown)=photocraft_engine::mask_view_cmds::current(state) {
            if let Some(mask)=doc.layer(shown.layer).and_then(|layer|layer.mask.as_ref()) {
                let mut sum=0.0;for py in rect.y0..rect.y1 {for px in rect.x0..rect.x1 {sum+=mask.surface.sample_channel(px,py,0).clamp(0.0,1.0) as f64;}}
                let gray=(sum/(rect.width() as f64*rect.height() as f64)*255.0).round() as u8;
                return Ok(Some(format!("#{gray:02x}{gray:02x}{gray:02x}")));
            }
        }
        let color=photocraft_engine::sample_cmds::sample_color(doc,state.active_layer,x,y,size,source);
        let byte=|v:f32|(v.clamp(0.0,1.0)*255.0).round() as u8;
        Ok((color[3]>0.0).then(||format!("#{:02x}{:02x}{:02x}",byte(color[0]),byte(color[1]),byte(color[2]))))
    }

    /// 精确命中选区覆盖度；轮廓仅作显示，不参与羽化边缘或稀疏细节的交互判断。
    pub fn selection_contains(&self,x:f64,y:f64)->Result<bool> {
        let state=self.active_doc()?;
        if !x.is_finite() || !y.is_finite() {return Err(crate::transform_preview::error("选区命中坐标必须为有限数值"));}
        if x<0. || y<0. || x>=state.doc.size.width as f64 || y>=state.doc.size.height as f64 {return Ok(false);}
        let Some(selection)=state.doc.selection.as_ref() else {return Ok(false);};
        let mut pixel=[0.0];selection.read_pixel(x.floor() as i32,y.floor() as i32,&mut pixel);Ok(pixel[0]>0.)
    }

    fn require_no_stroke(&self) -> Result<()> {
        if self.rotation_preview.is_some() {return Err(EditorError::CommandFailed{id:"image.rotation.arbitrary".into(),message:"请先确认或取消画布旋转".into()});}
        if self.layer_properties_preview.is_some() {return Err(crate::layer_properties_preview::error("请先确认或取消图层属性编辑"));}
        if self.adjustment_preview.is_some() { return Err(crate::adjustment_preview::error("请先确认或取消调整参数编辑")); }
        if self.text_preview.is_some() { return Err(crate::text_preview::error("请先确认或取消文字编辑")); }
        if self.transform_preview.is_some() { return Err(crate::transform_preview::error("请先确认或取消自由变换")); }
        if self.live_stroke.is_some() { return Err(Self::stroke_error("请先结束或取消当前笔迹")); }
        Ok(())
    }

    /// 文字检查点后的候选与正式文档共享同一Arc，允许导出该稳定内容。
    fn require_export_ready(&self) -> Result<()> {
        if let Some(draft)=self.text_preview.as_ref() {
            draft.require_valid()?;
            if draft.checkpointed && self.rotation_preview.is_none() && self.layer_properties_preview.is_none() && self.adjustment_preview.is_none()
                && self.transform_preview.is_none() && self.live_stroke.is_none()
                && std::sync::Arc::ptr_eq(&draft.doc,&self.active_doc()?.doc) {return Ok(());}
        }
        self.require_no_stroke()
    }

    /// 冻结导出：一次同步调用内取齐修订、指纹、尺寸与成对产物。
    pub fn export_bundle(&self) -> Result<ExportBundle> {
        self.require_export_ready()?;
        let state = self.active_doc()?;
        let doc = &state.doc;
        let content_hash = document_content::document_content_hash(doc, &self.registry).ok_or(EditorError::NoDocument)?;
        let project = photocraft_format::save_to_bytes(
            doc,
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

    /// 按导出的格式与控制编码当前修订（I045）。
    ///
    /// 只编码**当前修订**的合成结果，不写工程、不产生历史；缩放预览按请求重采样。
    pub fn export_image(&self, request: crate::export_request::ExportRequest) -> Result<ExportBundle> {
        self.require_export_ready()?;
        let state=self.active_doc()?;
        let doc=if (request.scale-1.0).abs()<1e-9 { None } else { Some(self.scaled_document(request.scale)?) };
        let source=doc.as_deref().unwrap_or(&state.doc);
        let mut options=photocraft_io::ExportOptions::default();
        options.encode=request.encode_options();
        let exported=photocraft_io::export(source, request.extension(), &options)
            .map_err(|error|EditorError::SaveFailed(error.to_string()))?;
        Ok(ExportBundle {
            revision: state.revision,
            document_content_hash: document_content::document_content_hash(&state.doc, &self.registry).ok_or(EditorError::NoDocument)?,
            canvas_width: source.size.width.max(1),
            canvas_height: source.size.height.max(1),
            project: Vec::new(),
            output: exported.bytes,
        })
    }

    /// 缩放后的临时文档：只用于导出，不进入会话或历史。
    ///
    /// 复用原生 `image.imageSize` 的重采样（同一预算检查与滤波），在隔离会话里进行，
    /// 因此不会改动当前文档、历史或内容身份。
    fn scaled_document(&self, scale:f64) -> Result<std::sync::Arc<photocraft_doc::Document>> {
        let state=self.active_doc()?;
        let width=((f64::from(state.doc.size.width)*scale).round() as u32).max(1);
        let height=((f64::from(state.doc.size.height)*scale).round() as u32).max(1);
        Self::validate_image_size(width,height)?;
        if width==state.doc.size.width && height==state.doc.size.height {return Ok(state.doc.clone());}
        let mut scratch=Session::new();
        scratch.add_document((*state.doc).clone(),None);
        *scratch.active_mut().unwrap()=state.clone();
        scratch.execute("image.imageSize",json!({"width":width,"height":height})).map_err(|error|EditorError::SaveFailed(error.to_string()))?;
        Ok(scratch.active().unwrap().doc.clone())
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
                            if c.id=="select.isolateLayers" && self.session.active().is_some() {crate::layer_selection_commands::disabled_reason(&self.session,c.id)} else if crate::clipboard_commands::IDS.contains(&c.id) {crate::clipboard_commands::disabled_reason(&self.session,c.id)} else {self.session.disabled_reason(c.id)}
                                .or_else(|| if c.id==scripts::ID && self.session.active().is_none(){Some("没有活动文档".into())}else{None})
                                .or_else(|| crate::mask_commands::creation_reason(&self.session, c.id, &Value::Null))
                                .or_else(|| crate::text_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::rasterize_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::flatten_masks_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::bucket_command::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::layer_composite_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::layer_cleanup_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::layer_locks::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::layer_layout::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::clipping_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::fill_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::general_fill::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::edge_stroke::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::text_antialias::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::text_orientation::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::clipboard_commands::disabled_reason(&self.session,c.id))
                                .or_else(|| crate::group_commands::disabled_reason(&self.session,c.id)));
                    if let Some(obj) = entry.as_object_mut() {
                        obj.insert("allowed".into(), json!(crate::capability::command_allowed(c.id)));
                        if c.id=="edit.definePattern" {obj.insert("params".into(),json!(r#"{name:string} (selection or canvas composite; local library only, max 1024px/64 patterns/4194304 total pixels)"#));}
                        if c.id==crate::general_fill::HISTORY_ID {obj.insert("params".into(),json!("{state?:historyIndex} (oldest retained by default; current pixel/mask target only)"));}
                        if c.id==crate::general_fill::ID {obj.insert("params".into(),json!("{contents:foreground|background|color|contentAware|pattern|history|black|gray|white,color?:#rrggbb,pattern?:id,colorAdaptation?:boolean,mode?:blend,opacity?:0..100,preserveTransparency?:boolean,state?:historyIndex} (current pixel/mask target only)"));}
                        if crate::text_antialias::IDS.contains(&c.id) || crate::text_orientation::IDS.contains(&c.id){obj.insert("params".into(),json!("{}; current selected Type layers only"));}
                        if c.id==crate::edge_stroke::ID {obj.insert("params".into(),json!("{width?:number,color:string,location?:inside|center|outside,mode?:string,opacity?:number,preserveTransparency?:boolean}"));}
                        if c.id==crate::text_spelling::ID {obj.insert("params".into(),json!("{action?:list|suggest|change|changeAll|add,allLayers?:boolean,word?:string,replace?:string,layer?:number,start?:number,end?:number,dictionary?:string[],ignore?:string[]}"));}
                        if c.id==crate::text_find_replace::ID {obj.insert("params".into(),json!("{find:string,replace?:string,caseSensitive?:boolean,wholeWord?:boolean,forward?:boolean,allLayers?:boolean,action?:find|change|changeFind|changeAll}"));}
                        if c.id==scripts::ID {obj.insert("params".into(),json!(r#"{name:string,source:string} (UTF-8 JSON/text bytes; no paths)"#));}
                        if crate::clipboard_commands::IDS.contains(&c.id) {
                            obj.insert("params".into(),json!(if c.id=="edit.cut" {r##"{"color":"#rrggbb"} (host pixel background color; active layer pixels)"##} else if matches!(c.id,"edit.paste"|"edit.pasteSpecial.pasteInto"|"edit.pasteSpecial.pasteOutside") {"{center:[x,y]?} (internal document clipboard; current target)"} else {"{} (internal document clipboard; current target)"}));
                        }
                        if crate::fill_commands::IDS.contains(&c.id) {
                            obj.insert("menu".into(),json!(["Edit"]));
                            obj.insert("params".into(),json!(r##"{"color":"#rrggbb"} (active layer or mask)"##));
                        }
                    }
                    entry
                })
                .chain(std::iter::once(crate::clipping_commands::line_entry(&self.session)))
                .collect(),
        )
    }

    pub fn begin_image_rotation(&mut self)->Result<Value> {
        self.require_no_stroke()?;
        let draft=crate::image_geometry_commands::RotationPreview::new(self.active_doc()?);let info=draft.info();self.rotation_preview=Some(draft);Ok(info)
    }
    pub fn preview_image_rotation(&mut self,params:Value)->Result<Value> {
        self.rotation_preview.as_mut().ok_or_else(||EditorError::CommandFailed{id:"image.rotation.arbitrary".into(),message:"没有活动画布旋转".into()})?.update(params)
    }
    pub fn commit_image_rotation(&mut self)->Result<Value> {
        self.rotation_preview.as_ref().ok_or_else(||EditorError::CommandFailed{id:"image.rotation.arbitrary".into(),message:"没有活动画布旋转".into()})?.commit(&mut self.session)?;
        self.rotation_preview=None;self.active_json()
    }
    pub fn cancel_image_rotation(&mut self) {self.rotation_preview=None;}

    /// 开始一次只读的图层重排候选（I218）。
    ///
    /// 候选只在内存里按落点重算合成；正式 `layer.moveTo` 仍由调用方在释放时执行一次。
    pub fn begin_reorder_preview(&mut self)->Result<Value> {
        self.require_no_stroke()?;
        let state=self.active_doc()?;
        if crate::capability::command_allowed("layer.moveTo")==false {return Err(EditorError::CapabilityDisabled("layer.moveTo".into()));}
        self.reorder_preview=Some(crate::reorder_preview::ReorderPreview::new(state));
        Ok(json!({"active":false}))
    }

    /// 更新候选落点；失败时保留上一次有效候选（与上游拖动预览一致）。
    pub fn preview_reorder(&mut self,params:Value)->Result<Value> {
        self.reorder_preview.as_mut().ok_or_else(||EditorError::CommandFailed{id:"layer.moveTo".into(),message:"没有活动的图层重排预览".into()})?.preview(params)
    }

    /// 结束候选：无论确认与否都不写正式文档；返回是否有过有效候选。
    pub fn end_reorder_preview(&mut self)->Value {
        let active=self.reorder_preview.as_ref().is_some_and(crate::reorder_preview::ReorderPreview::is_active);
        self.reorder_preview=None;
        json!({"active":active})
    }

    /// 本机性能偏好不属于工程内容；更新各文档上限，后续编辑裁剪，不修改修订。
    pub fn set_history_limit(&mut self,limit:u32)->Result<Value> {
        self.require_no_stroke()?;
        if !(1..=1000).contains(&limit) {return Err(EditorError::CommandFailed{id:"preferences.historyStates".into(),message:"历史状态数量须为 1–1000 的整数".into()});}
        self.session.edit_prefs(|prefs|prefs.performance.history_states=limit);
        Ok(json!({"historyStates":limit}))
    }

    /// One atomic local performance candidate; never a document edit or a memory reservation.
    pub fn set_performance_preferences(&mut self, history_states:u32, memory_usage_mb:u32)->Result<Value> {
        self.require_no_stroke()?;
        if !(1..=1000).contains(&history_states) || !(256..=1_048_576).contains(&memory_usage_mb) {
            return Err(EditorError::CommandFailed{id:"preferences.performance".into(),message:"历史状态须为1–1000，内存预算须为256–1048576 MB的整数".into()});
        }
        self.session.edit_prefs(|prefs|{prefs.performance.history_states=history_states;prefs.performance.memory_usage_mb=memory_usage_mb;});
        Ok(json!({"historyStates":history_states,"memoryUsageMb":memory_usage_mb}))
    }

    /// Internal image clipboard geometry only; no pixels, OS service or document write.
    pub fn clipboard_bounds(&self)->Option<[i32;4]> {self.session.clipboard.as_ref().map(|clip|clip.bounds).filter(|bounds|!bounds.is_empty()).map(|bounds|[bounds.x0,bounds.y0,bounds.x1,bounds.y1])}

    /// 首期允许的命令 id 列表。
    pub fn allowed_command_ids(&self) -> Value {
        json!(crate::capability::allowed_command_ids())
    }

    /// 执行一条命令；这是 React 驱动引擎的唯一写入口。
    ///
    /// 未列入首期白名单的命令一律拒绝（阻止通过快捷键/命令面板绕过工具栏）。
    pub fn execute(&mut self, id: &str, mut params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        if id=="edit.definePattern" {return self.define_pattern(params);}
        if id==crate::general_fill::HISTORY_ID {return crate::general_fill::execute_history(&mut self.session,params);}
        if id==crate::general_fill::ID {return crate::general_fill::execute(&mut self.session,params,&self.pattern_library.patterns());}
        if crate::text_orientation::IDS.contains(&id){return crate::text_orientation::execute(&mut self.session,id,params);}
        if crate::text_antialias::IDS.contains(&id){return crate::text_antialias::execute(&mut self.session,id,params);}
        if id==crate::edge_stroke::ID {return crate::edge_stroke::execute(&mut self.session,params);}
        if id==crate::text_spelling::ID {return crate::text_spelling::execute(&mut self.session,params);}
        if id==crate::text_find_replace::ID {return crate::text_find_replace::execute(&mut self.session,params);}
        if id==scripts::ID {return self.execute_byte_script(params);}
        if id.starts_with("edit.purge.") {
            if !params.is_null() && !params.as_object().is_some_and(|fields|fields.is_empty()) {return Err(EditorError::CommandFailed{id:id.into(),message:"清理命令不接受额外参数".into()});}
            if let Some(state)=self.session.active_mut() {state.coalesce=None;}
        }
        if id=="layer.layerMask.edit" {
            let fail=|message:&str|EditorError::CommandFailed{id:id.into(),message:message.into()};
            let fields=params.as_object().filter(|fields|fields.keys().all(|key|["layer","document","density","feather"].contains(&key.as_str()))).ok_or_else(||fail("蒙版属性包含未知参数"))?;
            let state=self.active_doc()?;
            if fields.get("document").is_some_and(|value|value.as_u64()!=Some(state.doc.id.0)) {return Err(fail("目标文档已变化"));}
            let layer=match fields.get("layer") {Some(value)=>value.as_u64().ok_or_else(||fail("图层编号无效"))?,None=>state.active_layer.ok_or_else(||fail("没有活动图层"))?.0};
            let mut mask=serde_json::Map::new();
            if let Some(value)=fields.get("density") {let density=value.as_f64().filter(|v|v.is_finite() && (0.0..=100.0).contains(v)).ok_or_else(||fail("密度须为 0–100%"))?;mask.insert("density".into(),json!(density/100.0));}
            if let Some(value)=fields.get("feather") {mask.insert("feather".into(),value.clone());}
            let mut draft=crate::layer_properties_preview::LayerPropertiesPreview::new(state,layer)?;
            draft.update(json!({"mask":mask}))?;draft.commit(&mut self.session)?;
            return self.active_json();
        }
        if matches!(id,crate::text_commands::RESOLVE_FONTS|crate::text_commands::REPLACE_FONTS){return crate::text_commands::replace_fonts(&mut self.session,id,params);}
        if matches!(id,crate::text_commands::SAVE_DEFAULTS|crate::text_commands::LOAD_DEFAULTS){return crate::text_commands::defaults(&mut self.session,id,params);}
        if id==crate::flatten_masks_commands::ID{return crate::flatten_masks_commands::execute(&mut self.session,params);}
        if crate::rasterize_commands::IDS.contains(&id){return crate::rasterize_commands::execute(&mut self.session,id,params);}
        if id==crate::text_commands::REFRESH{return crate::text_commands::refresh(&mut self.session,params);}
        if crate::history_commands::IDS.contains(&id) {return crate::history_commands::execute(&mut self.session,id,params);}
        if crate::painting_symmetry::IDS.contains(&id) {crate::painting_symmetry::execute(&mut self.session,id,params)?;return self.active_json();}
        if id=="paint.bucket" {return crate::bucket_command::execute(&mut self.session,params,&self.pattern_library.patterns());}
        if crate::image_extent_commands::IDS.contains(&id){return crate::image_extent_commands::execute(&mut self.session,id,params);}
        if crate::image_geometry_commands::IDS.contains(&id) {return crate::image_geometry_commands::execute(&mut self.session,id,params);}
        if crate::layer_composite_commands::IDS.contains(&id) {return crate::layer_composite_commands::execute(&mut self.session,id,params);}
        if crate::layer_cleanup_commands::IDS.contains(&id) {return crate::layer_cleanup_commands::execute(&mut self.session,id,&params);}
        if crate::layer_selection_commands::IDS.contains(&id) {return crate::layer_selection_commands::execute(&mut self.session,id,&params);}
        if id==crate::clipping_commands::LINE_ID {return crate::clipping_commands::toggle_line(&mut self.session,&params);}
        if crate::group_commands::IDS.contains(&id) { return crate::group_commands::execute(&mut self.session, id, params); }
        crate::group_commands::check(&self.session, id, &params)?;
        if crate::clipboard_commands::IDS.contains(&id) {return crate::clipboard_commands::execute(&mut self.session,id,&params);}
        if crate::fill_commands::IDS.contains(&id) {return crate::fill_commands::execute(&mut self.session,id,&params);}
        if id=="layer.new.layerViaCut" {crate::layer_locks::check_via_cut(&self.session,&params)?;}
        if id=="tools.setBrush" {
            if let Some(message)=crate::brush_prefs_check::invalid(&params) {return Err(EditorError::CommandFailed{id:id.into(),message});}
        }
        if id=="paint.stroke" || id=="paint.pencil" {Self::check_paint_mode(&params)?;let state=self.active_doc()?;crate::layer_preview::require_visible(state,&params["layer"].as_u64().map(photocraft_doc::LayerId).or(state.active_layer).into_iter().collect::<Vec<_>>(),id)?;}
        if id.starts_with("image.adjustments.") || id=="edit.fade" {
            if let Some(message)=crate::adjust_params_check::invalid(id,&params) {return Err(EditorError::CommandFailed{id:id.into(),message});}
        }
        if matches!(id,"paint.colorReplacement"|"paint.mixerBrush"|"paint.patternStamp"|"paint.historyBrush"|"paint.cloneStamp"|"paint.healingBrush"|"paint.dodge"|"paint.burn"|"paint.sponge"|"paint.blur"|"paint.sharpen"|"paint.smudge"|"paint.spotHealing"|"paint.backgroundEraser"|"paint.redEye"|"paint.magicEraser") {
            if let Some(message)=crate::retouch_params::invalid(id,&params) {return Err(EditorError::CommandFailed{id:id.into(),message});}
        }
        if id=="select.magicWand" {
            let fields=params.as_object().ok_or_else(||crate::transform_preview::error("魔棒参数必须为对象"))?;
            if fields.keys().any(|key|!["x","y","tolerance","contiguous","antiAlias","sampleAllLayers","mode"].contains(&key.as_str()))
                || ["x","y"].iter().any(|key|params[*key].as_f64().is_none_or(|n|!n.is_finite() || n.abs()>i32::MAX as f64))
                || params.get("tolerance").is_some_and(|value|value.as_f64().is_none_or(|n|!n.is_finite() || !(0.0..=255.0).contains(&n)))
                || ["contiguous","antiAlias","sampleAllLayers"].iter().any(|key|params.get(*key).is_some_and(|value|!value.is_boolean()))
                || params.get("mode").is_some_and(|value|!matches!(value.as_str(),Some("replace"|"add"|"subtract"|"intersect"))) {return Err(crate::transform_preview::error("魔棒坐标、容差、布尔或运算参数无效"));}
        }
        if id=="select.colorRange" {
            let fields=params.as_object().ok_or_else(||crate::transform_preview::error("颜色范围参数必须为对象"))?;
            let allowed=["select","color","colors","points","subtractPoints","order","fuzziness","detectFaces","localized","range","tonalRange","invert","sampleAllLayers","mode"];
            if fields.keys().any(|key|!allowed.contains(&key.as_str()))
                || params.get("fuzziness").is_some_and(|value|value.as_f64().is_none_or(|n|!n.is_finite() || n<0.0 || n>200.0))
                || params.get("range").is_some_and(|value|value.as_f64().is_none_or(|n|!n.is_finite() || !(0.0..=100.0).contains(&n)))
                || params.get("invert").is_some_and(|value|!value.is_boolean())
                || params.get("localized").is_some_and(|value|!value.is_boolean())
                || params.get("sampleAllLayers").is_some_and(|value|!value.is_boolean())
                || params.get("detectFaces").is_some_and(|value|value!=false)
                || params.get("mode").is_some_and(|value|!matches!(value.as_str(),Some("replace"|"add"|"subtract"|"intersect"))) {return Err(crate::transform_preview::error("颜色范围容差、范围、布尔或运算参数无效"));}
            if let Some(color)=params.get("color") {if !color.as_str().is_some_and(|s|s.len()==7 && s.starts_with('#') && s[1..].bytes().all(|b|b.is_ascii_hexdigit())){return Err(crate::transform_preview::error("颜色范围取样颜色须为 #rrggbb"));}}
            if let Some(select)=params.get("select") {if !select.as_str().is_some_and(|s|matches!(s,"sampledColors"|"reds"|"yellows"|"greens"|"cyans"|"blues"|"magentas"|"highlights"|"midtones"|"shadows"|"skinTones"|"outOfGamut")){return Err(crate::transform_preview::error("颜色范围选择类型无效"));}}
        }
        if matches!(id,"select.modify.border"|"select.modify.smooth"|"select.modify.expand"|"select.modify.contract") {
            let max=if id=="select.modify.border" {200.0} else {500.0};
            let fields=params.as_object().ok_or_else(||crate::transform_preview::error("选区修改参数必须为对象"))?;
            if fields.keys().any(|key|!["radius","applyAtCanvasBounds"].contains(&key.as_str()))
                || params["radius"].as_f64().is_none_or(|n|!n.is_finite() || n<1.0 || n>max)
                || params.get("applyAtCanvasBounds").is_some_and(|value|!value.is_boolean()) {return Err(crate::transform_preview::error("选区修改半径超出范围"));}
        }
        if matches!(id,"select.grow"|"select.similar") {
            let fields=params.as_object().ok_or_else(||crate::transform_preview::error("选区扩展参数必须为对象"))?;
            if fields.keys().any(|key|!["tolerance","sampleAllLayers"].contains(&key.as_str()))
                || params["tolerance"].as_f64().is_none_or(|n|!n.is_finite() || !(0.0..=255.0).contains(&n))
                || params.get("sampleAllLayers").is_some_and(|value|!value.is_boolean()) {return Err(crate::transform_preview::error("选区扩展容差超出范围"));}
        }
        if id=="layer.selectInRect" {
            let fields=params.as_object().ok_or_else(||crate::transform_preview::error("图层框选参数必须为对象"))?;
            if fields.keys().any(|key|!["x","y","width","height","target","mode"].contains(&key.as_str()))
                || ["x","y","width","height"].iter().any(|key|params[*key].as_f64().is_none_or(|n|!n.is_finite() || n.abs()>i32::MAX as f64 / 4.0))
                || params.get("target").is_some_and(|value|!matches!(value.as_str(),Some("layer"|"group")))
                || params.get("mode").is_some_and(|value|!matches!(value.as_str(),Some("replace"|"add"))) {return Err(crate::transform_preview::error("图层框选坐标、目标或模式无效"));}
        }
        if id=="layer.pickAt" {
            let fields=params.as_object().ok_or_else(||crate::transform_preview::error("拾取参数必须为对象"))?;
            if fields.keys().any(|key|!["x","y","target","mode","select","list"].contains(&key.as_str()))
                || ["x","y"].iter().any(|key|params[*key].as_f64().is_none_or(|n|!n.is_finite() || n<i32::MIN as f64 || n>=i32::MAX as f64))
                || params.get("target").is_some_and(|value|!matches!(value.as_str(),Some("layer"|"group")))
                || params.get("mode").is_some_and(|value|!matches!(value.as_str(),Some("replace"|"add")))
                || ["select","list"].iter().any(|key|params.get(*key).is_some_and(|value|!value.is_boolean())) {return Err(crate::transform_preview::error("拾取坐标、目标或修饰键参数无效"));}
        }
        if id=="select.rect" && params.get("line").is_some() {
            let state=self.active_doc()?;
            let line=params["line"].as_str().ok_or_else(||EditorError::CommandFailed{id:id.into(),message:"线形选框必须指定 row 或 column".into()})?;
            let (axis,other,extent)=match line {"row"=>("y","x",state.doc.size.height),"column"=>("x","y",state.doc.size.width),_=>return Err(EditorError::CommandFailed{id:id.into(),message:"线形选框必须指定 row 或 column".into()})};
            let position=params[axis].as_i64().filter(|n|*n>=0 && *n<extent as i64).ok_or_else(||EditorError::CommandFailed{id:id.into(),message:"线形选框位置超出画布".into()})?;
            if params.get("ellipse").is_some_and(|value|value!=false) {return Err(EditorError::CommandFailed{id:id.into(),message:"线形选框不能同时选择椭圆".into()});}
            let horizontal=line=="row";
            params[axis]=json!(position);params[other]=json!(0);
            params["width"]=json!(if horizontal {state.doc.size.width} else {1});
            params["height"]=json!(if horizontal {1} else {state.doc.size.height});
        }
        crate::new_layer_options::check(&self.session,id,&params)?;
        if matches!(id,"layer.linkLayers"|"layer.selectLinkedLayers") && !params.is_null() && !params.as_object().is_some_and(|fields|fields.is_empty()) {return Err(EditorError::CommandFailed{id:id.into(),message:"链接命令不接受额外参数".into()});}
        if id=="layer.setLabelColor" && params.as_object().is_none_or(|fields|fields.keys().any(|key|!["color","layer"].contains(&key.as_str()))) {return Err(EditorError::CommandFailed{id:id.into(),message:"颜色标签只接受 color 和可选 layer 参数".into()});}
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
        } else if matches!(id, "layer.new.layer" | "layer.new.layerViaCopy" | "layer.new.layerViaCut" | "layer.duplicate" | "type.create") || id.starts_with("layer.newAdjustmentLayer.") {
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
            "document": self.session.active().map(|doc|self.document_json(doc)),
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
        if let Some(index) = self.session.active_index() {
            self.session.close(index);
        }
        self.state()
    }

    fn active_doc(&self) -> Result<&photocraft_engine::DocState> {
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

    fn active_layer_id(&self) -> Option<photocraft_doc::LayerId> {
        self.session.active().and_then(|d| d.active_layer)
    }

    // 补齐操作历史的前进分支，保持上游快照不变。
    fn document_json(&self,doc: &photocraft_engine::DocState) -> Value {
        let mut value = inspect::document(doc);
        value["documentKey"]=json!(doc.doc.id.0.to_string());
        value["historyFollowKey"]=json!(self.history_follow.read(doc));
        value["statusMetadata"]=crate::document_status::inspect(&doc.doc);
        value["paintingSymmetry"]=crate::painting_symmetry::inspect(doc);
        // 参考线与标尺原点属于文档视图状态（I096）：由这里投影，因为固定快照不暴露它们。
        value["guides"]=json!({
            "horizontal":doc.doc.guides.horizontal,
            "vertical":doc.doc.guides.vertical,
            "colors":doc.doc.guides.colors.iter().map(|c|json!({"vertical":c.vertical,"position":c.position,"rgb":c.rgb})).collect::<Vec<_>>()
        });
        value["rulerOrigin"]=json!([doc.doc.ruler_origin[0],doc.doc.ruler_origin[1]]);
        value["symmetryPaths"]=json!(crate::painting_symmetry::paths(doc));
        value["nextLayerName"]=json!(doc.doc.next_layer_name("Layer"));
        let frame=crate::layer_preview::transform_frame(doc);
        value["transformFrame"] = if frame.is_empty() {Value::Null} else {json!([frame.x0,frame.y0,frame.x1,frame.y1])};
        // Properties dimensions describe whole layer targets even when a pixel selection exists.
        let mut whole=doc.clone();std::sync::Arc::make_mut(&mut whole.doc).selection=None;
        let frame=crate::layer_preview::transform_frame(&whole);
        value["layerTransformFrame"] = if frame.is_empty(){Value::Null}else{json!([frame.x0,frame.y0,frame.x1,frame.y1])};
        value["editTarget"]=json!(if crate::layer_preview::mask_target(doc) {"mask"} else {"pixels"});
        fn mask_state(rows: &mut Value, document: &photocraft_doc::Document) {
            if let Some(rows)=rows.as_array_mut() { for row in rows {
                if let Some(layer)=row["id"].as_u64().and_then(|id|document.layer(photocraft_doc::LayerId(id))) {
                    row["locks"]=json!(layer.locks);
                    row["effectiveLocks"]=json!(document.effective_locks(layer.id));
                    row["background"]=json!(document.is_background(layer.id));
                }
                if let Some(mask)=row["id"].as_u64().and_then(|id|document.layer(photocraft_doc::LayerId(id))).and_then(|layer|layer.mask.as_ref()) {
                    row["maskEnabled"]=json!(mask.enabled); row["maskLinked"]=json!(mask.linked); row["maskDensity"]=json!(mask.density); row["maskFeather"]=json!(mask.feather);
                }
                if let Some(children)=row.get_mut("children") {mask_state(children,document);}
            }}
        }
        mask_state(&mut value["layers"],&doc.doc);
        value["selectionFrame"] = doc.doc.selection.as_ref().and_then(|selection| {
            let rect = selection.content_bounds();
            (!rect.is_empty()).then(|| json!([rect.x0,rect.y0,rect.x1,rect.y1]))
        }).unwrap_or(Value::Null);
        value["historySnapshots"]=json!(doc.snapshots.iter().map(|snap|json!({"id":snap.id,"name":snap.name})).collect::<Vec<_>>());
        value["redoHistory"] = json!(doc.history.redo_labels().collect::<Vec<_>>());
        // 只投影活动文字层的首个样式，不在宿主复制可写文字模型。
        value["activeTextStyle"] = doc.active_layer.and_then(|id| doc.doc.layer(id)).and_then(|layer| {
            let photocraft_doc::LayerContent::Text(text) = &layer.content else { return None; };
            let runs = text.char_runs();
            let paragraphs = text.paragraph_runs();
            Some(json!({ "orientation":if text.orientation==photocraft_doc::text::Orientation::Vertical{"vertical"}else{"horizontal"},"antialias":photocraft_engine::type_extra_cmds::aa_name(text.antialias),"character": runs.first().map(|run| &run.style),
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
            "document": self.document_json(doc),
        }))
    }
}

#[cfg(test)]
#[path = "editor/tests_pattern_library_interaction.rs"]
mod pattern_library_interaction_tests;

#[cfg(test)]
#[path = "editor/tests_interaction.rs"]
mod interaction_tests;

#[cfg(test)]
#[path = "editor/tests_stroke_selection.rs"]
mod stroke_selection_tests;

#[cfg(test)]
#[path = "editor/tests_mask_creation.rs"]
mod mask_creation_tests;

#[cfg(test)]
#[path = "editor/tests_smart_entry.rs"]
mod smart_entry_tests;

mod stroke;
mod properties;
mod text;
mod transform;

mod info;
mod pixel_grid;
mod histogram;
