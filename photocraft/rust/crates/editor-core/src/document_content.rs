//! 从上游文档提取**宿主内容描述**（`ImageProjectContent`），并计算文档内容指纹
//! （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.2/3.3 / design D3/D4）。
//!
//! 宿主只持有可比较的内容语义，因此这里把 `photocraft_doc::Document` 折叠成与
//! `web/contracts/src/canvas/image-project-content.ts` 同形的 JSON：
//! - 像素层：基底层的 `sourceAssetId`（宿主在重开时回填）+ `contentHash`（完整稀疏像素内容指纹）；
//! - 文字层：内容、随包字体、字号、颜色、粗体、对齐；
//! - 调整层：首期三类的参数；
//! - 蒙版：`enabled` + 来源 + 完整稀疏像素内容指纹；
//! - 变换/混合/不透明度/显隐/锁定/顺序/画布尺寸。
//!
//! 像素/蒙版指纹覆盖默认像素、格式及所有非默认 tile 的坐标和完整字节，不采样。
//! SHA-256 截取前 64 位以匹配宿主内容契约；产物完整性另由完整 SHA-256 核验。

use std::{cell::RefCell, collections::HashMap, sync::{Arc, Weak}};

use photocraft_doc::{Adjustment, BlendMode, Document, Layer, LayerContent, LayerId};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// 宿主资产身份登记表。
///
/// **内容指纹只覆盖基底层**（`base_asset_id`）。置入层的外部来源不进入指纹：图层 id 每次加载
/// 都会重新编号，工程字节里也没有可稳定重建的「层 → 资产」映射，因此把它算进指纹会让同一份
/// 冻结文档在重开后得到不同指纹（每次重开都被误判为有净变化）。置入来源仍保留在 `placed`
/// 里，供 [`crate::editor::Editor::asset_ids`] 上报给宿主引用集合（`sourceAssetIds`）。
#[derive(Debug, Clone, Default)]
pub struct AssetRegistry {
    /// 基底层（打开工程时的原图）对应的资产 id；由宿主在重开时回填，因此指纹跨重开稳定。
    pub base_asset_id: Option<String>,
    /// 置入产生的层 id → 资产 id（**仅用于上报**，不参与内容指纹）。
    pub placed: HashMap<u64, String>,
    /// 弱引用只缓存不可变 tile 的摘要，不延长像素缓冲寿命。
    fingerprints: RefCell<HashMap<usize, TileFingerprint>>,
}

#[derive(Debug, Clone)]
pub(crate) struct TileFingerprint {
    tile: Weak<photocraft_raster::Tile>,
    default: Vec<u8>,
    digest: Option<[u8; 32]>,
}

impl AssetRegistry {
    pub fn register_placed(&mut self, layer: LayerId, asset_id: impl Into<String>) {
        self.placed.insert(layer.0, asset_id.into());
    }

    pub fn clear(&mut self) {
        self.base_asset_id = None;
        self.placed.clear();
        self.fingerprints.get_mut().clear();
    }
}

/// 把文档折叠成宿主内容描述。
pub fn project_content(doc: &Document, registry: &AssetRegistry) -> Value {
    let mut fingerprints = registry.fingerprints.borrow_mut();
    fingerprints.retain(|_, entry| entry.tile.strong_count() > 0);
    // 播放头只用来判断「视频层显示内容是否已同步」；它本身不进内容身份。
    let playhead = doc.timeline.as_ref().map_or(0, |timeline| timeline.current);
    let mut layers = Vec::with_capacity(doc.layers.len());
    for (index, layer) in doc.layers.iter().enumerate() {
        layers.push(layer_content(layer, index == 0, registry, &mut fingerprints, playhead));
    }
    for layer in &mut layers {
        attach_style(layer, doc);
    }
    let mut content=json!({
        "canvasWidth": doc.size.width.max(1),
        "canvasHeight": doc.size.height.max(1),
        "layers": layers
    });
    if !doc.patterns.is_empty() {
        if !photocraft_project_verify::pattern_support::supported(&doc.patterns) {
            content["patternContentHash"]=json!("unsupported");
        } else {
            let mut patterns:Vec<_>=doc.patterns.iter().collect();patterns.sort_by(|a,b|a.id.cmp(&b.id));
            let resources:Vec<_>=patterns.iter().map(|p|json!({"id":p.id,"name":p.name,"width":p.width,"height":p.height,
                "surface":surface_hash_cached(&p.surface,&mut fingerprints)})).collect();
            let hash:String=Sha256::digest(serde_json::to_vec(&resources).unwrap_or_default())[..8].iter().map(|b|format!("{b:02x}")).collect();
            content["patternContentHash"]=json!(hash);
        }
    }
    // 文档级文字样式表摘要（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）：
    // 字符/段落样式的定义与顺序属内容，改样式表本身也要把工程判脏。空表时本域不写该键，
    // 旧工程指纹保持逐字节兼容（`typography-project-compat.mjs` 验证）。
    if let Some(digest) = type_content::text_styles_digest(&doc.text_styles) {
        content["textStyles"] = json!(digest);
    }
    if crate::smart_identity::contains_smart(&doc.layers) {crate::smart_identity::attach(doc,&mut content);}
    // 时间轴/视频帧（change: 2026-10-22-add-photocraft-animation-workflows）：只有真的带内容时
    // 才追加字段，旧工程的内容描述与指纹因此逐字节不变。
    if let Some(animation) =
        crate::features::animation::content::animation_content_json_cached(doc, &mut fingerprints)
    {
        content["animation"] = animation;
    }
    // 通道是文档级内容（Alpha/专色名称、元数据与平面像素摘要）；空通道不写字段，
    // 旧工程身份逐字节不变（change: 2026-10-22-add-photocraft-channel-workflows，任务 3.2）。
    crate::features::channels::content::attach(doc, &mut content);
    // 变量与数据集是**会随工程持久化**的文档内容（`doc.variables` → `.pcraft` manifest），
    // 因此必须参与内容身份。否则「只改变量/数据集」不改变指纹，宿主会把它当成「未修改」，
    // 脏标记与保存基线一起失效。空变量省略以保持旧工程指纹逐字节兼容。
    if !doc.variables.is_empty() {
        content["variables"] = variables_content(&doc.variables);
    }
    // 模式数据（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
    // 缺省 RGB/8 位/无颜色表/无油墨返回 `None`，因此旧工程与未改模式的工程指纹不变；
    // 灰度/位图/索引色/双色调才追加 `mode` 字段（身份行由 `identity::canonicalize` 追加）。
    if let Some(mode) = crate::features::modes::content::mode_json(doc) {
        content["mode"] = mode;
    }
    // 文档级路径身份：已存命名路径 / 工作路径 / 裁切路径引用，作为**顶层可选字段**并入内容描述。
    // 没有路径时三个字段都不出现（规范化随之省略），因此旧工程指纹不变
    // （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
    if let Value::Object(fields) = vectors_content::document_paths_identity(doc) {
        if let Value::Object(content) = &mut content {
            content.extend(fields);
        }
    }
    content
}

/// 变量与数据集的规范内容描述（只保留参与身份语义的字段）。
///
/// 顺序敏感：定义与数据集的顺序由用户维护，`image.variables.define` 是**整份替换**，
/// 因此重排就是一次内容变化。图层引用随图层 id 走一致的重编号规则（工程加载为
/// `preserve_ids: true`，与图层 `id` 字段同样稳定）。
fn variables_content(variables: &photocraft_doc::variables::Variables) -> Value {
    let defs: Vec<Value> = variables
        .defs
        .iter()
        .map(|def| {
            let mut entry = json!({
                "name": def.name,
                "layer": format!("layer-{}", def.layer.0),
            });
            match &def.kind {
                photocraft_doc::variables::VarKind::Visibility => {
                    entry["type"] = json!("visibility");
                }
                photocraft_doc::variables::VarKind::TextReplacement => {
                    entry["type"] = json!("textReplacement");
                }
                photocraft_doc::variables::VarKind::PixelReplacement { method, align, clip } => {
                    entry["type"] = json!("pixelReplacement");
                    entry["method"] = json!(pixel_method_name(*method));
                    entry["align"] = json!(pixel_align_name(*align));
                    entry["clip"] = json!(*clip);
                }
            }
            entry
        })
        .collect();
    let data_sets: Vec<Value> = variables
        .data_sets
        .iter()
        .map(|set| {
            json!({
                "name": set.name,
                "values": set.values.iter().map(|value| {
                    let (kind, payload) = match &value.value {
                        photocraft_doc::variables::Value::Visibility(show) => ("visibility", json!(show)),
                        photocraft_doc::variables::Value::Text(text) => ("text", json!(text)),
                        photocraft_doc::variables::Value::Pixels(key) => ("pixels", json!(key)),
                    };
                    json!({"variable": value.variable, "kind": kind, "value": payload})
                }).collect::<Vec<_>>(),
            })
        })
        .collect();
    json!({"defs": defs, "dataSets": data_sets})
}

fn pixel_method_name(method: photocraft_doc::PixelMethod) -> &'static str {
    use photocraft_doc::PixelMethod;
    match method {
        PixelMethod::Fit => "fit",
        PixelMethod::Fill => "fill",
        PixelMethod::AsIs => "asIs",
        PixelMethod::Conform => "conform",
    }
}

fn pixel_align_name(align: photocraft_doc::PixelAlign) -> &'static str {
    use photocraft_doc::PixelAlign;
    match align {
        PixelAlign::TopLeft => "topLeft",
        PixelAlign::TopCenter => "topCenter",
        PixelAlign::TopRight => "topRight",
        PixelAlign::CenterLeft => "centerLeft",
        PixelAlign::Center => "center",
        PixelAlign::CenterRight => "centerRight",
        PixelAlign::BottomLeft => "bottomLeft",
        PixelAlign::BottomCenter => "bottomCenter",
        PixelAlign::BottomRight => "bottomRight",
    }
}

/// 使用原始完整样式快照计算摘要；避免在 TS 重建第二套效果模型。
fn attach_style(content: &mut Value, doc: &Document) {
    let id=content["id"].as_str().and_then(|id|id.strip_prefix("layer-")).and_then(|id|id.parse::<u64>().ok());
    if let Some(layer)=id.and_then(|id|doc.layer(LayerId(id))) {
        if !photocraft_project_verify::style_support::supported(&layer.effects,&doc.global_light)
            || photocraft_project_verify::style_support::pattern_references(&layer.effects).iter().any(|(id,name)|!doc.patterns.iter().any(|p|p.id==*id && p.name==*name)) {
            content["effects"]=json!({"enabled":true,"contentHash":"unsupported"});
        } else if !layer.effects.items.is_empty() {
            let data=json!({"items":layer.effects.items,"reference":layer.effects.reference,"light":doc.global_light});
            let bytes=serde_json::to_vec(&data).unwrap_or_default();
            let hash:String=Sha256::digest(&bytes)[..8].iter().map(|b|format!("{b:02x}")).collect();
            content["effects"]=json!({"enabled":layer.effects.enabled,"contentHash":hash});
        }
    }
    if let Some(children)=content.get_mut("children").and_then(Value::as_array_mut) {
        for child in children {attach_style(child,doc);}
    }
}

fn layer_content(layer: &Layer, first_root: bool, registry: &AssetRegistry, fingerprints: &mut HashMap<usize, TileFingerprint>, playhead: usize) -> Value {
    // 视频层的像素平移取「显示内容的包围盒」，而显示内容跟着播放头换帧；若照搬，拖动播放头
    // 就会改变图层变换并因此改变内容身份。视频层的权威内容是帧栈（见
    // `features::animation::content::animation_content_json`），因此这里用恒等变换。
    let transform = if layer.video.is_some() {
        json!({
            "translateX": 0.0, "translateY": 0.0, "scale": 1.0,
            "rotationDegrees": 0.0, "flipHorizontal": false, "flipVertical": false
        })
    } else {
        layer_transform(layer)
    };
    let mask = layer
        .mask
        .as_ref()
        .map(|mask| {
            json!({
                "enabled": mask.enabled,
                "linked": mask.linked,
                "origin": "paint",
                "contentHash": surface_hash_cached(&mask.surface, fingerprints)
            })
        })
        .unwrap_or(Value::Null);
    // 只有基底层携带宿主来源身份：`baseAssetId` 由宿主在重开时回填，指纹因此跨重开稳定。
    // 置入层的外部来源无法从工程字节重建（图层 id 每次加载重新编号），故不进入指纹；
    // 置入来源保留在描述符的 `sourceAssetIds`（宿主侧引用集合）。
    let source_asset_id = if first_root && is_background(layer) {
        registry.base_asset_id.clone()
    } else {
        None
    };
    let (kind, pixel, text, adjustment, shape, fill_layer) = match &layer.content {
        // 画板也是组；`kind` 之后会被改写成 "artboard"，子层内容照常进入指纹。
        LayerContent::Group(_) => (
            "group", Value::Null, Value::Null, Value::Null, Value::Null, Value::Null,
        ),
        LayerContent::Smart(_) => ("smart",Value::Null,Value::Null,Value::Null,Value::Null,Value::Null),
        // 形状层：路径几何是权威内容（缓存只是外观，不参与指纹）；
        // 填充/描边/规范参数同样是持久内容，另以 `appearanceHash` 参与（任务 3.2）。
        LayerContent::Shape(shape_layer) => (
            "shape",
            Value::Null,
            Value::Null,
            Value::Null,
            json!({
                "contentHash": path_hash(&shape_layer.path),
                "appearanceHash": vectors_content::shape_appearance_hash(shape_layer),
            }),
            Value::Null,
        ),
        LayerContent::Raster(surface) => (
            "pixel",
            json!({
                "sourceAssetId": source_asset_id,
                // 视频层的显示内容只是帧栈在播放头处的投影：已同步时用固定标记，避免拖动
                // 播放头把工程变成「已修改」；有未写回编辑时仍用显示内容摘要（编辑不能漏判）。
                "contentHash": match &layer.video {
                    Some(video) => crate::features::animation::content::video_display_hash(
                        playhead, video, surface, fingerprints,
                    ),
                    None => surface_hash_cached(surface, fingerprints),
                },
            }),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
        ),
        LayerContent::Text(text) => {
            let bold = text.font_family.to_ascii_lowercase().contains("bold")
                || text.runs.first().is_some_and(|r| r.style.weight >= 600 || r.style.faux_bold);
            let align = match text.paragraphs.first().map(|p| p.style.align) {
                Some(photocraft_doc::text::TextAlign::Center) | Some(photocraft_doc::text::TextAlign::JustifyCenter) => "center",
                Some(photocraft_doc::text::TextAlign::Right) | Some(photocraft_doc::text::TextAlign::JustifyRight) => "right",
                _ => "left",
            };
            // 排版摘要由本域提供：沿用 `identity.rs` 既有的「平铺可选后缀」形状
            // （`leading`/`tracking`/`baselineShift`/`kerning` 只在非默认时出现，旧工程指纹不变）。
            let mut summary = json!({
                "box": match text.shape {photocraft_doc::text::TextShape::Box{x,y,width,height}=>json!([x,y,width,height]),_=>Value::Null},
                "text": text.text.clone(),
                "fontFamily": text.font_family.clone(),
                "fontSize": text.size_pt,
                "color": hex_color(text.color),
                "bold": bold,
                "align": align,
            });
            type_content::attach_typography(&mut summary, text);
            ("text", Value::Null, summary, Value::Null, Value::Null, Value::Null)
        }
        LayerContent::Adjustment(adjustment) => (
            "adjustment",
            Value::Null,
            Value::Null,
            adjustment_content(adjustment),
            Value::Null,
            Value::Null,
        ),
        // U57：填充层是**可重编内容**——参数是权威，像素只是缓存。
        // 参数放独立字段 `fillLayer`，与既有的 `fill`（填充**不透明度**）区分开。
        LayerContent::Fill(fill) => (
            "fill",
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            fill_content(fill),
        ),
        // 首期清单外的对象在核验与能力层被拒绝；这里给一个明确的占位，使内容指纹可以判定。
        _ => (
            "pixel",
            json!({ "sourceAssetId": source_asset_id, "contentHash": structural_hash(&layer.name) }),
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
        ),
    };
    let mut content = json!({
        "id": format!("layer-{}", layer.id.0),
        "name": layer.name.clone(),
        "kind": kind,
        "visible": layer.visible,
        "opacity": f64::from(layer.opacity.clamp(0.0, 1.0)),
        "fill": f64::from(layer.fill_opacity),
        "locks": layer.locks,
        "blend": blend_name(layer.blend),
        "clipped": layer.clipped,
        "transform": transform,
        "mask": mask,
        "pixel": pixel,
        "text": text,
        "adjustment": adjustment,
        "shape": shape
    });
    // U57：填充参数只在是填充层时出现。旧工程与其它层因此保持原有字段集合（指纹兼容）。
    if !fill_layer.is_null() {
        content["fillLayer"] = fill_layer;
    }
    // 矢量蒙版：摘要进入内容身份（旧工程没有该字段，指纹保持兼容）。
    // 密度与羽化也是持久字段（重开后逐字段还原），必须一起参与，否则只改蒙版浓密/羽化
    // 会被判成无净变化（任务 3.2）。
    if let Some(vector) = &layer.vector_mask {
        content["vectorMask"] = json!({
            "enabled": vector.enabled,
            "linked": vector.linked,
            "density": f64::from(vector.density),
            "feather": f64::from(vector.feather),
            "contentHash": path_hash(&vector.path),
        });
    }
    if let LayerContent::Group(group) = &layer.content {
        // 画板的分隔标记保留（旧工程指纹兼容），子层内容同样进入指纹——否则画板内的像素/结构
        // 改动不会改变内容 hash，「是否净变化」与保存门禁就都失效了。
        if group.artboard.is_some() {
            content["kind"] = json!("artboard");
        }
        content["children"] = Value::Array(group.children.iter()
            .map(|child| layer_content(child, false, registry, fingerprints, playhead)).collect());
    }
    content
}

fn is_background(layer: &Layer) -> bool {
    layer.name.eq_ignore_ascii_case("background") || layer.locks.transparency
}

/// 图层变换：文字层从内容仿射矩阵分解；像素层的平移取像素内容包围盒左上角（上游把平移烘焙进
/// 像素，其余分量因此恒等）。其他对象类型在核验层已被拒绝，这里给恒等值。

/// 颜色转 `#rrggbb`（内容指纹要求该形式）。

/// 完整稀疏内容指纹，包含画布外的像素；默认 tile 不构成内容变化。
/// 同一表面共享的不可变 tile 只扫描一次，不分配整张画布的连续像素缓冲。
pub fn surface_hash(surface: &photocraft_doc::Surface) -> String {
    surface_hash_cached(surface, &mut HashMap::new())
}

pub(crate) fn surface_hash_cached(surface: &photocraft_doc::Surface, tiles: &mut HashMap<usize, TileFingerprint>) -> String {
    let mut hash = Sha256::new();
    hash.update(b"photocraft-surface-v2:");
    hash.update(format!("{:?}", surface.format()).as_bytes());
    let default = surface.default_bytes();
    hash.update(default);
    // Surface 使用 BTreeMap，遍历顺序不受分配或插入顺序影响。
    for (coord, tile) in surface.tiles() {
        let key = Arc::as_ptr(tile) as usize;
        let reusable = tiles.get(&key).is_some_and(|entry| entry.default == default
            && entry.tile.upgrade().is_some_and(|cached| Arc::ptr_eq(&cached, tile)));
        if !reusable {
            let digest = if tile.bytes().chunks_exact(default.len()).all(|pixel| pixel == default) {
                None
            } else {
                Some(Sha256::digest(tile.bytes()).into())
            };
            tiles.insert(key, TileFingerprint { tile: Arc::downgrade(tile), default: default.to_vec(), digest });
        }
        if let Some(digest) = tiles.get(&key).and_then(|entry| entry.digest) {
            hash.update(coord.tx.to_le_bytes());
            hash.update(coord.ty.to_le_bytes());
            hash.update(digest);
        }
    }
    hash.finalize()[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 路径几何摘要：节点、控制柄、闭合与填充规则都进入指纹（规范 1e-4 精度）。

/// 与内容指纹其他数值一致：四舍五入到 1e-4 后按固定宽度写字节。

/// 结构性指纹（无像素内容时的可判定摘要，例如清单外对象的占位）。
fn structural_hash(text: &str) -> String {
    crate::identity::fnv1a64_hex(text)
}

/// 文档内容指纹（编辑器上报的 `documentContentHash`）。
pub fn document_content_hash(doc: &Document, registry: &AssetRegistry) -> Option<String> {
    crate::identity::content_hash(&project_content(doc, registry))
}

#[cfg(test)]
#[path = "document_content/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "document_content/modes_identity_tests.rs"]
mod modes_identity_tests;

use adjustments_content::adjustment_content;
use composition_content::layer_transform;
use vectors_content::path_hash;
use layers_content::{blend_name, fill_content};
use type_content::hex_color;
#[path = "features/adjustments/content.rs"]
mod adjustments_content;
#[path = "features/composition/content.rs"]
mod composition_content;
#[path = "features/vectors/content.rs"]
mod vectors_content;
#[path = "features/layers/content.rs"]
mod layers_content;
#[path = "features/type/content.rs"]
mod type_content;
