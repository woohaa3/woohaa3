//! WASM/native 共用的纯模型几何派生
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 6.1 / design D6）。
//!
//! 统一规范 Scene IR 的局部 AABB 与 extent 派生：浏览器 prepared/register 边界与原生
//! renderer 都调用这里，避免从 ops 重复遍历 mesh，也避免与 `web/contracts` 的
//! `v2SceneAabb` / `v1SceneAabb` 出现第二套事实源。本模块不依赖 ECS、bridge 或 wasm。

use bevy::prelude::*;

use crate::protocol::{ModelAabbDto, ModelSnapshot};

use super::{ModelAabb, model_local_aabb};

/// 由已解析的模型快照派生局部 AABB（DTO 形式，供跨边界返回）。
pub fn derive_aabb(model: &ModelSnapshot) -> Option<ModelAabbDto> {
    let aabb = model_local_aabb(model)?;
    if !aabb.is_finite() {
        return None;
    }
    Some(ModelAabbDto {
        min: aabb.min,
        max: aabb.max,
    })
}

/// 由局部 AABB 派生 extent；与 `web/contracts` 的 `v2ExtentFromAabb` 同一公式。
///
/// `extent = max(1, max(|min|, |max| 各轴)) * 2`，空模型回退 2（与 `v2SceneExtent` 一致）。
pub(crate) fn extent_from_aabb(aabb: Option<ModelAabbDto>) -> f32 {
    let Some(aabb) = aabb else {
        return 2.0;
    };
    let mut extent: f32 = 1.0;
    for axis in 0..3 {
        extent = extent.max(aabb.min[axis].abs()).max(aabb.max[axis].abs());
    }
    (extent * 2.0).max(1.0)
}

/// 校验并派生 extent；AABB 非有限值时回退默认 extent。
pub fn derive_extent(model: &ModelSnapshot) -> f32 {
    let extent = extent_from_aabb(derive_aabb(model));
    if extent.is_finite() && extent > 0.0 {
        extent
    } else {
        model.extent.max(0.001)
    }
}

/// 一次遍历派生 local AABB 与 extent，并写回快照。
///
/// prepared/register 边界与 native renderer 共用：`extent` 必须写回快照，因为 `model_unit`
/// 以 `snapshot.extent` 归一化模型尺寸——若仍为占位值，模型会按错误比例渲染得巨大无比。
pub fn prepare_snapshot(mut model: ModelSnapshot) -> ModelSnapshot {
    let specs = super::build_entity_specs(&model);
    let bounds = super::PreparedBounds::new(&specs);
    let aabb = bounds.local.filter(ModelAabb::is_finite).map(to_dto);
    model.prepared_bounds = Some(std::sync::Arc::new(bounds));
    let extent = extent_from_aabb(aabb);
    model.extent = if extent.is_finite() && extent > 0.0 {
        extent
    } else {
        model.extent.max(0.001)
    };
    model.geometry_keys = Some(std::sync::Arc::new(
        specs
            .iter()
            .map(|spec| spec.geometry.as_ref().map(crate::model3d::mesh::mesh_key))
            .collect(),
    ));
    model.with_aabb(aabb)
}

/// 预览取景中心与包围球半径（local AABB 中心 + 半径）；无有效几何时返回 None。
///
/// 供原生动画预览按保存的初始镜头取景（change: 2026-10-06-fix-model-media...）。
#[allow(dead_code)] // 仅 native-renderer 离屏预览消费。
pub fn preview_focus(model: &ModelSnapshot) -> Option<(Vec3, f32)> {
    let local = model_local_aabb(model)?;
    if !local.is_finite() {
        return None;
    }
    Some((local.center(), local.radius().max(1e-4)))
}

/// 直接把 `ModelAabb` 转 DTO 的 helper（native renderer 复用）。
#[allow(dead_code)]
pub(crate) fn to_dto(aabb: ModelAabb) -> ModelAabbDto {
    ModelAabbDto {
        min: aabb.min,
        max: aabb.max,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{MODEL_SCENE_IR_V2, ModelOp};

    fn v2_snapshot(ops: Vec<ModelOp>) -> ModelSnapshot {
        ModelSnapshot::new(
            Some(MODEL_SCENE_IR_V2.to_owned()),
            ops,
            "sig".into(),
            1.0,
            Default::default(),
        )
    }

    fn vec3(value: [f32; 3]) -> [f32; 3] {
        value
    }

    #[test]
    fn aabb_and_extent_match_contract_formula() {
        // 与 contracts `v2SceneAabb`/`v2ExtentFromAabb` sample 对齐：
        // group(root) + sphere(center [1,2,3], r=2) + box(size [1,2,3])
        // => min [-1,-1,-1.5] max [3,4,5]，extent = max|.| * 2 = 5*2 = 10。
        let model = v2_snapshot(vec![
            ModelOp::Group {
                id: "root".into(),
                parent: None,
                position: vec3([0.0, 0.0, 0.0]),
                rotation: vec3([0.0, 0.0, 0.0]),
                scale: vec3([1.0, 1.0, 1.0]),
            },
            ModelOp::Sphere {
                id: "s".into(),
                parent: Some("root".into()),
                position: vec3([1.0, 2.0, 3.0]),
                rotation: vec3([0.0, 0.0, 0.0]),
                scale: vec3([1.0, 1.0, 1.0]),
                color: Some("#ffffff".into()),
                material: None,
                radius: 2.0,
            },
            ModelOp::Box {
                id: "b".into(),
                parent: Some("root".into()),
                position: vec3([0.0, 0.0, 0.0]),
                rotation: vec3([0.0, 0.0, 0.0]),
                scale: vec3([1.0, 1.0, 1.0]),
                color: Some("#ff0000".into()),
                material: None,
                size: vec3([1.0, 2.0, 3.0]),
            },
        ]);
        let aabb = derive_aabb(&model).expect("aabb");
        assert!((aabb.min[0] - -1.0).abs() < 1e-4);
        assert!((aabb.min[1] - -1.0).abs() < 1e-4);
        assert!((aabb.min[2] - -1.5).abs() < 1e-4);
        assert!((aabb.max[0] - 3.0).abs() < 1e-4);
        assert!((aabb.max[1] - 4.0).abs() < 1e-4);
        assert!((aabb.max[2] - 5.0).abs() < 1e-4);
        assert!((derive_extent(&model) - 10.0).abs() < 1e-4);
    }

    #[test]
    fn extent_falls_back_for_empty_model() {
        assert_eq!(extent_from_aabb(None), 2.0);
    }

    #[test]
    fn prepare_snapshot_writes_back_derived_extent() {
        // 回归：extent 必须写回快照，否则 `model_unit` 以占位值归一化会让模型巨大无比。
        let model = v2_snapshot(vec![ModelOp::Sphere {
            id: "s".into(),
            parent: None,
            position: vec3([0.0, 0.0, 0.0]),
            rotation: vec3([0.0, 0.0, 0.0]),
            scale: vec3([1.0, 1.0, 1.0]),
            color: Some("#ffffff".into()),
            material: None,
            radius: 4.0,
        }]);
        assert_eq!(model.extent, 1.0, "输入 extent 为占位值");
        let prepared = prepare_snapshot(model);
        // 半径 4 的球：extent = 4 * 2 = 8。
        assert!((prepared.extent - 8.0).abs() < 1e-3, "extent 必须写回快照");
        assert!(prepared.aabb.is_some());
    }
    #[test]
    fn prepared_geometry_identity_is_internal_shared_and_rebuilt_for_new_content() {
        let source = serde_json::json!({
            "sceneVersion": crate::protocol::MODEL_SCENE_IR_V2,
            "geometryKeys": ["untrusted"],
            "ops": [
                {"t":"group", "id":"root"},
                {"t":"mesh", "id":"surface", "parent":"root",
                 "vertices":[[0,0,0],[1,0,0],[0,1,0]], "faces":[[0,1,2]]}
            ]
        });
        let raw: ModelSnapshot = serde_json::from_value(source).unwrap();
        assert!(
            raw.geometry_keys.is_none(),
            "wire cannot inject cache identities"
        );
        let prepared = prepare_snapshot(raw);
        let keys = prepared.geometry_keys.as_ref().unwrap();
        let specs = super::super::build_entity_specs(&prepared);
        assert_eq!(keys.len(), specs.len());
        assert!(keys[0].is_none());
        assert_eq!(
            keys[1].as_ref().unwrap(),
            &crate::model3d::mesh::mesh_key(specs[1].geometry.as_ref().unwrap())
        );
        let mut moved = prepared.clone();
        moved.placement.offset.x = 123.0;
        assert!(std::sync::Arc::ptr_eq(
            keys,
            moved.geometry_keys.as_ref().unwrap()
        ));
        if let ModelOp::Mesh { vertices, .. } = &mut moved.ops[1] {
            vertices[1][0] = 2.0;
        } else {
            panic!("expected custom geometry");
        }
        let changed = prepare_snapshot(moved);
        assert_ne!(keys[1], changed.geometry_keys.as_ref().unwrap()[1]);
    }
}
