//! 调整草稿：调整层参数编辑与直接像素调整共用同一事务边界
//! （change: 2026-10-22-add-photocraft-adjustment-workflows，U40/U41/U42）。
//!
//! 两种目标只在**执行命令**上不同：
//! - `Target::Layer`：`layer.setAdjustment` 改可重编的调整层；
//! - `Target::Pixels`：`image.adjustments.<kind>` 直接改目标像素层，确认后只增加一步历史、
//!   不新增图层。
//!
//! 共同规则：预览在隔离会话里跑真实上游命令（含选区混合），正式文档的修订/指纹/历史不动；
//! 非法参数让草稿立即失效，不能确认上一份成功预览；确认一次、取消恢复。

use std::sync::Arc;
use photocraft_doc::{Document, LayerContent, LayerId};
use photocraft_engine::{DocState, Session};
use serde_json::{Value, json};
use crate::error::{EditorError, Result};

pub(crate) fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "layer.setAdjustment".into(), message: message.to_string() }
}

/// 草稿目标：可重编的调整层，或直接作用的像素层。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Target {
    Layer { layer: LayerId },
    Pixels { layer: LayerId },
}

pub(crate) struct AdjustmentPreview {
    base: DocState,
    target: Target,
    kind: String,
    /// 直接调整的完整请求（逐类调整或自动/匹配命令）；调整层只用 `kind`。
    request: Option<crate::features::adjustments::direct_adjustment::Request>,
    /// 会话内**其它**文档的冻结快照（`(索引, 文档)`），用于跨文档匹配颜色。
    ///
    /// 只有 `matchColor` 的 `source` 指向别处才需要；快照在开始草稿时取一次，之后别的文档再改
    /// 也不影响本次草稿（`Arc` 快照 + `Arc::make_mut` 的写时复制保证冻结）。索引保持在会话里
    /// 的位置，因为上游命令按 `Session::documents()[i]` 取来源统计。
    sources: Vec<(usize, Arc<Document>)>,
    /// 本文档在会话里的索引（隔离会话按同一索引装配，`source` 才能对上）。
    active: usize,
    params: Value,
    valid: bool,
    pub doc: Arc<Document>,
}

impl AdjustmentPreview {
    /// 调整层草稿（图层 → 新建/编辑调整图层）。
    pub fn new(base: &DocState, layer: u64) -> Result<Self> {
        use crate::features::adjustments::direct_adjustment as direct;
        let layer=LayerId(layer);
        let target=base.doc.layer(layer).ok_or_else(||error("调整层不存在"))?;
        let locks=base.doc.effective_locks(layer);
        if locks.all || locks.pixels {return Err(error("调整层已锁定，无法编辑"));}
        let LayerContent::Adjustment(adjustment)=&target.content else {return Err(error("目标不是调整层"))};
        let kind=photocraft_engine::commands::adjustment_kind(adjustment);
        // 两种目标共用同一份类型与参数表：`调整层` 的可见性仍由唯一命令门决定，
        // 本域不另存一份硬编码的类型清单。
        if direct::allowed_keys(kind).is_none() {
            return Err(error("此调整类型尚未开放"));
        }
        if !crate::capability::command_allowed(&format!("layer.newAdjustmentLayer.{kind}")) {
            return Err(error(format!("layer.newAdjustmentLayer.{kind} 尚未接通运行时")));
        }
        Ok(Self {base:base.clone(),target:Target::Layer{layer},kind:kind.to_string(),request:None,sources:Vec::new(),active:0,params:json!({}),valid:true,doc:base.doc.clone()})
    }

    /// 直接像素调整草稿（图像 → 调整）：目标必须是可写像素层。
    ///
    /// `target` 是逐类调整的类型（`curves`）或完整的自动/匹配命令 id
    /// （`image.autoTone`）。**开放与否只看唯一命令门**：未进白名单的命令在这里就被拒绝，
    /// 不能靠界面或参数绕过。
    ///
    /// `others` 是会话内其它文档的冻结快照（索引 + 文档），只用于跨文档匹配颜色；`active` 是
    /// 本文档在会话里的索引，草稿会话按同样的索引装文档，上游按 `documents()[i]` 取来源统计。
    /// 单文档直接像素调整草稿（没有跨文档来源时的便捷入口；生产路径用
    /// `new_pixels_in_session`，它同时冻结会话里的其它文档）。
    #[cfg(test)]
    pub fn new_pixels(base: &DocState, target: &str, params: &Value, layer: Option<u64>) -> Result<Self> {
        Self::new_pixels_in_session(base, 0, &[], target, params, layer)
    }

    /// 带会话文档清单的直接像素调整草稿（跨文档匹配颜色的入口）。
    pub fn new_pixels_in_session(
        base: &DocState,
        active: usize,
        others: &[(usize, Arc<Document>)],
        target: &str,
        params: &Value,
        layer: Option<u64>,
    ) -> Result<Self> {
        use crate::features::adjustments::direct_adjustment as direct;
        let request=direct::Request::parse(target)?;
        if !request.is_open() {
            return Err(error(format!("{} 尚未接通运行时", request.command())));
        }
        // `null` 在草稿层表示「清除该键」（回到默认），参数表本身仍保持严格：空值不能当参数值。
        let merged=clear_nulls(params);
        request.validate(&merged)?;
        let layer=direct::target_layer(&base.doc,layer,base.active_layer)?;
        direct::writable_target(&base.doc,layer)?;
        // 冻结**全部**其它文档，而不是只冻结这一次引用的那份：草稿里换来源时仍要落在同一份
        // 会话快照上，不能因为第二次 update 引用了没保存的文档就失败。
        let frozen=others.to_vec();
        let resolved=snapshot_for(&request,&merged,&base.doc,active,&frozen)?;
        let doc=apply_pixels(base,active,layer,&request,&merged,&resolved)?;
        Ok(Self {base:base.clone(),target:Target::Pixels{layer},kind:request.kind(),request:Some(request),sources:frozen,active,params:merged,valid:true,doc})
    }

    pub fn info(&self) -> Value {
        match self.target {
            Target::Layer { layer } => {
                let LayerContent::Adjustment(adjustment)=&self.doc.layer(layer).unwrap().content else {unreachable!()};
                json!({"mode":"adjustmentLayer","layer":layer.0,"kind":self.kind,"params":photocraft_engine::adjust_params::to_params(adjustment)})
            }
            Target::Pixels { layer } => {
                let command=self.request.as_ref().map(|request|request.command()).unwrap_or_else(||format!("image.adjustments.{}",self.kind));
                // 回传已合并的输入参数：直接调整没有可重编的调整层可读回，而 `to_params` 会丢掉
                // 非一一对应的输入（如照片滤镜的预设 id、吸管取样），界面据此回显就不准了。
                json!({"mode":"pixels","layer":layer.0,"kind":self.kind,"command":command,"params":self.params})
            }
        }
    }

    pub fn update(&mut self, params: Value) -> Result<()> {
        // 失败后不可确认上一版成功草稿，必须修正参数或取消。
        self.valid=false;
        // 只有直接像素调整有「可选键」：`null` 表示清除该键（例如把匹配颜色的来源换回本图）。
        // 调整层草稿的字段都是必填，继续严格拒绝空值。
        let clears_nulls=matches!(self.target,Target::Pixels{..});
        let patch=if clears_nulls {clear_nulls(&params)} else {params.clone()};
        // 纯清除（整份补丁都是 null）没有可校验的值；空对象 `{}` 仍按「参数必须非空」拒绝。
        let only_clears=clears_nulls
            && patch.as_object().is_some_and(|object|object.is_empty())
            && params.as_object().is_some_and(|object|!object.is_empty());
        if !only_clears {self.validate(&patch)?;}
        let mut merged=self.params.clone();
        if let Some(object)=merged.as_object_mut() {
            if clears_nulls && let Some(requested)=params.as_object() {
                for (key,value) in requested {
                    if value.is_null() {object.remove(key);}
                }
            }
            for (key,value) in patch.as_object().unwrap() {object.insert(key.clone(),value.clone());}
        }
        self.doc=match self.target {
            Target::Layer { layer } => {
                let mut scratch=Session::new();
                scratch.add_document((*self.base.doc).clone(),None);
                *scratch.active_mut().unwrap()=self.base.clone();
                let mut command=merged.clone();command["layer"]=json!(layer.0);
                scratch.execute("layer.setAdjustment",command).map_err(error)?;
                scratch.active().unwrap().doc.clone()
            }
            Target::Pixels { layer } => {
                let request=self.request.clone().ok_or_else(||error("直接调整草稿缺少命令"))?;
                let resolved=snapshot_for(&request,&merged,&self.base.doc,self.active,&self.sources)?;
                apply_pixels(&self.base,self.active,layer,&request,&merged,&resolved)?
            }
        };
        self.params=merged;self.valid=true;
        Ok(())
    }

    fn validate(&self, params: &Value) -> Result<()> {
        // 历史六类沿用面板的严格范围语义：越界即为错误，不静默夹紧后再确认。
        // 其余本域类型（U43/U44 打开后）复用与直接调整相同的参数表，避免两套范围表漂移。
        if !matches!(
            self.kind.as_str(),
            "brightnessContrast" | "hueSaturation" | "curves" | "levels" | "vibrance" | "blackWhite"
        ) {
            return crate::features::adjustments::direct_adjustment::validate(&self.kind, params);
        }
        let fields=params.as_object().filter(|p|!p.is_empty()).ok_or_else(||error("调整参数必须是非空对象"))?;
        for (key,value) in fields {
            let range=match (self.kind.as_str(),key.as_str()) {
                ("brightnessContrast","brightness")=>(-150.0,150.0),
                ("brightnessContrast","contrast")=>(-50.0,100.0),
                ("brightnessContrast","legacy")=>{require_bool(key,value)?;continue;},
                ("hueSaturation","hue")=>(-180.0,180.0),
                ("hueSaturation","saturation"|"lightness")=>(-100.0,100.0),
                ("hueSaturation","colorize")=>{require_bool(key,value)?;continue;},
                // U42：六个色域各自的色相/饱和度/明度与四个范围滑杆。
                ("hueSaturation","reds"|"yellows"|"greens"|"cyans"|"blues"|"magentas")=>{validate_hue_range(key,value)?;continue;},
                // U41：分通道曲线、铅笔曲线与平滑；曲线由上游解析器统一复核。
                ("curves","points"|"red"|"green"|"blue")=>{validate_curve(key,value)?;continue;},
                ("curves","pencil")=>{require_bool(key,value)?;continue;},
                ("curves","smooth")=>(0.0,10.0),
                // U41：色阶输入/输出端点（含分通道）与黑灰白场吸管。
                ("levels","inBlack"|"inWhite"|"outBlack"|"outWhite")=>(0.0,255.0),
                ("levels","gamma")=>(0.01,9.99),
                ("levels","red"|"green"|"blue")=>{validate_levels_channel(key,value)?;continue;},
                ("levels"|"curves","eyedropper")=>{validate_eyedropper(value)?;continue;},
                ("vibrance","vibrance"|"saturation")=>(-100.0,100.0),
                ("blackWhite","reds"|"yellows"|"greens"|"cyans"|"blues"|"magentas")=>(-200.0,300.0),
                // U42：黑白 Tint 与其颜色。
                ("blackWhite","tint")=>{require_bool(key,value)?;continue;},
                ("blackWhite","tintColor")=>{validate_hex_color(key,value)?;continue;},
                _=>return Err(error("调整草稿包含未开放的参数")),
            };
            if !value.as_f64().is_some_and(|v|v.is_finite() && (range.0..=range.1).contains(&v)) {
                return Err(error(format!("{key} 超出范围或不是有限数值")));
            }
        }
        Ok(())
    }

    pub fn commit(&self, session: &mut Session) -> Result<()> {
        if !self.valid {return Err(error("请修正调整参数或取消编辑"));}
        match self.target {
            Target::Layer { .. } => crate::preview_history::commit(session,self.doc.clone(),None,"修改调整层").map_err(error),
            Target::Pixels { layer } => {
                crate::preview_history::commit(session,self.doc.clone(),Some(Some(layer)),"直接调整").map_err(error)
            }
        }
    }

    pub fn require_valid(&self) -> Result<()> {
        if self.valid {Ok(())} else {Err(error("请修正调整参数或取消编辑"))}
    }

    /// 草稿相对开始时的文档是否有实际变化（「无变化不增历史」的判据）。
    ///
    /// **不能只看内容指纹**：`identity` 的调整参数投影是共享文件，尚未包含本 change 新增的
    /// 输出端点、六色域、Tint、铅笔映射等持久参数；只按指纹判断会把「只改了这些参数」的确认
    /// 当成无变化而静默丢弃。这里直接比较草稿文档与开始时文档。
    pub fn changed(&self) -> bool { !std::sync::Arc::ptr_eq(&self.doc,&self.base.doc) && *self.doc != *self.base.doc }
}

/// 直接调整在隔离会话里执行真实上游命令；选区与目标层都由命令自身处理。
///
/// `sources` 是**其它**文档的冻结快照，`active` 是本文档在会话里的索引：隔离会话按同样的索引
/// 装配，`matchColor` 的 `source`（会话文档索引）才取到正确来源。来源文档只读，提交时只发布
/// 本文档的草稿。
fn apply_pixels(
    base: &DocState,
    active: usize,
    layer: LayerId,
    request: &crate::features::adjustments::direct_adjustment::Request,
    params: &Value,
    sources: &[(usize, Arc<Document>)],
) -> Result<Arc<Document>> {
    let mut scratch=Session::new();
    if params.get("source").is_none() {
        // 常见路径：没有显式来源，命令只读活动文档，索引不必对齐。
        scratch.add_document((*base.doc).clone(),None);
        *scratch.active_mut().unwrap()=base.clone();
    } else {
        // 按会话索引装配：未引用的空位用 1×1 占位文档（不会被匹配命令取统计），
        // 本文档放在 `active`，其它来源放在各自原索引。
        let mut slots: Vec<(usize, Option<Arc<Document>>)> = sources.iter().map(|(index, doc)| (*index, Some(doc.clone()))).collect();
        slots.push((active, None));
        let last = slots.iter().map(|(index, _)| *index).max().unwrap_or(active);
        for index in 0..=last {
            if let Some((_, Some(document))) = slots.iter().find(|(slot, _)| *slot == index) {
                scratch.add_document((**document).clone(),None);
            } else {
                scratch.add_document(placeholder(),None);
            }
            if index == active {
                *scratch.active_mut().unwrap()=base.clone();
            }
        }
        if !scratch.set_active(active) {
            return Err(error("调整草稿无法定位目标文档"));
        }
    }
    let mut command=params.clone();
    if let Some(object)=command.as_object_mut() {object.insert("layer".into(),json!(layer.0));}
    scratch.execute(&request.command(),command).map_err(error)?;
    Ok(scratch.active().unwrap().doc.clone())
}

/// 索引占位文档：只用于对齐会话索引，不会被匹配命令读取。
fn placeholder() -> Document {
    Document::new(
        "占位",
        photocraft_doc::Size::new(1, 1),
        photocraft_doc::ColorMode::Rgb,
        photocraft_doc::SampleType::U8,
    )
}

/// 取跨文档匹配所需的冻结来源快照：只有 `matchColor` 带显式 `source` 才需要其它文档，
/// 且来源索引/图层必须真实存在，否则直接拒绝（不静默回退到同图统计）。
fn snapshot_for(
    request: &crate::features::adjustments::direct_adjustment::Request,
    params: &Value,
    base: &Document,
    active: usize,
    others: &[(usize, Arc<Document>)],
) -> Result<Vec<(usize, Arc<Document>)>> {
    if request.command() != "image.adjustments.matchColor" {
        return Ok(Vec::new());
    }
    let Some(source) = params.get("source").and_then(Value::as_i64) else {
        return Ok(Vec::new());
    };
    let index = usize::try_from(source).map_err(|_| error("匹配来源 source 必须是非负文档索引"))?;
    let source_layer = params.get("sourceLayer").and_then(Value::as_u64);
    let snapshot = others.iter().find(|(slot, _)| *slot == index);
    // 来源就是本文档时不需要另存快照：隔离会话里的本文档本身就是来源。
    let document: &Document = match (&snapshot, index == active) {
        (Some((_, document)), _) => document,
        (None, true) => base,
        (None, false) => return Err(error(format!("匹配来源文档 {index} 不在打开列表里"))),
    };
    if let Some(id) = source_layer
        && !exists_in(document, id) {
        return Err(error(format!("匹配来源图层 {id} 不在来源文档里")));
    }
    Ok(snapshot.filter(|_| index != active).map(|(slot, document)| vec![(*slot, document.clone())]).unwrap_or_default())
}

/// 图层 id 是否存在于该文档（含分组子层）。
fn exists_in(document: &Document, id: u64) -> bool {
    fn walk(layers: &[photocraft_doc::Layer], id: u64) -> bool {
        layers.iter().any(|layer| layer.id.0 == id || layer.children().is_some_and(|children| walk(children, id)))
    }
    walk(&document.layers, id)
}

/// 去掉值为 `null` 的键：草稿里 `null` 表示「清除该键」，不是参数值本身。
fn clear_nulls(params:&Value)->Value {
    let Some(object)=params.as_object() else {return params.clone();};
    let mut cleared=serde_json::Map::new();
    for (key,value) in object {
        if !value.is_null() {cleared.insert(key.clone(),value.clone());}
    }
    Value::Object(cleared)
}

fn require_bool(key:&str,value:&Value)->Result<()> {
    value.as_bool().map(|_|()).ok_or_else(||error(format!("{key} 必须是 true 或 false")))
}

fn validate_hex_color(key:&str,value:&Value)->Result<()> {
    let text=value.as_str().ok_or_else(||error(format!("{key} 必须是 #rrggbb")))?;
    let hex=text.strip_prefix('#').filter(|hex|hex.len()==6 && hex.bytes().all(|b|b.is_ascii_hexdigit()));
    hex.map(|_|()).ok_or_else(||error(format!("{key} 必须是 #rrggbb")))
}

/// 单个色域：色相/饱和度/明度加四个范围滑杆（顺序与宽度由内核规范化）。
fn validate_hue_range(key:&str,value:&Value)->Result<()> {
    let object=value.as_object().ok_or_else(||error(format!("{key} 必须是色域对象")))?;
    if object.is_empty() {return Err(error(format!("{key} 不能为空")));}
    for (field,value) in object {
        let range=match field.as_str() {
            "hue" =>(-180.0,180.0),
            "saturation"|"lightness" =>(-100.0,100.0),
            "range" =>{
                let bounds=value.as_array().filter(|bounds|bounds.len()==4).ok_or_else(||error(format!("{key}.range 需要 4 个角度")))?;
                if bounds.iter().all(|v|v.as_f64().is_some_and(f64::is_finite)) {continue;}
                return Err(error(format!("{key}.range 必须是有限角度")));
            }
            other =>return Err(error(format!("{key} 不接受 {other}"))),
        };
        if !value.as_f64().is_some_and(|v|v.is_finite() && (range.0..=range.1).contains(&v)) {
            return Err(error(format!("{key}.{field} 超出范围或不是有限数值")));
        }
    }
    Ok(())
}

fn validate_levels_channel(key:&str,value:&Value)->Result<()> {
    let object=value.as_object().ok_or_else(||error(format!("{key} 必须是通道对象")))?;
    if object.is_empty() {return Err(error(format!("{key} 不能为空")));}
    for (field,value) in object {
        let range=match field.as_str() {
            "inBlack"|"inWhite"|"outBlack"|"outWhite" =>(0.0,255.0),
            "gamma" =>(0.01,9.99),
            other=>return Err(error(format!("{key} 不接受 {other}"))),
        };
        if !value.as_f64().is_some_and(|v|v.is_finite() && (range.0..=range.1).contains(&v)) {
            return Err(error(format!("{key}.{field} 超出范围或不是有限数值")));
        }
    }
    Ok(())
}

/// 曲线几何：点模式（2–19 个严格递增坐标）或铅笔模式（256 个输出级）。
fn validate_curve(key:&str,value:&Value)->Result<()> {
    crate::features::adjustments::direct_adjustment::validate_curve(value,key)
}

/// 吸管（黑/灰/白场）：`{"point","at":[x,y],"size"}` 或 `{"point","color":[r,g,b]}`。
fn validate_eyedropper(value:&Value)->Result<()> {
    let object=value.as_object().ok_or_else(||error("吸管必须是对象"))?;
    match object.get("point").and_then(Value::as_str) {
        Some("black"|"gray"|"white")=>{}
        _=>return Err(error("吸管 point 必须是 black、gray 或 white")),
    }
    if let Some(color)=object.get("color") {
        let triple=color.as_array().filter(|values|values.len()==3).ok_or_else(||error("吸管 color 必须是 [r, g, b]"))?;
        if triple.iter().all(|v|v.as_f64().is_some_and(|v|v.is_finite() && (0.0..=1.0).contains(&v))) {return Ok(());}
        return Err(error("吸管 color 必须在 0–1 之间"));
    }
    let at=object.get("at").ok_or_else(||error("吸管需要 at 或 color"))?;
    let pair=at.as_array().filter(|values|values.len()==2).ok_or_else(||error("吸管 at 必须是 [x, y]"))?;
    if !pair.iter().all(|v|v.as_f64().is_some_and(f64::is_finite)) {return Err(error("吸管 at 必须是有限数值"));}
    if let Some(size)=object.get("size") {
        if !size.as_u64().is_some_and(|size|(1..=101).contains(&size)) {return Err(error("吸管 size 必须在 1–101 之间"));}
    }
    Ok(())
}

/// 只取总曲线的数值几何，不采样或合成图片；图形与调色复用同一 LUT。
pub(crate) fn curve_geometry(points: &Value) -> Result<Value> {
    crate::features::adjustments::direct_adjustment::validate_curve(points, "points")?;
    let points=photocraft_engine::adjust_params::parse_curve("layer.setAdjustment","points",points).map_err(error)?;
    let lut=photocraft_compose::adjust::curve_lut(&points);
    Ok(json!((0..256).map(|i|{
        let position=i as f32*(lut.len()-1) as f32/255.0;
        let left=position.floor() as usize;let right=(left+1).min(lut.len()-1);
        (lut[left]+(lut[right]-lut[left])*(position-left as f32))*255.0
    }).collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 目标层某点的 RGB（0–1）；只读内核内存，不合成、不渲染。
    fn pixels(document: &Document, layer: LayerId) -> [f32; 3] {
        let surface = document.layer(layer).and_then(|layer| layer.surface()).unwrap();
        [surface.sample_channel(3, 3, 0), surface.sample_channel(3, 3, 1), surface.sample_channel(3, 3, 2)]
    }

    fn document_content_hash(document: &Document, registry: &crate::document_content::AssetRegistry) -> Option<String> {
        crate::document_content::document_content_hash(document, registry)
    }

    #[test]
    fn curve_geometry_reuses_the_native_spline_without_image_rendering() {
        let identity=curve_geometry(&json!([[0,0],[255,255]])).unwrap();
        assert_eq!(identity.as_array().unwrap().len(),256);
        for (i,value) in identity.as_array().unwrap().iter().enumerate() {assert!((value.as_f64().unwrap()-i as f64).abs()<0.0001);}
        let curved=curve_geometry(&json!([[0,0],[128,200],[255,255]])).unwrap();
        assert!(curved[64].as_f64().unwrap()>110.0); // 自然样条不同于控制点间直线的 100。
        assert!(curve_geometry(&json!([[0,0],[0,255]])).is_err());
        assert!(curve_geometry(&json!([[0,0],[0.1,100],[255,255]])).is_err());
        assert!(curve_geometry(&json!([255,254,253])).is_err(), "不完整铅笔映射不能当点曲线");
    }

    #[test]
    fn adjustment_history_and_project_roundtrip_do_not_require_compositing() {
        for (kind,params) in [
            ("brightnessContrast",json!({"brightness":37,"contrast":22})),
            ("hueSaturation",json!({"hue":-45,"saturation":35,"lightness":10})),
            ("curves",json!({"points":[[0,0],[100,180],[255,255]]})),
        ] {
            let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
            session.execute(&format!("layer.newAdjustmentLayer.{kind}"),json!({})).unwrap();
            let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=AdjustmentPreview::new(&base,id.0).unwrap();
            draft.update(params.clone()).unwrap();let expected=draft.info();
            draft.commit(&mut session).unwrap();
            assert_eq!(session.active().unwrap().history.past_len(),base.history.past_len()+1);
            let bytes=photocraft_format::save_to_bytes(&session.active().unwrap().doc,&Default::default()).unwrap();
            let restored=photocraft_format::load_from_bytes(&bytes).unwrap();
            let LayerContent::Adjustment(adjustment)=&restored.layer(id).unwrap().content else {panic!()};
            assert_eq!(photocraft_engine::adjust_params::to_params(adjustment),expected["params"]);
            session.execute("edit.undo",Value::Null).unwrap();
            let LayerContent::Adjustment(adjustment)=&session.active().unwrap().doc.layer(id).unwrap().content else {panic!()};
            let LayerContent::Adjustment(original)=&base.doc.layer(id).unwrap().content else {panic!()};
            assert_eq!(adjustment,original);
            session.execute("edit.redo",Value::Null).unwrap();
            let next=AdjustmentPreview::new(session.active().unwrap(),id.0).unwrap();
            assert_eq!(next.info(),expected);
        }
    }

    #[test]
    fn locks_types_and_parameter_ranges_are_checked_before_editing() {
        let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        session.execute("layer.new.layer",json!({})).unwrap();
        let id=session.active().unwrap().active_layer.unwrap();
        assert!(AdjustmentPreview::new(session.active().unwrap(),id.0).is_err());
        assert!(AdjustmentPreview::new(session.active().unwrap(),u64::MAX).is_err());
        for (kind,bad) in [
            ("brightnessContrast",vec![json!({"brightness":151}),json!({"contrast":-51}),json!({"brightness":null}),json!({"legacy":"yes"})]),
            ("hueSaturation",vec![json!({"hue":181}),json!({"saturation":-101}),json!({"lightness":"10"}),json!({"colorize":"true"})]),
        ] {
            session.execute(&format!("layer.newAdjustmentLayer.{kind}"),json!({})).unwrap();
            let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
            let mut draft=AdjustmentPreview::new(&base,id.0).unwrap();let original=draft.info();
            for params in bad {assert!(draft.update(params).is_err());assert_eq!(draft.info(),original);assert!(draft.commit(&mut session).is_err());}
            Arc::make_mut(&mut session.active_mut().unwrap().doc).layer_mut(id).unwrap().locks.all=true;
            assert!(AdjustmentPreview::new(session.active().unwrap(),id.0).is_err());
        }
    }

    #[test]
    fn layer_draft_accepts_the_new_channel_curve_levels_and_hue_options() {
        let mut session=Session::new();session.execute("file.new",json!({"width":24,"height":16})).unwrap();
        // 曲线：分通道 + 铅笔 + 平滑，切通道不丢已有曲线。
        session.execute("layer.newAdjustmentLayer.curves",json!({})).unwrap();
        let base=session.active().unwrap().clone();let id=base.active_layer.unwrap();
        let mut draft=AdjustmentPreview::new(&base,id.0).unwrap();
        draft.update(json!({"points":[[0,0],[255,255]],"red":[[0,0],[100,200],[255,255]]})).unwrap();
        draft.update(json!({"green":[[0,0],[128,100],[255,255]]})).unwrap();
        let params=draft.info()["params"].clone();
        assert_eq!(params["red"][1][1],200.0);
        assert_eq!(params["green"][1][1],100.0);
        assert_eq!(params["points"].as_array().unwrap().len(),2);
        draft.commit(&mut session).unwrap();
        // 重开保持所有曲线。
        let bytes=photocraft_format::save_to_bytes(&session.active().unwrap().doc,&Default::default()).unwrap();
        let restored=photocraft_format::load_from_bytes(&bytes).unwrap();
        let LayerContent::Adjustment(adjustment)=&restored.layer(id).unwrap().content else {panic!()};
        let restored=photocraft_engine::adjust_params::to_params(adjustment);
        assert_eq!(restored["red"].as_array().unwrap().len(),3);
        assert_eq!(restored["red"][1][1],json!(200.0));

        // 色阶：输出端点 + 分通道 + 吸管。
        session.execute("layer.newAdjustmentLayer.levels",json!({})).unwrap();
        let base=session.active().unwrap().clone();let levels_id=base.active_layer.unwrap();
        let mut levels=AdjustmentPreview::new(&base,levels_id.0).unwrap();
        levels.update(json!({"outBlack":10,"outWhite":240,"red":{"inBlack":5,"gamma":1.2,"inWhite":250}})).unwrap();
        assert_eq!(levels.info()["params"]["outWhite"],240.0);
        assert!(levels.update(json!({"red":{"inBlack":260}})).is_err(), "分通道端点仍受限");
        levels.update(json!({"eyedropper":{"point":"black","color":[0.1,0.1,0.1]}})).unwrap();
        assert!(levels.info()["params"]["inBlack"].as_f64().is_some());

        // 色相/饱和度：六色域 + Colorize；黑白：Tint。
        session.execute("layer.newAdjustmentLayer.hueSaturation",json!({})).unwrap();
        let base=session.active().unwrap().clone();let hue_id=base.active_layer.unwrap();
        let mut hue=AdjustmentPreview::new(&base,hue_id.0).unwrap();
        hue.update(json!({"reds":{"hue":10,"saturation":-40,"lightness":5,"range":[-45,-15,15,45]}})).unwrap();
        hue.update(json!({"colorize":true,"hue":35,"saturation":25})).unwrap();
        let params=hue.info()["params"].clone();
        assert_eq!(params["colorize"],true);
        assert_eq!(params["reds"]["saturation"],-40.0,"切到着色不丢色域参数");
        assert!(hue.update(json!({"yellows":{"range":[1,2]}})).is_err());
        session.execute("layer.newAdjustmentLayer.blackWhite",json!({})).unwrap();
        let base=session.active().unwrap().clone();let bw_id=base.active_layer.unwrap();
        let mut bw=AdjustmentPreview::new(&base,bw_id.0).unwrap();
        bw.update(json!({"tint":true,"tintColor":"#c8a06a"})).unwrap();
        assert_eq!(bw.info()["params"]["tint"],true);
        assert!(bw.update(json!({"tintColor":"c8a06a"})).is_err());
    }

    #[test]
    fn unpublished_kinds_cannot_be_edited_through_the_layer_path_either() {
        let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let document=Arc::make_mut(&mut session.active_mut().unwrap().doc);
        let layer=photocraft_doc::Layer::new("LUT",LayerContent::Adjustment(photocraft_doc::Adjustment::ColorLookup{name:"Look.cube".into(),lut:None,size:2,tetrahedral:false,dither:false}));
        let id=layer.id;document.layers.push(layer);
        session.active_mut().unwrap().active_layer=Some(id);
        // LUT 不在本 change 范围（`adjust.lut` 是永久非目标）：调整层入口同样不能开始草稿，
        // 不能只放开直接调整。
        let Err(failure)=AdjustmentPreview::new(session.active().unwrap(),id.0) else {
            panic!("尚未发布的调整类型不能开始调整层草稿");
        };
        assert!(failure.message().contains("尚未开放"),"{}",failure.message());
    }

    #[test]
    fn cross_document_match_uses_a_frozen_source_and_only_commits_the_target() {
        use crate::features::adjustments::direct_adjustment::Request;
        use std::sync::Arc as Shared;
        // 两份文档：索引 0 是来源（暖色），索引 1 是目标（冷色）。
        let mut session=Session::new();
        session.execute("file.new",json!({"width":8,"height":8,"background":"#c08040"})).unwrap();
        session.execute("file.new",json!({"width":8,"height":8,"background":"#4060a0"})).unwrap();
        let active=session.active_index().unwrap();
        assert_eq!(active,1);
        let others:Vec<(usize,Shared<Document>)>=session.documents().iter().enumerate()
            .filter(|(index,_)|*index!=active)
            .map(|(index,state)|(index,state.doc.clone()))
            .collect();
        let source_hash=document_content_hash(&session.documents()[0].doc,&Default::default());
        let base=session.active().unwrap().clone();
        let layer=base.active_layer.unwrap();
        let before=pixels(&base.doc,layer);
        let request=Request::parse("image.adjustments.matchColor").unwrap();
        let params=json!({"source":0});
        // 命令门尚未发布该命令，所以这里直接走草稿内核：`snapshot_for` 取冻结来源、
        // `apply_pixels` 按会话索引装配隔离会话。发布后同一份代码经 `new_pixels_in_session` 生效。
        let sources=snapshot_for(&request,&params,&base.doc,active,&others).unwrap();
        assert_eq!(sources.len(),1,"跨文档来源必须进入冻结快照");
        assert_eq!(sources[0].0,0,"快照保留会话索引");
        let doc=apply_pixels(&base,active,layer,&request,&params,&sources).unwrap();
        // 目标改变、来源不变。
        let after=pixels(&doc,layer);
        assert_ne!(after,before,"目标像素必须按来源统计真实改变");
        assert_eq!(document_content_hash(&session.documents()[0].doc,&Default::default()),source_hash,"冻结的来源不能被修改");
        assert_eq!(document_content_hash(&doc,&Default::default())!=None,true);
        // 确认只发布目标，一步历史；来源仍不变。
        let mut commit_session=Session::new();
        for state in session.documents() {
            commit_session.add_document((*state.doc).clone(), state.path.clone());
        }
        commit_session.set_active(1);
        crate::preview_history::commit(&mut commit_session,doc.clone(),Some(Some(layer)),"直接调整").unwrap();
        assert_eq!(commit_session.documents()[1].history.past_len(),base.history.past_len()+1);
        assert_eq!(document_content_hash(&commit_session.documents()[0].doc,&Default::default()),source_hash);
        commit_session.execute("edit.undo",Value::Null).unwrap();
        assert_eq!(pixels(&commit_session.documents()[1].doc,layer),before);
        assert_eq!(document_content_hash(&commit_session.documents()[0].doc,&Default::default()),source_hash);
    }

    #[test]
    fn cross_document_source_must_exist_and_is_frozen_after_begin() {
        use crate::features::adjustments::direct_adjustment::Request;
        use std::sync::Arc as Shared;
        let mut session=Session::new();
        session.execute("file.new",json!({"width":8,"height":8,"background":"#c08040"})).unwrap();
        session.execute("file.new",json!({"width":8,"height":8,"background":"#4060a0"})).unwrap();
        let active=session.active_index().unwrap();
        let others:Vec<(usize,Shared<Document>)>=session.documents().iter().enumerate()
            .filter(|(index,_)|*index!=active)
            .map(|(index,state)|(index,state.doc.clone()))
            .collect();
        let base=session.active().unwrap().clone();
        let request=Request::parse("image.adjustments.matchColor").unwrap();
        // 不存在或不存在来源图层必须明确拒绝，不能静默按同图统计。
        assert!(snapshot_for(&request,&json!({"source":5}),&base.doc,active,&others).is_err());
        assert!(snapshot_for(&request,&json!({"source":0,"sourceLayer":999999}),&base.doc,active,&others).is_err());
        // 同文档来源（索引 == 本文档）不需要额外快照。
        assert!(snapshot_for(&request,&json!({"source":active}),&base.doc,active,&others).unwrap().is_empty());
        let frozen=others[0].1.clone();
        let snapshot=snapshot_for(&request,&json!({"source":0}),&base.doc,active,&others).unwrap();
        // 草稿开始后来源文档再改，冻结的快照不变（`Arc` 写时复制）。
        session.set_active(0);
        session.execute("edit.fill",json!({"contents":"color","color":"#00ff00"})).unwrap();
        assert!(Shared::ptr_eq(&snapshot[0].1,&frozen),"来源快照必须指向开始时的文档");
        assert_eq!(document_content_hash(&snapshot[0].1,&Default::default()),document_content_hash(&frozen,&Default::default()));
        // 命令门已放开发布后的 matchColor：现在可以从界面开始草稿，且来源仍是冻结快照。
        let target=session.documents()[1].clone();
        let draft=AdjustmentPreview::new_pixels_in_session(&target,1,&others,"image.adjustments.matchColor",&json!({"source":0}),None)
            .expect("已发布的匹配颜色可以开始草稿");
        assert_eq!(draft.info()["command"],"image.adjustments.matchColor");
        // 范围外的 LUT 即使在本域有命令形状，也不在命令门里：不能被草稿绕过。
        let Err(failure)=AdjustmentPreview::new_pixels_in_session(&target,1,&others,"image.adjustments.colorLookup",&json!({}),None) else {
            panic!("范围外的命令不能开始草稿");
        };
        assert!(failure.message().contains("不是本域实现的调整命令"),"{}",failure.message());
    }

    #[test]
    fn pixel_draft_and_layer_draft_share_one_slot_but_report_their_target() {
        let mut session=Session::new();session.execute("file.new",json!({"width":16,"height":16})).unwrap();
        let base=session.active().unwrap().clone();
        let pixels=AdjustmentPreview::new_pixels(&base,"brightnessContrast",&json!({"brightness":20}),None).unwrap();
        assert_eq!(pixels.info()["mode"],"pixels");
        assert_eq!(pixels.info()["layer"],base.active_layer.unwrap().0);
        session.execute("layer.newAdjustmentLayer.brightnessContrast",json!({})).unwrap();
        let base=session.active().unwrap().clone();
        let layer=AdjustmentPreview::new(&base,base.active_layer.unwrap().0).unwrap();
        assert_eq!(layer.info()["mode"],"adjustmentLayer");
        // 直接调整不接受调整层专属的 `layer` 参数改写目标。
        assert!(AdjustmentPreview::new_pixels(&base,"brightnessContrast",&json!({"layer":1}),None).is_err());
    }
}
