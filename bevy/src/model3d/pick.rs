//! 普通画布模型 picking 候选派生
//! （change: 2026-10-13-add-film-set-hover-camera-entity，任务 1.2 / design D4）。
//!
//! 从 `Scene` 派生每个**普通模型**节点的世界 AABB（含 placement/anchor），供 `set_scene`
//! 接受点一次性发布给共享纯几何查询模块。
//!
//! 资源表由调用方以 `lookup` 注入，保持本模块不依赖 `bridge` / wasm（架构守卫）。

use std::sync::Arc;

use crate::canvas_query::model_pick::ModelCandidate;
use crate::protocol::{GraphNode, ModelSnapshot, Scene};

/// 普通模型 picking 候选资格：非预览卡片、且携带模型引用。
pub(crate) fn is_model_candidate(node: &GraphNode) -> bool {
    node.model_preview.is_none() && node.model.is_some()
}

/// 派生普通模型候选世界 AABB；`lookup` 提供不可变资源表（`set_scene` 接受点注入 `bridge`）。
pub(crate) fn model_candidates(
    scene: &Scene,
    lookup: impl Fn(&str) -> Option<Arc<ModelSnapshot>>,
) -> Vec<ModelCandidate> {
    let mut candidates = Vec::new();
    for node in &scene.nodes {
        if !is_model_candidate(node) {
            continue;
        }
        let Some(reference) = &node.model else {
            continue;
        };
        let Some(model) = lookup(&reference.resource_key) else {
            continue;
        };
        let Some(world) =
            super::layout::model_world_aabb_for_node(&model, &reference.placement, node)
        else {
            continue;
        };
        candidates.push(ModelCandidate {
            node_id: node.id.clone(),
            min: world.min,
            max: world.max,
        });
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(json: &str) -> GraphNode {
        serde_json::from_str(json).expect("graph node")
    }

    fn snapshot() -> ModelSnapshot {
        ModelSnapshot::new(
            Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
            vec![crate::protocol::ModelOp::Box {
                id: "body".to_owned(),
                parent: None,
                position: [0.0, 1.0, 0.0],
                rotation: [0.0, 0.0, 0.0],
                scale: [1.0; 3],
                color: Some("#ffffff".to_owned()),
                material: None,
                size: [2.0, 2.0, 2.0],
            }],
            "sig".to_owned(),
            2.0,
            Default::default(),
        )
    }

    /// 普通模型本体与预览卡片语义保持：带模型引用入选，仅预览卡片不入选。
    #[test]
    fn plain_model_is_candidate_and_preview_card_is_not() {
        let plain = node(
            r#"{"id":"m","type":"model3d","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"}}"#,
        );
        assert!(is_model_candidate(&plain));

        let preview = node(
            r#"{"id":"p","type":"model","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"},
                "modelPreview":{"azimuth":0.5,"elevation":0.2,"distanceScale":1.2,"targetOffset":[0,0,0]}}"#,
        );
        assert!(!is_model_candidate(&preview));

        let scene = Scene {
            nodes: vec![plain, preview],
            ..Scene::default()
        };
        let candidates = model_candidates(&scene, |_| Some(Arc::new(snapshot())));
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].node_id, "m");
        assert!(candidates[0].min[0] < candidates[0].max[0]);
    }
}
