//! 普通画布模型 picking 候选派生
//! （change: 2026-10-13-add-film-set-hover-camera-entity，任务 1.2 / design D4）。
//!
//! 从 `Scene` 派生每个**普通模型**节点的世界 AABB（含 placement/anchor），供 `set_scene`
//! 接受点一次性发布给共享纯几何查询模块。复合资产（`composite_asset` presentation）的 hover
//! 只来自共享地面范围几何，因此这里按**通用 presentation 分类**排除，不写业务 extensionId 分支。
//!
//! 资源表由调用方以 `lookup` 注入，保持本模块不依赖 `bridge` / wasm（架构守卫）；聚焦内部
//! 对象候选另见 [`super::film_set_pick::prepare`]（change: 2026-10-14-scope-film-set-object-picking-to-focus）。
//!
//! 本模块是唯一派生公式：`pick_index` 只转发 `bridge` 资源表，因此「复合资产不得经由三维
//! AABB 重建 hover」这一资格可用不依赖渲染的原生测试覆盖。

use std::sync::Arc;

use crate::canvas_query::model_pick::ModelCandidate;
use crate::protocol::{GraphNode, ModelSnapshot, Scene};

/// 普通模型 picking 候选资格：非复合资产、非预览卡片、且携带模型引用。
///
/// 复合资产按通用 presentation 排除——其 overview hover 只能来自共享 interaction snapshot 的
/// 地面范围命中；普通模型本体与聚焦内部对象候选不受影响（design D4）。
pub(crate) fn is_model_candidate(node: &GraphNode) -> bool {
    node.composite_asset.is_none() && node.group.is_none() && node.model_preview.is_none() && node.model.is_some()
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

    /// 复合资产（composite presentation）即使携带模型引用也不得成为普通模型候选
    /// （change: 2026-10-13-add-film-set-hover-camera-entity，design D4）。
    #[test]
    fn composite_asset_is_never_a_model_candidate() {
        let film_set = node(
            r#"{"id":"film","type":"model","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"},
                "compositeAsset":{"x":0,"y":0,"width":260,"height":195}}"#,
        );
        assert!(!is_model_candidate(&film_set));
        let scene = Scene {
            nodes: vec![film_set],
            ..Scene::default()
        };
        let candidates = model_candidates(&scene, |_| Some(Arc::new(snapshot())));
        assert!(candidates.is_empty(), "复合资产不得经由三维 AABB 建立候选");
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

    /// 全链路回归（任务 1.1）：复合资产即使在三维 AABB 投影内也不产生模型候选，因此
    /// `queryPoint` 未命中地面范围时，`modelPick` 回退没有可命中的候选，不会在范围外重建 hover。
    ///
    /// 同时固定范围边界语义（地面内/边界命中、AABB 空白角不命中）与普通模型回退保留。
    #[test]
    fn composite_hover_never_comes_from_model_aabb_geometry() {
        use crate::canvas_query::scope::{self, ScopeGround, ScopeRect, SCOPE_MIN_HALF};
        use crate::isometric_grid::plan::{scope_axis_x, scope_axis_y};

        // 片场：内容适配矩形 0,0,260,195，地面矩形 hx=hz=80 → 菱形；模型 AABB 会向卡片外
        // 投影（高物体），正是越界 hover 的来源。
        let film_set = node(
            r#"{"id":"film","type":"model","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"},
                "compositeAsset":{"x":0,"y":0,"width":260,"height":195,
                    "scopeShape":"isometric-diamond",
                    "scopeGround":{"cx":130,"cy":97.5,"hx":80,"hz":80}}}"#,
        );
        // 同场景内的普通模型本体：回退必须保留。
        let plain = node(
            r#"{"id":"m","type":"model3d","x":400,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"}}"#,
        );
        let scene = Scene {
            nodes: vec![film_set.clone(), plain.clone()],
            ..Scene::default()
        };
        let candidates = model_candidates(&scene, |_| Some(Arc::new(snapshot())));
        assert_eq!(candidates.len(), 1, "只有普通模型入选");
        assert_eq!(candidates[0].node_id, "m");
        assert!(
            !candidates.iter().any(|candidate| candidate.node_id == "film"),
            "复合资产三维 AABB 不得成为 hover 回退候选"
        );

        // 地面范围唯一几何：内部与右顶点（含边界）命中；AABB 空白角不命中。
        let geometry = scope::geometry(
            ScopeRect { x: 0.0, y: 0.0, width: 260.0, height: 195.0 },
            crate::protocol::CompositeAssetScopeShape::IsometricDiamond,
            Some(ScopeGround { cx: 130.0, cy: 97.5, hx: 80.0, hz: 80.0 }),
            SCOPE_MIN_HALF,
        );
        assert!(scope::contains(&geometry, geometry.center));
        let right = geometry.vertices[1];
        assert!(scope::contains(&geometry, right), "边界包含");
        let blank = bevy::prelude::Vec2::new(geometry.aabb.x, geometry.aabb.y);
        assert!(!scope::contains(&geometry, blank), "AABB 空白角在范围外");
        // 投影轴保持等距地面斜率，范围不额外扩张。
        assert!((scope_axis_y() / scope_axis_x() - crate::isometric_grid::CANVAS_CAMERA_PITCH.sin()).abs() < 1e-4);
    }

    /// 未注册资源或缺失模型引用的节点不产生候选（保持既有接受点语义）。
    #[test]
    fn missing_reference_or_resource_is_skipped() {
        let no_reference = node(r#"{"id":"a","type":"image","x":0,"y":0}"#);
        let unknown = node(
            r#"{"id":"b","type":"model3d","x":0,"y":0,"model":{"resourceKey":"v:other"}}"#,
        );
        let scene = Scene {
            nodes: vec![no_reference, unknown],
            ..Scene::default()
        };
        assert!(model_candidates(&scene, |_| None).is_empty());
        // 仅注册 `v:sig` 时，引用未知 key 的节点仍被跳过。
        assert!(model_candidates(&scene, |key| {
            (key == "v:sig").then(|| Arc::new(snapshot()))
        })
        .is_empty());
    }
}
