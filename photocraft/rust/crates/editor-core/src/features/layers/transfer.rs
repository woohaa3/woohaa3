//! 跨文档图层载荷（`LayerTransferBundle`）与工作区剪贴板
//! （change: 2026-10-22-complete-photocraft-webui-editing，P2 / design D5）。
//!
//! ## 载荷是自包含的
//!
//! 载荷 = **版本化头 + 摘要 + 一个 `.pcraft` 工程容器**，容器里只放被复制的图层与它们引用的
//! 资源（图案、嵌入智能对象源、文字、调整参数）。因此：
//!
//! - 源文档关闭后载荷仍然有效（不持有活的内核指针、图层 id 或宿主节点）；
//! - 资源跟着走，不需要第二次读取源文档；
//! - 摘要覆盖容器字节，任何篡改或截断在解码阶段被拒绝。
//!
//! JS 不拼写层结构：导出与导入都由本模块完成，React 只搬运字节。
//!
//! ## 导入是原子的
//!
//! 导入先在**候选文档**上完成解码、核验、身份重映射与布局计算，全部成功后才通过
//! `preview_history::commit_selected` 提交一步历史。任何失败都不改变目标文档、板外资源或历史。
//!
//! ## 身份重映射
//!
//! - 图层：容器用 `preserve_ids: false` 载入，因此每个图层拿到**新 LayerId**；
//! - 图案：同 id 同内容复用目标资源；同 id 不同内容分配新 id 并改写全部引用；
//! - 智能对象：`contents_id` 在容器内保留（载荷内部的共享关系），跨文档默认独立化源，
//!   与目标已有 contents_id 冲突时换新 id。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use photocraft_doc::{Document, Layer, LayerContent, LayerId, Pattern};
use photocraft_engine::Session;
use photocraft_project_verify::limits;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{EditorError, Result};

/// 载荷容器签名（版本化；编码不兼容才升级）。
const SIGNATURE: &[u8; 8] = b"WHLT0001";
/// 载荷格式版本。
pub const TRANSFER_VERSION: u32 = 1;
/// 头部元数据（JSON）字节上限。
const MAX_METADATA_BYTES: usize = 1 << 20;

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "edit.layerTransfer".into(), message: message.to_string() }
}

/// 载荷头：版本、来源尺寸、布局锚点、摘要与图案清单。
#[derive(Clone, Debug, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferMeta {
    version: u32,
    /// 源文档画布尺寸（原位粘贴与居中放置都用它换算）。
    source_width: u32,
    source_height: u32,
    /// 载荷顶层内容的包围盒左上角（源文档像素坐标）；`null` 表示空内容。
    anchor: Option<[i32; 2]>,
    /// 容器字节的 SHA-256（64 位小写 hex）。
    digest: String,
    /// 容器的图层总数（含组内子层）。
    layer_count: usize,
    /// 载荷图案资源（id + name），供导入时判断冲突。
    patterns: Vec<PatternRef>,
    /// 载荷里智能对象的 contents_id → 源名称；跨文档导入据此独立化。
    smart_sources: Vec<SmartRef>,
}

#[derive(Clone, Debug, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatternRef {
    id: String,
    name: String,
}

#[derive(Clone, Debug, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SmartRef {
    /// 载荷内共享分组（`SmartContentsId` 的十进制值）。
    contents_id: u64,
    /// 源名称；用于冲突恢复提示。
    file_name: String,
}

/// 一份已解码并通过摘要校验的载荷。
pub struct TransferBundle {
    meta: TransferMeta,
    document: Document,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 统计图层数与来源包围盒。
fn inspect(layers: &[Layer], canvas: photocraft_geom::Rect) -> (usize, photocraft_geom::Rect) {
    fn walk(layer: &Layer, canvas: photocraft_geom::Rect, count: &mut usize, bounds: &mut photocraft_geom::Rect) {
        *count += 1;
        match &layer.content {
            LayerContent::Group(group) => {
                for child in &group.children {
                    walk(child, canvas, count, bounds);
                }
            }
            LayerContent::Raster(surface) => {
                let content = surface.content_bounds();
                if !content.is_empty() {
                    *bounds = bounds.union(&content);
                }
            }
            LayerContent::Adjustment(_) | LayerContent::Fill(_) => {
                // 调整／填充层覆盖整幅画布：把锚点拉到画布原点，避免居中时偏出。
                *bounds = bounds.union(&canvas);
            }
            LayerContent::Text(text) => {
                if let Some(cache) = &text.cache {
                    let content = cache.content_bounds();
                    if !content.is_empty() {
                        *bounds = bounds.union(&content);
                    }
                }
            }
            LayerContent::Shape(shape) => {
                if let Some(cache) = &shape.cache {
                    let content = cache.content_bounds();
                    if !content.is_empty() {
                        *bounds = bounds.union(&content);
                    }
                }
            }
            LayerContent::Smart(smart) => {
                if let Some(cache) = &smart.cache {
                    let content = cache.content_bounds();
                    if !content.is_empty() {
                        *bounds = bounds.union(&content);
                    }
                }
            }
        }
    }
    let mut count = 0;
    let mut bounds = photocraft_geom::Rect::EMPTY;
    for layer in layers {
        walk(layer, canvas, &mut count, &mut bounds);
    }
    (count, bounds)
}

/// 从当前文档导出所选图层为自包含载荷。
///
/// `ids` 为空时导出当前选择；祖先与后代同时给出时只导出祖先（与复制语义一致）。
pub fn export(session: &Session, ids: &[LayerId]) -> Result<Vec<u8>> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let document = &state.doc;
    let targets: Vec<LayerId> = if ids.is_empty() {
        crate::layer_preview::selected_roots(state)
    } else {
        let mut chosen = state.clone();
        chosen.selected_layers = ids.to_vec();
        chosen.active_layer = ids.last().copied();
        crate::layer_preview::selected_roots(&chosen)
    };
    if targets.is_empty() {
        return Err(error("请先选择要复制的图层"));
    }
    let mut layers = Vec::with_capacity(targets.len());
    for id in &targets {
        layers.push(document.layer(*id).cloned().ok_or_else(|| error("目标图层不存在"))?);
    }
    let (count, bounds) = inspect(&layers, document.bounds());
    if count > limits::MAX_LAYER_TRANSFER_LAYERS {
        return Err(error(format!(
            "载荷图层数超过上限（{}）",
            limits::MAX_LAYER_TRANSFER_LAYERS
        )));
    }
    // 容器只携带被复制的图层；画布尺寸保持源尺寸，便于原位粘贴换算坐标。
    let mut carrier = Document::new(
        "Layer transfer",
        document.size,
        document.mode,
        document.depth,
    );
    carrier.resolution_dpi = document.resolution_dpi;
    carrier.layers = layers.clone();
    carrier.patterns = document.patterns.clone();
    // 智能对象源可能引用目标文档的其它图案/源字节：容器已随图层一起携带。
    let project = photocraft_format::save_to_bytes(&carrier, &Default::default()).map_err(error)?;
    if project.len() > limits::MAX_LAYER_TRANSFER_BYTES {
        return Err(error(format!(
            "载荷超过 {} MiB",
            limits::MAX_LAYER_TRANSFER_BYTES / (1024 * 1024)
        )));
    }
    let digest = hex(&Sha256::digest(&project));
    let mut smart_sources: Vec<SmartRef> = Vec::new();
    let mut seen = HashSet::new();
    collect_smart(&layers, &mut smart_sources, &mut seen);
    let meta = TransferMeta {
        version: TRANSFER_VERSION,
        source_width: document.size.width.max(1),
        source_height: document.size.height.max(1),
        anchor: (!bounds.is_empty()).then(|| [bounds.x0, bounds.y0]),
        digest,
        layer_count: count,
        patterns: carrier
            .patterns
            .iter()
            .map(|pattern| PatternRef { id: pattern.id.clone(), name: pattern.name.clone() })
            .collect(),
        smart_sources,
    };
    let metadata = serde_json::to_vec(&meta).map_err(error)?;
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(error("载荷元数据超限"));
    }
    let mut bytes = Vec::with_capacity(12 + metadata.len() + project.len());
    bytes.extend_from_slice(SIGNATURE);
    bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&metadata);
    bytes.extend_from_slice(&project);
    if bytes.len() > limits::MAX_LAYER_TRANSFER_BYTES {
        return Err(error("载荷超过字节预算"));
    }
    Ok(bytes)
}

fn collect_smart(layers: &[Layer], out: &mut Vec<SmartRef>, seen: &mut HashSet<u64>) {
    for layer in layers {
        match &layer.content {
            LayerContent::Group(group) => collect_smart(&group.children, out, seen),
            LayerContent::Smart(smart) => {
                let id = smart.contents_id.0;
                if seen.insert(id) {
                    let file_name = match &smart.source {
                        photocraft_doc::SmartSource::Embedded { file_name, .. } => file_name.clone(),
                        photocraft_doc::SmartSource::Linked { path } => path.clone(),
                    };
                    out.push(SmartRef { contents_id: id, file_name });
                }
            }
            _ => {}
        }
    }
}

/// 解码载荷：结构、版本、摘要、图层预算与工程核验全部通过才返回。
pub fn decode(bytes: &[u8]) -> Result<TransferBundle> {
    if bytes.is_empty() {
        return Err(error("载荷为空"));
    }
    if bytes.len() > limits::MAX_LAYER_TRANSFER_BYTES {
        return Err(error(format!(
            "载荷超过 {} MiB",
            limits::MAX_LAYER_TRANSFER_BYTES / (1024 * 1024)
        )));
    }
    if bytes.get(..8) != Some(SIGNATURE.as_slice()) {
        return Err(error("载荷格式无效或版本不受支持"));
    }
    let length = bytes
        .get(8..12)
        .ok_or_else(|| error("载荷头不完整"))?;
    let length = u32::from_be_bytes(length.try_into().unwrap()) as usize;
    if length > MAX_METADATA_BYTES {
        return Err(error("载荷元数据超限"));
    }
    let end = 12 + length;
    let metadata = bytes.get(12..end).ok_or_else(|| error("载荷元数据不完整"))?;
    let meta: TransferMeta = serde_json::from_slice(metadata).map_err(|failure| error(format!("载荷元数据非法：{failure}")))?;
    if meta.version != TRANSFER_VERSION {
        return Err(error(format!(
            "载荷版本不受支持：{}（本构建支持 {}）",
            meta.version, TRANSFER_VERSION
        )));
    }
    let project = &bytes[end..];
    let digest = hex(&Sha256::digest(project));
    if digest != meta.digest {
        return Err(error("载荷摘要不符（内容被截断或修改）"));
    }
    if meta.layer_count == 0 || meta.layer_count > limits::MAX_LAYER_TRANSFER_LAYERS {
        return Err(error("载荷图层数非法"));
    }
    // 复用原生工程核验（含嵌套智能对象源与累计预算），允许嵌入源但拒绝外链。
    photocraft_project_verify::smart_source::verify_project(project)
        .map_err(|failure| error(failure.message))?;
    let document = photocraft_format::load_from_bytes(project)
        .map_err(|failure| error(format!("载荷容器无法解析：{failure}")))?;
    // 双重核对：实际图层数与元数据一致，避免元数据与内容脱节。
    let (count, _) = inspect(&document.layers, document.bounds());
    if count != meta.layer_count {
        return Err(error("载荷图层数与元数据不一致"));
    }
    Ok(TransferBundle { meta, document })
}

/// 载荷摘要（64 位 hex）；工作区据此去重与提示来源。
pub fn digest(bundle: &TransferBundle) -> &str {
    &bundle.meta.digest
}

impl TransferBundle {
    /// 载荷摘要。
    pub fn content_digest(&self) -> &str {
        &self.meta.digest
    }
    /// 图层数（含组内子层）。
    pub fn layer_count(&self) -> usize {
        self.meta.layer_count
    }
    /// 来源画布尺寸。
    pub fn source_size(&self) -> (u32, u32) {
        (self.meta.source_width, self.meta.source_height)
    }
    /// 来源锚点（源像素坐标）。
    pub fn anchor(&self) -> Option<[i32; 2]> {
        self.meta.anchor
    }
}

/// 粘贴布局：原位保留源像素位置，普通粘贴把整组移到目标可见中心。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PastePlacement {
    InPlace,
    Center,
}

/// 粘贴一次载荷：身份重映射 + 布局 + 一步历史。
///
/// `center` 是目标可见中心（文档像素坐标）；只在 `Center` 布局使用。
pub fn paste(
    session: &mut Session,
    bytes: &[u8],
    placement: PastePlacement,
    center: Option<[f64; 2]>,
) -> Result<Value> {
    let bundle = decode(bytes)?;
    let base = session.active().ok_or(EditorError::NoDocument)?.clone();
    if base.doc.effective_locks(base.active_layer.unwrap_or(LayerId(0))).all && base.active_layer.is_some() {
        // 目标活动层整体锁定不阻止在文档其它位置插入；只有文档级只读在这里表达。
    }
    let added = bundle.meta.layer_count;
    let existing = crate::layer_preview::layer_count(&base.doc.layers);
    if existing.saturating_add(added) > limits::MAX_LAYERS {
        return Err(error(format!(
            "粘贴后图层数超过工程上限（64 层）：{} + {}",
            existing, added
        )));
    }
    let mut candidate = (*base.doc).clone();
    // 1) 图案身份：同 id 同内容复用，同 id 不同内容换新 id 并改写引用。
    let pattern_map = merge_patterns(&mut candidate, &bundle.document.patterns)?;
    // 2) 智能对象 contents_id：载荷内部保留共享，跨文档独立化。
    let smart_map = merge_smart_identities(&mut candidate, &bundle.document, &bundle.meta.smart_sources);
    // 3) 图层：容器已用新 LayerId；再按布局整体平移。
    let mut layers: Vec<Layer> = bundle.document.layers.clone();
    for layer in &mut layers {
        rewrite_patterns(layer, &pattern_map);
        rewrite_smart(layer, &smart_map);
    }
    let (_, bounds) = inspect(&layers, bundle.document.bounds());
    let (dx, dy) = match placement {
        PastePlacement::InPlace => {
            // 原位粘贴：容器已按源画布坐标保存，因此**不再平移**（否则会二次偏移）。
            (0, 0)
        }
        PastePlacement::Center => {
            let target = center.unwrap_or([
                f64::from(candidate.size.width) / 2.0,
                f64::from(candidate.size.height) / 2.0,
            ]);
            if bounds.is_empty() {
                (0, 0)
            } else {
                let source_center = (
                    (f64::from(bounds.x0) + f64::from(bounds.x1)) / 2.0,
                    (f64::from(bounds.y0) + f64::from(bounds.y1)) / 2.0,
                );
                (
                    (target[0] - source_center.0).round() as i32,
                    (target[1] - source_center.1).round() as i32,
                )
            }
        }
    };
    if dx != 0 || dy != 0 {
        for layer in &mut layers {
            translate_layer(layer, dx, dy);
        }
    }
    // 4) 插入到活动层之上（无活动层时放到最上）。
    let above = base.active_layer;
    let roots = layers.len();
    let mut inserted = Vec::with_capacity(roots);
    for layer in layers {
        let id = candidate.insert_above(above, layer);
        inserted.push(id);
    }
    if inserted.len() != roots {
        return Err(error("载荷图层与容器图层数不一致"));
    }
    let active = inserted.last().copied();
    crate::preview_history::commit_selected(
        session,
        Arc::new(candidate),
        active,
        inserted.clone(),
        "粘贴图层",
    )
    .map_err(error)?;
    Ok(json!({
        "layers": inserted.iter().map(|id| id.0).collect::<Vec<_>>(),
        "count": inserted.len(),
        "digest": bundle.meta.digest,
        "offset": [dx, dy],
        "patterns": pattern_map.len(),
    }))
}

/// 图案合并：返回 旧 id → 新 id（或同 id）。
///
/// 三级判定：目标没有该 id → 直接沿用；同 id 同内容 → 复用；同 id 不同内容 → 先找目标里
/// **内容等价**的图案复用其 id（避免重复导入同一载荷堆积资源），找不到才分配新 id。
fn merge_patterns(candidate: &mut Document, incoming: &[Pattern]) -> Result<HashMap<String, String>> {
    let mut map = HashMap::new();
    for pattern in incoming {
        let existing = candidate.patterns.iter().find(|own| own.id == pattern.id);
        match existing {
            None => {
                candidate.patterns.push(pattern.clone());
                map.insert(pattern.id.clone(), pattern.id.clone());
            }
            Some(own) if same_pattern(own, pattern) => {
                // 等价资源复用：不改身份，也不重复占用预算。
                map.insert(pattern.id.clone(), own.id.clone());
            }
            Some(own) => {
                // 同 id 不同内容：先按内容复用目标里已有的等价资源。
                if let Some(equivalent) = candidate
                    .patterns
                    .iter()
                    .find(|other| same_pattern_content(other, pattern))
                {
                    map.insert(pattern.id.clone(), equivalent.id.clone());
                    continue;
                }
                let mut next = pattern.clone();
                // 冲突 id：分配新身份，并改写所有引用。
                let fresh = unique_pattern_id(&candidate.patterns, own.id.as_str());
                next.id = fresh.clone();
                candidate.patterns.push(next);
                map.insert(pattern.id.clone(), fresh);
            }
        }
    }
    if !photocraft_project_verify::pattern_support::supported(&candidate.patterns) {
        return Err(error("粘贴后的图案资源超过工程预算"));
    }
    Ok(map)
}

/// 图案内容等价（忽略 id）：名称、尺寸与像素一致即等价资源。
fn same_pattern_content(a: &Pattern, b: &Pattern) -> bool {
    a.name == b.name && a.width == b.width && a.height == b.height && a.surface == b.surface
}

fn same_pattern(a: &Pattern, b: &Pattern) -> bool {
    a.id == b.id && same_pattern_content(a, b)
}

fn unique_pattern_id(patterns: &[Pattern], base: &str) -> String {
    for index in 1..10_000u32 {
        let candidate = format!("{base}-x{index}");
        if !patterns.iter().any(|pattern| pattern.id == candidate) {
            return candidate;
        }
    }
    format!("{base}-x")
}

/// 智能对象共享身份：载荷内共享组保持不变，与目标已有 identity 冲突时换新。
fn merge_smart_identities(
    candidate: &mut Document,
    incoming: &Document,
    refs: &[SmartRef],
) -> HashMap<u64, u64> {
    let mut used: HashSet<u64> = candidate
        .walk()
        .into_iter()
        .filter_map(|(_, _, layer)| match &layer.content {
            LayerContent::Smart(smart) => Some(smart.contents_id.0),
            _ => None,
        })
        .collect();
    let mut map = HashMap::new();
    for reference in refs {
        if used.insert(reference.contents_id) {
            map.insert(reference.contents_id, reference.contents_id);
        } else {
            // 独立化：分配新的共享身份（载荷内部仍共享同一个新 id）。
            let next = photocraft_doc::SmartContentsId::fresh().0;
            used.insert(next);
            map.insert(reference.contents_id, next);
        }
    }
    // 载荷里未被元数据覆盖的实例（防御性）：也做独立化。
    for (_, _, layer) in incoming.walk() {
        if let LayerContent::Smart(smart) = &layer.content {
            let id = smart.contents_id.0;
            if !map.contains_key(&id) {
                let next = photocraft_doc::SmartContentsId::fresh().0;
                used.insert(next);
                map.insert(id, next);
            }
        }
    }
    map
}

fn rewrite_patterns(layer: &mut Layer, map: &HashMap<String, String>) {
    if map.is_empty() {
        return;
    }
    for effect in &mut layer.effects.items {
        if let Some(id) = effect_pattern_id(effect) {
            if let Some(next) = map.get(&id) {
                set_effect_pattern_id(effect, next);
            }
        }
    }
    if let LayerContent::Group(group) = &mut layer.content {
        for child in &mut group.children {
            rewrite_patterns(child, map);
        }
    }
}

fn effect_pattern_id(effect: &photocraft_doc::Effect) -> Option<String> {
    match effect {
        photocraft_doc::Effect::PatternOverlay { id, .. } => Some(id.clone()),
        photocraft_doc::Effect::Stroke(stroke) => match &stroke.paint {
            photocraft_doc::FxPaint::Pattern { id, .. } => Some(id.clone()),
            _ => None,
        },
        photocraft_doc::Effect::OuterGlow(glow) | photocraft_doc::Effect::InnerGlow(glow) => match &glow.paint {
            photocraft_doc::FxPaint::Pattern { id, .. } => Some(id.clone()),
            _ => None,
        },
        photocraft_doc::Effect::BevelEmboss(bevel) => bevel.texture.as_ref().map(|texture| texture.id.clone()),
        _ => None,
    }
}

fn set_effect_pattern_id(effect: &mut photocraft_doc::Effect, next: &str) {
    match effect {
        photocraft_doc::Effect::PatternOverlay { id, .. } => *id = next.to_string(),
        photocraft_doc::Effect::Stroke(stroke) => {
            if let photocraft_doc::FxPaint::Pattern { id, .. } = &mut stroke.paint {
                *id = next.to_string();
            }
        }
        photocraft_doc::Effect::OuterGlow(glow) | photocraft_doc::Effect::InnerGlow(glow) => {
            if let photocraft_doc::FxPaint::Pattern { id, .. } = &mut glow.paint {
                *id = next.to_string();
            }
        }
        photocraft_doc::Effect::BevelEmboss(bevel) => {
            if let Some(texture) = &mut bevel.texture {
                texture.id = next.to_string();
            }
        }
        _ => {}
    }
}

fn rewrite_smart(layer: &mut Layer, map: &HashMap<u64, u64>) {
    match &mut layer.content {
        LayerContent::Group(group) => {
            for child in &mut group.children {
                rewrite_smart(child, map);
            }
        }
        LayerContent::Smart(smart) => {
            if let Some(next) = map.get(&smart.contents_id.0) {
                smart.contents_id = photocraft_doc::SmartContentsId(*next);
            }
        }
        _ => {}
    }
}

/// 图层整体平移：像素层用 `Surface::translated`，文字/形状/智能对象改自己的变换。
fn translate_layer(layer: &mut Layer, dx: i32, dy: i32) {
    let a = photocraft_geom::Affine::translate(f64::from(dx), f64::from(dy));
    match &mut layer.content {
        LayerContent::Raster(surface) => {
            let content = surface.content_bounds();
            *surface = surface.translated(dx, dy, content);
        }
        LayerContent::Text(text) => {
            text.transform = a.then(&text.transform);
        }
        LayerContent::Shape(shape) => {
            // 形状层：路径与缓存都跟着走（矢量几何是权威，缓存只是外观）。
            shape.path = shape.path.transform(&a);
            if let Some(cache) = &shape.cache {
                let content = cache.content_bounds();
                shape.cache = Some(cache.translated(dx, dy, content));
            }
        }
        LayerContent::Smart(smart) => {
            smart.transform = a.then(&smart.transform);
            if let Some(cache) = &smart.cache {
                let content = cache.content_bounds();
                smart.cache = Some(cache.translated(dx, dy, content));
            }
        }
        _ => {}
    }
    // 矢量蒙版跟随图层：链接时用内核算子变换；未链接保持原位（Photoshop 语义）。
    if let Some(mask) = &mut layer.vector_mask {
        if mask.linked {
            mask.path = mask.path.transform(&a);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use photocraft_doc::{Affine, Color, ColorMode, SampleType, Size, SmartObject, SmartSource, Surface};

    fn document(name: &str, width: u32, height: u32) -> Document {
        Document::with_background(
            name,
            Size::new(width, height),
            ColorMode::Rgb,
            SampleType::U8,
            Color::rgb(0.9, 0.9, 0.9),
        )
    }

    fn session(document: Document) -> Session {
        let mut session = Session::new();
        session.add_document(document, None);
        session
    }

    fn paint_layer(name: &str, rect: photocraft_geom::Rect) -> Layer {
        let mut layer = Layer::raster(name, photocraft_color::PixelFormat::RGBA8);
        if let LayerContent::Raster(surface) = &mut layer.content {
            surface.fill_rect(rect, &[0.2, 0.4, 0.6, 1.0]);
        }
        layer
    }

    #[test]
    fn export_and_import_round_trip_a_group_with_mask_styles_and_text() {
        let mut source_doc = document("源", 120, 90);
        let mut child = paint_layer("子", photocraft_geom::Rect::new(10, 12, 40, 30));
        child.mask = Some(photocraft_doc::LayerMask::reveal_all());
        child.opacity = 0.6;
        let mut group = Layer::group("组", vec![child]);
        group.fill_opacity = 0.4;
        let text = Layer::new(
            "标题",
            LayerContent::Text(photocraft_doc::TextLayer {
                text: "跨文档".into(),
                font_family: "Inter".into(),
                ..Default::default()
            }),
        );
        let group_id = group.id;
        source_doc.layers.push(group);
        source_doc.layers.push(text);

        let source = session(source_doc);
        let bytes = export(&source, &[group_id]).unwrap();
        let bundle = decode(&bytes).unwrap();
        assert_eq!(bundle.layer_count(), 2, "组 + 子层");
        assert_eq!(bundle.source_size(), (120, 90));
        assert_eq!(bundle.anchor(), Some([10, 12]));

        let mut target = session(document("目标", 200, 150));
        let before = target.active().unwrap().clone();
        let result = paste(&mut target, &bytes, PastePlacement::InPlace, None).unwrap();
        assert_eq!(result["count"], 1, "只插入顶层组");
        let state = target.active().unwrap();
        assert_eq!(state.history.past_len(), before.history.past_len() + 1);
        let inserted = result["layers"][0].as_u64().unwrap();
        let layer = state.doc.layer(LayerId(inserted)).unwrap();
        assert_eq!(layer.name, "组");
        assert_eq!(layer.fill_opacity, 0.4);
        let child = &layer.children().unwrap()[0];
        assert_eq!(child.name, "子");
        assert!(child.mask.is_some());
        assert_eq!(child.opacity, 0.6);
        // 子层像素保持源文档坐标（原位粘贴不平移）。
        if let LayerContent::Raster(surface) = &child.content {
            let bounds = surface.content_bounds();
            assert_eq!((bounds.x0, bounds.y0), (10, 12), "子层保持源像素坐标");
            assert_eq!(surface.sample_channel(10, 12, 0), 0.2f32);
        } else {
            panic!("子层应是像素层");
        }
        // 撤销一次移除本次粘贴。
        target.execute("edit.undo", Value::Null).unwrap();
        assert_eq!(target.active().unwrap().doc.layer(LayerId(inserted)), None);
        assert_eq!(target.active().unwrap().selected_layers(), before.selected_layers());
    }

    #[test]
    fn center_paste_places_the_collection_at_the_target_center() {
        let mut source_doc = document("源", 100, 100);
        let layer = paint_layer("方块", photocraft_geom::Rect::new(0, 0, 10, 10));
        let id = layer.id;
        source_doc.layers.push(layer);
        let source = session(source_doc);
        let bytes = export(&source, &[id]).unwrap();

        let mut target = session(document("目标", 100, 100));
        let result = paste(&mut target, &bytes, PastePlacement::Center, None).unwrap();
        let inserted = LayerId(result["layers"][0].as_u64().unwrap());
        let layer = target.active().unwrap().doc.layer(inserted).unwrap();
        let LayerContent::Raster(surface) = &layer.content else { panic!() };
        let bounds = surface.content_bounds();
        let cx = (f64::from(bounds.x0) + f64::from(bounds.x1)) / 2.0;
        let cy = (f64::from(bounds.y0) + f64::from(bounds.y1)) / 2.0;
        assert!((cx - 50.0).abs() <= 1.0 && (cy - 50.0).abs() <= 1.0, "居中到 (50,50)，实际 ({cx},{cy})");
    }

    #[test]
    fn corrupt_truncated_or_tampered_payloads_are_rejected_without_touching_the_target() {
        let mut source_doc = document("源", 60, 60);
        let layer = paint_layer("层", photocraft_geom::Rect::new(0, 0, 20, 20));
        let id = layer.id;
        source_doc.layers.push(layer);
        let source = session(source_doc);
        let bytes = export(&source, &[id]).unwrap();

        let mut target = session(document("目标", 80, 80));
        let before = target.active().unwrap().clone();
        for prefix in [0usize, 4, 11, 40, bytes.len() - 1] {
            assert!(paste(&mut target, &bytes[..prefix], PastePlacement::InPlace, None).is_err());
            assert_eq!(target.active().unwrap().doc, before.doc);
            assert_eq!(target.active().unwrap().history.past_len(), before.history.past_len());
        }
        // 篡改容器中的一个字节：摘要不符。
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(paste(&mut target, &tampered, PastePlacement::InPlace, None).is_err());
        assert_eq!(target.active().unwrap().doc, before.doc);
        // 未知版本。
        let mut wrong = bytes.clone();
        wrong[8..12].copy_from_slice(&0u32.to_be_bytes());
        assert!(paste(&mut target, &wrong, PastePlacement::InPlace, None).is_err());
        assert_eq!(target.active().unwrap().doc, before.doc);
    }

    #[test]
    fn pattern_identity_conflicts_are_remapped_and_all_references_rewritten() {
        let surface = Surface::new(photocraft_color::PixelFormat::RGBA8);
        let incoming = Pattern {
            id: "shared".into(),
            name: "图案".into(),
            width: 8,
            height: 8,
            surface: surface.clone(),
        };
        let mut different = incoming.clone();
        different.surface.fill_rect(photocraft_geom::Rect::new(0, 0, 8, 8), &[1.0, 0.0, 0.0, 1.0]);

        let mut source_doc = document("源", 40, 40);
        let mut layer = paint_layer("带图案", photocraft_geom::Rect::new(0, 0, 10, 10));
        layer.effects.items = vec![photocraft_doc::Effect::PatternOverlay {
            common: photocraft_doc::FxCommon::new(photocraft_doc::BlendMode::Normal, 1.0),
            name: "图案".into(),
            id: "shared".into(),
            scale: 1.0,
            angle: 0.0,
            link: true,
            phase: (0.0, 0.0),
        }];
        let id = layer.id;
        source_doc.layers.push(layer);
        source_doc.patterns.push(incoming.clone());
        let source = session(source_doc);
        let bytes = export(&source, &[id]).unwrap();

        let mut target_doc = document("目标", 50, 50);
        target_doc.patterns.push(different);
        let mut target = session(target_doc);
        let result = paste(&mut target, &bytes, PastePlacement::InPlace, None).unwrap();
        let inserted = LayerId(result["layers"][0].as_u64().unwrap());
        let state = target.active().unwrap();
        let layer = state.doc.layer(inserted).unwrap();
        let photocraft_doc::Effect::PatternOverlay { id, name, .. } = &layer.effects.items[0] else {
            panic!("应保留图案叠加");
        };
        assert_ne!(id, "shared", "冲突 id 必须换新");
        assert_eq!(name, "图案");
        assert_eq!(state.doc.patterns.len(), 2, "目标原图案不被覆盖");
        assert!(state.doc.patterns.iter().any(|pattern| pattern.id == "shared"));
        assert!(state.doc.patterns.iter().any(|pattern| pattern.id == *id));
        // 等价资源复用：同一载荷再粘贴一次不增加图案。
        let again = paste(&mut target, &bytes, PastePlacement::InPlace, None).unwrap();
        assert_eq!(again["count"], 1);
        assert_eq!(target.active().unwrap().doc.patterns.len(), 2);
    }

    #[test]
    fn smart_object_identity_is_shared_inside_the_payload_and_independent_across_documents() {
        let mut child = Document::new("内容", Size::new(8, 8), ColorMode::Rgb, SampleType::U8);
        child.layers.push(paint_layer("内容层", photocraft_geom::Rect::new(0, 0, 8, 8)));
        let source_bytes = Arc::new(photocraft_format::save_to_bytes(&child, &Default::default()).unwrap());
        let smart_layer = Layer::new(
            "对象",
            LayerContent::Smart(SmartObject::new(
                SmartSource::Embedded { file_name: "contents.pcraft".into(), bytes: source_bytes },
                Affine::IDENTITY,
                Some(Surface::new(photocraft_color::PixelFormat::RGBA8)),
            )),
        );
        let contents = match &smart_layer.content {
            LayerContent::Smart(smart) => smart.contents_id,
            _ => unreachable!(),
        };
        let shared = smart_layer.duplicate();
        let mut shared = shared;
        if let LayerContent::Smart(smart) = &mut shared.content {
            smart.contents_id = contents;
        }
        let ids = (smart_layer.id, shared.id);
        let mut source_doc = document("源", 30, 30);
        source_doc.layers.push(smart_layer);
        source_doc.layers.push(shared);
        let source = session(source_doc);
        let bytes = export(&source, &[ids.0, ids.1]).unwrap();

        let target_doc = document("目标", 40, 40);
        // 目标已有同 contents_id 的实例（模拟同源跨文档）：必须独立化。
        let mut target = session(target_doc);
        let result = paste(&mut target, &bytes, PastePlacement::InPlace, None).unwrap();
        assert_eq!(result["count"], 2);
        let state = target.active().unwrap();
        let a = LayerId(result["layers"][0].as_u64().unwrap());
        let b = LayerId(result["layers"][1].as_u64().unwrap());
        let id_a = match &state.doc.layer(a).unwrap().content {
            LayerContent::Smart(smart) => smart.contents_id,
            _ => panic!(),
        };
        let id_b = match &state.doc.layer(b).unwrap().content {
            LayerContent::Smart(smart) => smart.contents_id,
            _ => panic!(),
        };
        assert_eq!(id_a, id_b, "载荷内部共享关系保留");
        // 再次粘贴：新载荷与目标已有 identity 冲突 → 独立化，但内部仍共享。
        let again = paste(&mut target, &bytes, PastePlacement::InPlace, None).unwrap();
        let state = target.active().unwrap();
        let c = LayerId(again["layers"][0].as_u64().unwrap());
        let id_c = match &state.doc.layer(c).unwrap().content {
            LayerContent::Smart(smart) => smart.contents_id,
            _ => panic!(),
        };
        assert_ne!(id_c, id_a, "跨文档再次粘贴必须独立化源");
    }

    #[test]
    fn export_refuses_empty_selection_and_paste_refuses_layer_overflow() {
        let mut source_doc = document("源", 20, 20);
        source_doc.layers.clear();
        let source = session(source_doc);
        assert!(export(&source, &[]).is_err());

        let mut source_doc = document("源", 20, 20);
        let id = source_doc.layers[0].id;
        let bytes = export(&session(source_doc), &[id]).unwrap();

        let mut target_doc = document("目标", 20, 20);
        while target_doc.layers.len() < 64 {
            target_doc.layers.push(paint_layer("填充", photocraft_geom::Rect::new(0, 0, 4, 4)));
        }
        let mut target = session(target_doc);
        let before = target.active().unwrap().clone();
        assert!(paste(&mut target, &bytes, PastePlacement::InPlace, None).is_err());
        assert_eq!(target.active().unwrap().doc, before.doc);
    }
}
