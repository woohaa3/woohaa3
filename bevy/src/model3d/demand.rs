//! ECS/GPU demand is separate from registered descriptors and canonical queries.
use super::ModelVisuals;
use crate::protocol::Scene;
use std::collections::HashSet;

const OFFSCREEN_SECONDS: f64 = 1.0;

/// 普通模型离屏后保留一秒，随后释放根。
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
    let mut desired = HashSet::new();
    for node in scene.nodes.iter().filter(|n| n.model.is_some()) {
        let owner = focus == Some(node.id.as_str())
            || pins.contains(&node.id)
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
        // World geometry is independent of the card rectangle. Until world-space
        // bounds drive culling, retain these instances conservatively.
        let near = node.shared_world_instance.is_some() || near_viewport(node, scene, focus);
        if owner || near {
            models.offscreen_since.remove(&node.id);
            desired.insert(node.id.clone());
        } else if models.roots.contains_key(&node.id) {
            let since = models.offscreen_since.entry(node.id.clone()).or_insert(now);
            if now - *since < OFFSCREEN_SECONDS {
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
/// 只有当前渲染需求（可见/聚焦/编辑/捕获 pin/播放）以及仍在宽限内的已发布根引用的
/// 模型重型 payload 被保护；其余 descriptor 保持 cold，可在预算内淘汰并按需重新准备。
/// `demand == None` 表示尚未计算需求，沿用既有保守语义（全部保留）。
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
    // 已发布的根仍持有 payload：宽限内不得因预算淘汰其内容。
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
        let bottom = node.y + node.height;
        scene.model_focus.is_none()
            && focus.is_none()
            && x < s.width * 2.
            && x + node.width * z > -s.width
            && y < s.height * 2.
            && bottom * z + viewport.y > -s.height
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offscreen_grace_then_release() {
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
                "id":"m","type":"model","x":-200.,"y":-345.,"width":500.,"height":300.,
                "model":{"resourceKey":"test:box","signature":"box"}
            }))
            .unwrap(),
        );
        assert!(near_viewport(&scene.nodes[0], &scene, None));
        let mut models = ModelVisuals::default();
        update(&mut models, &scene, None, &HashSet::new(), &HashSet::new(), 0.);
        assert!(models.demand.as_ref().unwrap().contains("m"));
        models.offscreen_since.insert("m".into(), 0.);
        scene.nodes[0].y = -1000.;
        update(&mut models, &scene, None, &HashSet::new(), &HashSet::new(), 3.);
        assert!(!models.demand.as_ref().unwrap().contains("m"));
    }

    #[test]
    fn shared_world_demand_ignores_card_position_and_leases_resource() {
        let mut scene = Scene::default();
        scene.viewport.zoom = 1.;
        scene.surface = Some(serde_json::from_value(serde_json::json!({
            "width": 1024., "height": 600., "pixelRatio": 1.
        })).unwrap());
        scene.nodes.push(serde_json::from_value(serde_json::json!({
            "id":"m", "type":"model", "x":10000., "y":10000., "width":100., "height":50.,
            "model":{"resourceKey":"test:box","signature":"box"},
            "sharedWorldInstance":{"kind":"world-instance","version":"shared-world-v1","instanceId":"i",
                "transform":{"version":"shared-world-v1","position":{"u":0,"v":0,"h":0},
                    "rotation":[0,0,0,1],"scale":1}}
        })).unwrap());
        let mut models = ModelVisuals::default();
        for now in [0., 3.] {
            update(&mut models, &scene, None, &HashSet::new(), &HashSet::new(), now);
            assert!(models.demand.as_ref().unwrap().contains("m"));
            assert!(payload_lease_keys(&scene, &models).contains("test:box"));
            scene.nodes[0].x += 10000.;
        }
        scene.nodes.clear();
        update(&mut models, &scene, None, &HashSet::new(), &HashSet::new(), 4.);
        assert!(models.demand.as_ref().unwrap().is_empty());
    }
}
