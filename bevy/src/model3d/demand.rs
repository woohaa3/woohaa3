//! ECS/GPU demand is separate from registered descriptors and canonical queries.
use super::ModelVisuals;
use crate::protocol::Scene;
use std::collections::HashSet;

const WARM_PREVIEW_SOURCES: usize = 8;
const WARM_PREVIEW_SECONDS: f64 = 10.0;
const OFFSCREEN_SECONDS: f64 = 1.0;

/// 普通模型保留一秒；最近离屏的片场预览源最多保留八个、十秒。
/// 可见镜头卡片也是源片场的消费者，不得因源片场自身离屏而销毁模型。
pub(crate) fn update(
    models: &mut ModelVisuals,
    scene: &Scene,
    focus: Option<&str>,
    pins: &HashSet<String>,
    // 真正需要 High 的根（截图/导出请求）；与 `pins`（驻留）分开，见 `sync_quality_with_demand`。
    high_demand: &HashSet<String>,
    now: f64,
) -> bool {
    let pins_changed = models.capture_pins != *pins || models.high_demand != *high_demand;
    if models.capture_pins != *pins {
        models.capture_pins.clone_from(pins);
    }
    if models.high_demand != *high_demand {
        models.high_demand.clone_from(high_demand);
    }
    let preview_sources: HashSet<&str> = scene
        .nodes
        .iter()
        .filter_map(|node| {
            node.shot_preview
                .as_ref()
                .map(|preview| preview.film_set_node_id.as_str())
        })
        .collect();
    let visible_preview_sources: HashSet<&str> = scene
        .nodes
        .iter()
        .filter(|node| {
            // 参考已就绪的卡片显示录制内容，不再需要源片场为它保留驻留
            // （2026-10-28 总览 draw call 优化）；正在播放的活动镜头仍然要。
            !node.shot_preview.as_ref().is_some_and(|preview| {
                crate::shot_node_preview::settled_card(preview, &node.id, scene)
            }) && !crate::canvas_query::shot_preview::focuses_isolate(scene)
                && !crate::canvas_query::shot_preview::hidden(node)
                && near_viewport(node, scene, focus)
        })
        .filter_map(|node| {
            node.shot_preview
                .as_ref()
                .map(|preview| preview.film_set_node_id.as_str())
        })
        .collect();
    let mut warm: Vec<_> = models
        .roots
        .keys()
        .filter(|id| preview_sources.contains(id.as_str()))
        .collect();
    warm.sort_by(|a, b| {
        let since = |id: &String| models.offscreen_since.get(id).copied().unwrap_or(now);
        since(b).total_cmp(&since(a)).then_with(|| a.cmp(b))
    });
    let warm: HashSet<_> = warm
        .into_iter()
        .take(WARM_PREVIEW_SOURCES)
        .map(String::as_str)
        .collect();
    let mut desired = HashSet::new();
    for node in scene.nodes.iter().filter(|n| n.model.is_some()) {
        let owner = visible_preview_sources.contains(node.id.as_str())
            || focus == Some(node.id.as_str())
            || pins.contains(&node.id)
            || (super::quality::has_overview_lod_declaration(node)
                && scene.selection.nodes.iter().any(|id| id == &node.id))
            || scene
                .model_focus
                .as_ref()
                .is_some_and(|f| f.node_id == node.id)
            || scene
                .model_editor
                .as_ref()
                .is_some_and(|e| e.node_id == node.id)
            || scene
                .animation_playback
                .as_ref()
                .is_some_and(|p| p.node_id == node.id)
            || scene.hover.as_ref().and_then(|h| h.node_id.as_deref()) == Some(node.id.as_str());
        // Film sets render directly in the world, but their canonical layout
        // bounds (including the group footer) determine viewport demand. Missing surface dimensions
        // keep native/world callers conservative; representation style is not a visibility owner.
        let near = near_viewport(node, scene, focus);
        if owner || near {
            models.offscreen_since.remove(&node.id);
            desired.insert(node.id.clone());
        } else if models.roots.contains_key(&node.id) {
            let since = models.offscreen_since.entry(node.id.clone()).or_insert(now);
            let grace = if warm.contains(node.id.as_str()) {
                WARM_PREVIEW_SECONDS
            } else {
                OFFSCREEN_SECONDS
            };
            if now - *since < grace {
                desired.insert(node.id.clone());
            }
        }
    }
    let alive: HashSet<_> = scene.nodes.iter().map(|n| n.id.as_str()).collect();
    models
        .offscreen_since
        .retain(|id, _| alive.contains(id.as_str()));
    if models.demand.as_ref() == Some(&desired) {
        return pins_changed;
    }
    models.demand = Some(desired);
    true
}

/// 当前需求持有的模型 payload lease key 集合
/// （change: 2026-10-23-scale-canvas-media-residency，design D5）。
///
/// 只有当前渲染需求（可见/预热/聚焦/编辑/捕获 pin/播放）以及仍在宽限内的已发布根引用的
/// 模型重型 payload 被保护；其余 descriptor 保持 cold，可在预算内淘汰并按需重新准备。
/// 把已发布根计入 lease 是必要的：根持有 payload `Arc`，提前从表里淘汰会让消费者看到
/// 「需求仍在但资源消失」，进而误删根并重准备（宽限内的旧表示应当保留到根真正退役）。
/// `demand == None` 表示尚未计算需求，沿用既有保守语义（全部保留），不制造意外淘汰。
pub(crate) fn payload_lease_keys(scene: &Scene, models: &ModelVisuals) -> HashSet<String> {
    let demand = models.demand.as_ref();
    let mut keys: HashSet<String> = scene
        .nodes
        .iter()
        .filter(|node| demand.is_none_or(|required| required.contains(&node.id)))
        .filter_map(|node| {
            node.model
                .as_ref()
                .map(|reference| reference.resource_key.clone())
        })
        .collect();
    // 已发布/分帧装配中的根仍持有 payload：宽限内不得因预算淘汰其内容。
    for node in &scene.nodes {
        if models.roots.contains_key(&node.id)
            && let Some(reference) = &node.model
        {
            keys.insert(reference.resource_key.clone());
        }
    }
    keys
}

/// 复用一屏预热边距；无有效 surface 时保守保留。
fn near_viewport(node: &crate::protocol::GraphNode, scene: &Scene, focus: Option<&str>) -> bool {
    if crate::canvas_query::focus_context::contains(scene, &node.id) {
        return true;
    }
    scene.surface.as_ref().is_none_or(|s| {
        if !s.width.is_finite() || !s.height.is_finite() || s.width <= 0. || s.height <= 0. {
            return true;
        }
        let viewport = super::grid::scene_view(scene);
        let z = viewport.zoom;
        let x = node.x * z + viewport.x;
        let y = node.y * z + viewport.y;
        let bottom = node.y
            + node.height
            + if node.group.is_some() {
                crate::canvas_query::group_model::badge_outset(node)
            } else {
                0.
            };
        scene.model_focus.is_none()
            && focus.is_none()
            && x < s.width * 2.
            && x + node.width * z > -s.width
            && y < s.height * 2.
            && bottom * z + viewport.y > -s.height
    })
}

#[cfg(test)]
mod group_model_tests {
    use super::*;

    #[test]
    fn zoomed_near_viewport_footer_keeps_ecs_demand_beyond_offscreen_grace() {
        let mut scene = Scene::default();
        scene.viewport.zoom = 12.;
        scene.surface = Some(
            serde_json::from_value(
                serde_json::json!({ "width":1024.,"height":600.,"pixelRatio":1. }),
            )
            .unwrap(),
        );
        scene.nodes.push(
            serde_json::from_value(serde_json::json!({
                "id":"g","type":"group","x":-200.,"y":-345.,"width":500.,"height":300.,
                "model":{"resourceKey":"test:box","signature":"box"},
                "group":{"modelBounds":{"aabb":{"min":[-1,-1,-1],"max":[1,1,1]},"extent":2}}
            }))
            .unwrap(),
        );
        assert!((scene.nodes[0].y + scene.nodes[0].height) * 12. > -600.);
        assert!(near_viewport(&scene.nodes[0], &scene, None));
        let mut models = ModelVisuals::default();
        update(
            &mut models,
            &scene,
            None,
            &HashSet::new(),
            &HashSet::new(),
            0.,
        );
        assert!(models.demand.as_ref().unwrap().contains("g"));
        models.offscreen_since.insert("g".into(), 0.);
        update(
            &mut models,
            &scene,
            None,
            &HashSet::new(),
            &HashSet::new(),
            2.,
        );
        assert!(models.demand.as_ref().unwrap().contains("g"));
        assert!(!models.offscreen_since.contains_key("g"));
        assert!(payload_lease_keys(&scene, &models).contains("test:box"));
        scene.nodes[0].y = -1000.;
        update(
            &mut models,
            &scene,
            None,
            &HashSet::new(),
            &HashSet::new(),
            3.,
        );
        assert!(!models.demand.as_ref().unwrap().contains("g"));
    }
}
