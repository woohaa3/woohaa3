//! Layer › Smart Objects › Convert to Layers：把嵌入源解包为父文档里的可编辑图层。
//!
//! 与「栅格化」不同：解包保留源内部的层/组结构、名称、混合与蒙版，只把实例放置
//! （仿射）应用到解包结果上。解包当前实例不修改其他共享实例——共享由 `contents_id`
//! 表达，本操作只替换被选中的那一个图层。
//!
//! 复用上游既有语义而不复制第二套算法：
//! - 整像素平移直接平移解包层，不重采样；
//! - 非整像素仿射交给引擎自己的 `edit.transform`（在临时会话里对一个临时组执行），
//!   蒙版、文字重排与像素预算因此沿用上游实现；
//! - 无法表示的实例效果（变形、透视、智能滤镜）明确拒绝，绝不静默栅格化。
use crate::{EditorError, Result};
use photocraft_doc::{Affine, Document, Group, Layer, LayerContent, LayerId, SmartObject};
use photocraft_engine::Session;
use photocraft_project_verify::{limits, smart_source::inspect_document_sources};
use serde_json::{Value, json};
use std::sync::Arc;

fn error(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed {
        id: "layer.smartObjects.convertToLayers".into(),
        message: message.to_string(),
    }
}

/// PSD 放置层块：源变了之后这些块不再描述该对象。
const PLACED_KEYS: [&[u8; 4]; 3] = [b"SoLd", b"PlLd", b"SoLE"];

/// 解包为何不可用（空字符串表示可用）。
pub fn convert_reason(smart: &SmartObject, locked: bool, child_open: bool) -> String {
    if locked {
        return "图层或其父组已全部锁定，请先解锁".into();
    }
    if child_open {
        return "子文档仍在编辑中，请先回写或关闭子文档".into();
    }
    if !matches!(smart.source, photocraft_doc::SmartSource::Embedded { .. }) {
        return "外链智能对象保持 NON_GOALS，仅支持嵌入源".into();
    }
    if smart.warp.as_ref().is_some_and(|warp| !warp.is_identity()) {
        return "变形后的智能对象无法转回图层，请改用栅格化".into();
    }
    if smart.perspective.is_some() {
        return "透视放置的智能对象无法转回图层，请改用栅格化".into();
    }
    if !smart.smart_filters.is_empty() || smart.filter_mask.is_some() {
        return "含智能滤镜的智能对象无法转回图层".into();
    }
    // 堆栈模式按统计量合并源顶层，而不是普通合成；解包成普通层会静默改变画面。
    if smart.stack_mode.is_some() {
        return "堆栈模式（Stack Mode）的智能对象无法转回图层，请改用栅格化".into();
    }
    if smart.cache.is_none() {
        return "智能对象缺少可解包的外观".into();
    }
    String::new()
}

/// 把智能图层 `layer` 的嵌入源解包成可编辑图层，并作为一步历史提交。
///
/// `child_open` 由调用方提供（同一图层是否有打开的子文档会话）。
pub fn convert(session: &mut Session, layer: LayerId, child_open: bool) -> Result<Value> {
    let base = session.active().cloned().ok_or(EditorError::NoDocument)?;
    let target = base
        .doc
        .layer(layer)
        .ok_or_else(|| error("目标图层不存在"))?;
    let LayerContent::Smart(smart) = &target.content else {
        return Err(error("请先选择智能对象图层"));
    };
    let reason = convert_reason(smart, base.doc.effective_locks(layer).all, child_open);
    if !reason.is_empty() {
        return Err(error(reason));
    }
    let smart = smart.clone();

    // 源文档已通过整棵源树核验（层数/深度/解压预算），这里只读快照。
    let edit = crate::smart_source_edit::SourceContentsEdit::new(session, layer)
        .map_err(|failure| error(failure.message()))?;
    let source = edit.document().clone();
    if source.mode != base.doc.mode || source.depth != base.doc.depth {
        return Err(error("子文档的色彩模式或位深与父文档不一致"));
    }
    let mut layers = source.layers.clone();
    // 源里的 Background 在父文档里只是普通图层：背景由结构（底部 + 锁定）判定，
    // 解包后必须解除锁定，否则它既不能移动也不是背景。
    clear_background_locks(&source, &mut layers);
    apply_placement(&mut layers, &smart, &source)?;

    // 源文档的图层 id 只在嵌入工程内有意义，不能带进父文档。
    let mut assembled = assemble(target, layers).duplicate();
    let new_id = assembled.id;
    if base.doc.layer(new_id).is_some() {
        return Err(error("转回图层的结果身份与现有图层冲突"));
    }
    check_budget(&base.doc, layer, &assembled)?;

    let mut candidate = (*base.doc).clone();
    // 解包层的样式沿用的是源里的图案资源；不带进父文档就等于静默丢样式。
    carry_patterns(
        &mut candidate,
        &source,
        std::slice::from_mut(&mut assembled),
    )?;
    let path = candidate
        .path_of(layer)
        .ok_or_else(|| error("目标图层不存在"))?;
    *candidate
        .layer_at_mut(&path)
        .ok_or_else(|| error("目标图层不存在"))? = assembled;
    // 解包后的整棵子树（含内嵌智能对象）都必须仍是可核验内容。
    inspect_document_sources(&candidate).map_err(|failure| error(failure.message))?;
    let group = candidate.layer(new_id).is_some_and(Layer::is_group);
    let count = subtree_count(
        candidate
            .layer(new_id)
            .ok_or_else(|| error("转回图层的结果丢失"))?,
    );
    crate::preview_history::commit_selected(
        session,
        Arc::new(candidate),
        Some(new_id),
        vec![new_id],
        "转回图层",
    )
    .map_err(error)?;
    Ok(json!({ "layer": new_id.0, "group": group, "layers": count }))
}

fn subtree_count(layer: &Layer) -> usize {
    1 + layer
        .children()
        .into_iter()
        .flatten()
        .map(subtree_count)
        .sum::<usize>()
}

fn forest_count(layers: &[Layer]) -> usize {
    layers.iter().map(subtree_count).sum()
}

/// 源 Background 的透明/位置锁在父文档里不成立（父文档的背景是另一层）。
fn clear_background_locks(source: &Document, layers: &mut [Layer]) {
    let Some(background) = source.background().map(|layer| layer.id) else {
        return;
    };
    fn walk(layers: &mut [Layer], id: LayerId) {
        for layer in layers {
            if layer.id == id {
                layer.locks = Default::default();
            }
            if let Some(children) = layer.children_mut() {
                walk(children, id);
            }
        }
    }
    walk(layers, background);
}

/// 实例放置：整像素平移精确移动，其余仿射交给引擎自己的自由变换。
fn apply_placement(layers: &mut Vec<Layer>, smart: &SmartObject, source: &Document) -> Result<()> {
    let [a, b, c, d, e, f] = smart.transform.m;
    let whole = |value: f64| (value - value.round()).abs() < 1e-9;
    let pure_shift = [a - 1.0, b, c, d - 1.0]
        .iter()
        .all(|value| value.abs() < 1e-9)
        && whole(e)
        && whole(f);
    if pure_shift {
        let range = |value: f64| value >= f64::from(i32::MIN) && value <= f64::from(i32::MAX);
        if !range(e) || !range(f) {
            return Err(error("智能对象的放置位置超出可表示范围"));
        }
        let (dx, dy) = (e.round() as i32, f.round() as i32);
        layers
            .iter_mut()
            .for_each(|layer| shift_layer(layer, dx, dy));
        return Ok(());
    }
    // 非整像素放置：在临时会话里对一个临时组执行自由变换，复用上游的
    // 蒙版/文字/像素预算语义；绝不把结果当成栅格化替代品。
    let group = Layer::group("placement", std::mem::take(&mut *layers));
    let group_id = group.id;
    // 源图层自带的锁不能阻止解包本身；放置完成后按原树顺序恢复。
    let mut locks = Vec::new();
    collect_locks(&group, &mut locks);
    let mut cleared = group;
    clear_locks(&mut cleared);
    let mut document = Document::new("placement", source.size, source.mode, source.depth);
    document.resolution_dpi = source.resolution_dpi;
    document.layers.push(cleared);
    let mut scratch = Session::new();
    scratch.add_document(document, None);
    scratch
        .execute(
            "edit.transform",
            json!({
                "layer": group_id.0,
                "rect": [0.0, 0.0, f64::from(source.size.width), f64::from(source.size.height)],
                "matrix": smart.transform.m.to_vec(),
            }),
        )
        .map_err(|failure| error(format!("应用实例放置失败：{failure}")))?;
    let placed = scratch
        .active()
        .and_then(|state| state.doc.layer(group_id))
        .cloned()
        .ok_or_else(|| error("应用实例放置后图层丢失"))?;
    let mut placed = placed;
    let mut saved = locks.into_iter();
    restore_locks(&mut placed, &mut saved);
    let children = placed
        .children()
        .map(<[Layer]>::to_vec)
        .ok_or_else(|| error("应用实例放置后图层结构丢失"))?;
    if children.is_empty() {
        return Err(error("实例放置后没有可编辑图层"));
    }
    *layers = children;
    Ok(())
}

/// 树序保存每一项的锁与蒙版联动，放置后按同一顺序恢复。
fn collect_locks(
    layer: &Layer,
    out: &mut Vec<(photocraft_doc::Locks, Option<bool>, Option<bool>)>,
) {
    out.push((
        layer.locks,
        layer.mask.as_ref().map(|mask| mask.linked),
        layer.vector_mask.as_ref().map(|mask| mask.linked),
    ));
    for child in layer.children().into_iter().flatten() {
        collect_locks(child, out);
    }
}

fn clear_locks(layer: &mut Layer) {
    layer.locks = Default::default();
    if let Some(mask) = layer.mask.as_mut() {
        mask.linked = true;
    }
    if let Some(mask) = layer.vector_mask.as_mut() {
        mask.linked = true;
    }
    for child in layer.children_mut().into_iter().flatten() {
        clear_locks(child);
    }
}

fn restore_locks(
    layer: &mut Layer,
    saved: &mut std::vec::IntoIter<(photocraft_doc::Locks, Option<bool>, Option<bool>)>,
) {
    if let Some((locks, mask, vector)) = saved.next() {
        layer.locks = locks;
        if let (Some(mask), Some(linked)) = (layer.mask.as_mut(), mask) {
            mask.linked = linked;
        }
        if let (Some(mask), Some(linked)) = (layer.vector_mask.as_mut(), vector) {
            mask.linked = linked;
        }
    }
    for child in layer.children_mut().into_iter().flatten() {
        restore_locks(child, saved);
    }
}

/// 整像素平移，不重采样任何缓存。
fn shift_layer(layer: &mut Layer, dx: i32, dy: i32) {
    if dx == 0 && dy == 0 {
        return;
    }
    let affine = Affine::translate(f64::from(dx), f64::from(dy));
    let moved = |surface: &photocraft_doc::Surface| {
        photocraft_algo::resample::translate_surface(surface, dx, dy)
    };
    if let Some(mask) = layer.mask.as_mut() {
        mask.surface = moved(&mask.surface);
    }
    if let Some(mask) = layer.vector_mask.as_mut() {
        mask.path = mask.path.transform(&affine);
    }
    if let Some(fill) = layer.fill_cache.as_mut() {
        fill.surface = moved(&fill.surface);
    }
    match &mut layer.content {
        LayerContent::Raster(surface) => *surface = moved(surface),
        LayerContent::Text(text) => {
            text.transform = affine.mul(&text.transform);
            if let Some(cache) = text.cache.as_mut() {
                *cache = moved(cache);
            }
        }
        LayerContent::Shape(shape) => {
            photocraft_engine::vector_cmds::transform_shape(shape, &affine);
            if let Some(cache) = shape.cache.as_mut() {
                *cache = moved(cache);
            }
        }
        LayerContent::Smart(smart) => {
            smart.transform = affine.mul(&smart.transform);
            if let Some(cache) = smart.cache.as_mut() {
                *cache = moved(cache);
            }
        }
        LayerContent::Group(group) => group
            .children
            .iter_mut()
            .for_each(|child| shift_layer(child, dx, dy)),
        // 调整层与填充层没有自身像素；它们的裁剪由合成与视图决定。
        LayerContent::Adjustment(_) | LayerContent::Fill(_) => {}
    }
}

/// 把解包出的层合并成替换智能图层的那一个图层：
/// 只有当智能图层自身的蒙版/效果/混合都无法折叠时才建组。
fn assemble(target: &Layer, mut layers: Vec<Layer>) -> Layer {
    let blend = if target.blend == photocraft_doc::BlendMode::PassThrough {
        photocraft_doc::BlendMode::Normal
    } else {
        target.blend
    };
    if let [only] = layers.as_slice()
        && foldable(target, only)
        && let Some(mut layer) = layers.pop()
    {
        layer.name = target.name.clone();
        layer.visible &= target.visible;
        layer.opacity *= target.opacity;
        layer.blend = blend;
        layer.clipped = target.clipped;
        layer.locks = target.locks;
        layer.label = target.label;
        layer.link_group = target.link_group;
        return layer;
    }
    let mut group = target.clone();
    group.id = LayerId::fresh();
    group.psd_id = None;
    group.blend = blend;
    group.content = LayerContent::Group(Group {
        children: layers,
        expanded: true,
        artboard: None,
    });
    // 放置层块描述的是已经不在的源；其余 PSD 块（效果、蒙版等）仍描述这一图层。
    group
        .psd_blocks
        .retain(|(key, _)| !PLACED_KEYS.iter().any(|placed| *key == **placed));
    group
}

/// 智能图层自身会不会改变解包后单层的外观。
fn foldable(target: &Layer, child: &Layer) -> bool {
    target.mask.is_none()
        && target.vector_mask.is_none()
        && (!target.effects.enabled || target.effects.items.is_empty())
        && target.fill_opacity >= 1.0
        && target.blend_if.is_default()
        && target.excluded_channels == 0
        && !child.clipped
        && matches!(
            child.blend,
            photocraft_doc::BlendMode::Normal | photocraft_doc::BlendMode::PassThrough
        )
        && child.blend_if.is_default()
        && child.excluded_channels == 0
}

/// 解包层的图层样式可能引用源文档里的图案；这些资源必须随解包进入父文档，否则样式
/// 引用会指向不存在的图案（核验器与本域内容身份都会把它视为无效样式）。
///
/// 分工与图层粘贴一致：同 id 同内容直接复用，同 id 不同内容先按内容复用等价资源，
/// 都没有才换新 id 并改写本层树内的引用。
fn carry_patterns(document: &mut Document, source: &Document, layers: &mut [Layer]) -> Result<()> {
    let used = pattern_ids(layers);
    if used.is_empty() {
        return Ok(());
    }
    let mut map = std::collections::HashMap::new();
    for id in used {
        let Some(pattern) = source.patterns.iter().find(|pattern| pattern.id == id) else {
            continue;
        };
        let existing = document.patterns.iter().find(|own| own.id == pattern.id);
        match existing {
            None => {
                document.patterns.push(pattern.clone());
                map.insert(pattern.id.clone(), pattern.id.clone());
            }
            Some(own) if same_pattern_content(own, pattern) => {
                map.insert(pattern.id.clone(), own.id.clone());
            }
            Some(_) => {
                if let Some(equivalent) = document
                    .patterns
                    .iter()
                    .find(|other| same_pattern_content(other, pattern))
                {
                    map.insert(pattern.id.clone(), equivalent.id.clone());
                    continue;
                }
                let mut next = pattern.clone();
                next.id = unique_pattern_id(&document.patterns, &pattern.id);
                map.insert(pattern.id.clone(), next.id.clone());
                document.patterns.push(next);
            }
        }
    }
    if !map.is_empty() {
        layers
            .iter_mut()
            .for_each(|layer| rewrite_patterns(layer, &map));
    }
    // 新引入的资源同样受工程图案预算约束，不因一次解包突破既有上限。
    if !photocraft_project_verify::pattern_support::supported(&document.patterns) {
        return Err(error("转回图层后的图案资源超过工程预算"));
    }
    if !document.walk().iter().all(|(_, _, layer)| {
        photocraft_project_verify::style_support::pattern_references(&layer.effects)
            .iter()
            .all(|(id, name)| {
                document
                    .patterns
                    .iter()
                    .any(|pattern| pattern.id == *id && pattern.name == *name)
            })
    }) {
        return Err(error("转回图层后仍有图层样式引用缺失的图案"));
    }
    Ok(())
}

/// 本层树引用的图案 id（样式、图案填充）。
fn pattern_ids(layers: &[Layer]) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    fn walk(layer: &Layer, out: &mut std::collections::BTreeSet<String>) {
        photocraft_project_verify::style_support::pattern_references(&layer.effects)
            .into_iter()
            .for_each(|(id, _)| {
                out.insert(id.to_string());
            });
        if let LayerContent::Fill(photocraft_doc::Fill::Pattern { id, .. }) = &layer.content {
            out.insert(id.clone());
        }
        for child in layer.children().into_iter().flatten() {
            walk(child, out);
        }
    }
    layers.iter().for_each(|layer| walk(layer, &mut out));
    out
}

fn same_pattern_content(a: &photocraft_doc::Pattern, b: &photocraft_doc::Pattern) -> bool {
    a.name == b.name && a.width == b.width && a.height == b.height && a.surface == b.surface
}

fn unique_pattern_id(patterns: &[photocraft_doc::Pattern], base: &str) -> String {
    for index in 1..10_000u32 {
        let candidate = format!("{base}-x{index}");
        if !patterns.iter().any(|pattern| pattern.id == candidate) {
            return candidate;
        }
    }
    format!("{base}-x")
}

/// 改写本层树内的图案引用（与图层粘贴共用同一份引用位置规则时不能复制第二套；
/// 这里只覆盖解包会产生的内容：样式与图案填充）。
fn rewrite_patterns(layer: &mut Layer, map: &std::collections::HashMap<String, String>) {
    use photocraft_doc::{Effect, FxPaint};
    let remap = |id: &mut String| {
        if let Some(next) = map.get(id.as_str()) {
            *id = next.clone();
        }
    };
    for effect in &mut layer.effects.items {
        match effect {
            Effect::PatternOverlay { id, .. } => remap(id),
            Effect::Stroke(stroke) => {
                if let FxPaint::Pattern { id, .. } = &mut stroke.paint {
                    remap(id);
                }
            }
            Effect::OuterGlow(glow) | Effect::InnerGlow(glow) => {
                if let FxPaint::Pattern { id, .. } = &mut glow.paint {
                    remap(id);
                }
            }
            Effect::BevelEmboss(bevel) => {
                if let Some(texture) = bevel.texture.as_mut() {
                    remap(&mut texture.id);
                }
            }
            _ => {}
        }
    }
    if let LayerContent::Fill(photocraft_doc::Fill::Pattern { id, .. }) = &mut layer.content {
        remap(id);
    }
    for child in layer.children_mut().into_iter().flatten() {
        rewrite_patterns(child, map);
    }
}

/// 解包后父文档的层数/深度预算：不因一次解包突破既有上限，也不自动提升上限。
fn check_budget(document: &Document, replaced: LayerId, unpacked: &Layer) -> Result<()> {
    let total = forest_count(&document.layers);
    let replaced_layer = document
        .layer(replaced)
        .ok_or_else(|| error("目标图层不存在"))?;
    let removed = subtree_count(replaced_layer);
    let added = subtree_count(unpacked);
    let after = total.saturating_sub(removed).saturating_add(added);
    if after > limits::MAX_LAYERS {
        return Err(error(format!(
            "转回图层后共 {after} 层，超过 {} 层的上限",
            limits::MAX_LAYERS
        )));
    }
    let path = document
        .path_of(replaced)
        .ok_or_else(|| error("目标图层不存在"))?;
    // `path` 含目标层自身（根层长度为 1），替换后最深处是该层的父层级加上解包树高度，
    // 与核验器「根层从 1 起」的 depth 语义一致。
    let deepest = path
        .len()
        .saturating_sub(1)
        .saturating_add(subtree_depth(unpacked));
    if deepest > limits::MAX_DOCUMENT_DEPTH {
        return Err(error(format!(
            "转回图层后层级为 {deepest}，超过 {} 层的上限",
            limits::MAX_DOCUMENT_DEPTH
        )));
    }
    Ok(())
}

fn subtree_depth(layer: &Layer) -> usize {
    1 + layer
        .children()
        .into_iter()
        .flatten()
        .map(subtree_depth)
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "unpack/tests.rs"]
mod tests;
