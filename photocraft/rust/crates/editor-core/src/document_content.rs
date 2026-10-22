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
struct TileFingerprint {
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
    let mut layers = Vec::with_capacity(doc.layers.len());
    for (index, layer) in doc.layers.iter().enumerate() {
        layers.push(layer_content(layer, index == 0, registry, &mut fingerprints));
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
    if crate::smart_identity::contains_smart(&doc.layers) {crate::smart_identity::attach(doc,&mut content);}
    content
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

fn layer_content(layer: &Layer, first_root: bool, registry: &AssetRegistry, fingerprints: &mut HashMap<usize, TileFingerprint>) -> Value {
    let transform = layer_transform(layer);
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
    let (kind, pixel, text, adjustment) = match &layer.content {
        LayerContent::Group(group) if group.artboard.is_none() => (
            "group", Value::Null, Value::Null, Value::Null,
        ),
        LayerContent::Smart(_) => ("smart",Value::Null,Value::Null,Value::Null),
        LayerContent::Raster(surface) => (
            "pixel",
            json!({ "sourceAssetId": source_asset_id, "contentHash": surface_hash_cached(surface, fingerprints) }),
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
            (
                "text",
                Value::Null,
                json!({
                    "box": match text.shape {photocraft_doc::text::TextShape::Box{x,y,width,height}=>json!([x,y,width,height]),_=>Value::Null},
                    "text": text.text.clone(),
                    "fontFamily": text.font_family.clone(),
                    "fontSize": text.size_pt,
                    "color": hex_color(text.color),
                    "bold": bold,
                    "align": align
                }),
                Value::Null,
            )
        }
        LayerContent::Adjustment(adjustment) => (
            "adjustment",
            Value::Null,
            Value::Null,
            adjustment_content(adjustment),
        ),
        // 首期清单外的对象在核验与能力层被拒绝；这里给一个明确的占位，使内容指纹可以判定。
        _ => (
            "pixel",
            json!({ "sourceAssetId": source_asset_id, "contentHash": structural_hash(&layer.name) }),
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
        "adjustment": adjustment
    });
    if let LayerContent::Group(group) = &layer.content {
        // 画板尚未开放，不能以普通组身份生成可保存指纹。
        if group.artboard.is_some() {
            content["kind"] = json!("artboard");
        } else {
            content["children"] = Value::Array(group.children.iter()
                .map(|child| layer_content(child, false, registry, fingerprints)).collect());
        }
    }
    content
}

fn is_background(layer: &Layer) -> bool {
    layer.name.eq_ignore_ascii_case("background") || layer.locks.transparency
}

/// 图层变换：文字层从内容仿射矩阵分解；像素层的平移取像素内容包围盒左上角（上游把平移烘焙进
/// 像素，其余分量因此恒等）。其他对象类型在核验层已被拒绝，这里给恒等值。
fn layer_transform(layer: &Layer) -> Value {
    match &layer.content {
        LayerContent::Text(text) => {
            let [a, b, c, d, e, f] = text.transform.m;
            let scale = (a * a + b * b).sqrt();
            let rotation_degrees = b.atan2(a).to_degrees();
            let det = a * d - b * c;
            json!({
                "translateX": e,
                "translateY": f,
                "scale": if scale > 0.0 { scale } else { 1.0 },
                "rotationDegrees": rotation_degrees,
                "flipHorizontal": det < 0.0,
                "flipVertical": false
            })
        }
        LayerContent::Raster(surface) => {
            let bounds = surface.content_bounds();
            json!({
                "translateX": bounds.x0,
                "translateY": bounds.y0,
                "scale": 1.0,
                "rotationDegrees": 0.0,
                "flipHorizontal": false,
                "flipVertical": false
            })
        }
        _ => json!({
            "translateX": 0.0,
            "translateY": 0.0,
            "scale": 1.0,
            "rotationDegrees": 0.0,
            "flipHorizontal": false,
            "flipVertical": false
        }),
    }
}

fn adjustment_content(adjustment: &Adjustment) -> Value {
    match adjustment {
        Adjustment::BrightnessContrast { brightness, contrast, .. } => json!({
            "kind": "brightness-contrast",
            "parameters": { "kind": "brightness-contrast", "brightness": brightness, "contrast": contrast }
        }),
        Adjustment::HueSaturation { hue, saturation, lightness, .. } => json!({
            "kind": "hue-saturation",
            "parameters": { "kind": "hue-saturation", "hue": hue, "saturation": saturation, "lightness": lightness }
        }),
        Adjustment::Curves { master, .. } => json!({
            "kind": "curves",
            "parameters": {
                "kind": "curves",
                "rgb": master.iter().map(|point| json!({ "x": point.input, "y": point.output })).collect::<Vec<_>>()
            }
        }),
        // 首期清单外的调整在核验层被拒绝；这里给出可判定的占位。
        _ => json!({ "kind": "brightness-contrast", "parameters": { "kind": "brightness-contrast", "brightness": 0.0, "contrast": 0.0 } }),
    }
}

fn blend_name(blend: BlendMode) -> &'static str {
    photocraft_project_verify::blend_modes::canonical_blend_name(blend).unwrap_or("unsupported")
}

/// 颜色转 `#rrggbb`（内容指纹要求该形式）。
fn hex_color(color: photocraft_doc::Color) -> String {
    let [r, g, b] = color.to_rgb();
    format!(
        "#{:02x}{:02x}{:02x}",
        (r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (b.clamp(0.0, 1.0) * 255.0).round() as u8
    )
}

/// 完整稀疏内容指纹，包含画布外的像素；默认 tile 不构成内容变化。
/// 同一表面共享的不可变 tile 只扫描一次，不分配整张画布的连续像素缓冲。
pub fn surface_hash(surface: &photocraft_doc::Surface) -> String {
    surface_hash_cached(surface, &mut HashMap::new())
}

fn surface_hash_cached(surface: &photocraft_doc::Surface, tiles: &mut HashMap<usize, TileFingerprint>) -> String {
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
