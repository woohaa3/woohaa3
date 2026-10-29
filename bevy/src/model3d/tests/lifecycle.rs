//! World-based 资源生命周期与聚焦可见性测试
//! （change: refactor-bevy-rust-file-size，任务 4.1 / design D4；
//!  change: optimize-model-scene-snapshot-hot-path 改为节点引用 + 独立资源表）。

use super::{reference_for, resource_table, run_sync, scene_with, world_with_resources};
use crate::protocol::{GraphNode, ModelOp, ModelPlacement, ModelReference, ModelSnapshot, Scene};
use bevy::prelude::*;

fn model_node() -> GraphNode {
    GraphNode {
        model_preview: None,
        id: "m".into(),
        kind: "model".into(),
        x: 0.0,
        y: 0.0,
        width: 224.0,
        height: 116.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        shot_preview: None,
    }
}

fn sphere_snapshot(signature: &str) -> ModelSnapshot {
    ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Sphere {
            id: "joint".into(),
            parent: None,
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            radius: 0.3,
        }],
        signature: signature.into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    }
}

fn table_for(signatures: &[&str]) -> (super::super::runtime::ModelAssets, Vec<ModelReference>) {
    let node = model_node();
    let _ = node;
    let mut entries = Vec::new();
    let mut references = Vec::new();
    for signature in signatures {
        let snapshot = sphere_snapshot(signature);
        let reference = reference_for(&snapshot, ModelPlacement::default());
        entries.push((reference.resource_key.clone(), snapshot));
        references.push(reference);
    }
    (resource_table(entries), references)
}

/// 资源生命周期（任务 4.3）：多轮替换 / 删除后 entity 与 asset 数回到基线。
#[test]
fn model_lifecycle_returns_to_baseline() {
    let mut world = world_with_resources();
    let node = model_node();

    let (resources, references) = table_for(&["sig-a"]);
    run_sync(
        &mut world,
        &scene_with(&node, Some(references[0].clone())),
        &resources,
    );
    let baseline_entities = world.iter_entities().count();
    let mesh_count = world.resource::<Assets<Mesh>>().len();
    let material_count = world.resource::<Assets<StandardMaterial>>().len();
    assert!(mesh_count >= 1 && material_count >= 1);

    // 多轮替换：引用不同 signature 的资源触发重建，资源数不应线性增长。
    for index in 0..5 {
        let (resources, references) = table_for(&[&format!("sig-{index}")]);
        run_sync(
            &mut world,
            &scene_with(&node, Some(references[0].clone())),
            &resources,
        );
    }
    assert_eq!(
        world.resource::<Assets<Mesh>>().len(),
        mesh_count,
        "替换后 mesh 数不应增长"
    );
    assert_eq!(
        world.resource::<Assets<StandardMaterial>>().len(),
        material_count,
        "替换后 material 数不应增长"
    );

    // 删除模型：回到空场景基线。
    run_sync(&mut world, &scene_with(&node, None), &resources);
    assert!(
        world.resource::<Assets<Mesh>>().is_empty(),
        "删除后 mesh 应被回收"
    );
    assert!(
        world.resource::<Assets<StandardMaterial>>().is_empty(),
        "删除后 material 应被回收"
    );
    assert!(world.iter_entities().count() < baseline_entities);
}

/// 连续 placement preview 只刷新根 transform，不改变 entity/mesh/material identity
/// （change: add-model-focus-editing，任务 1.1 / design D4）。
#[test]
fn placement_preview_keeps_entity_and_resource_identity() {
    let mut world = world_with_resources();
    let node = model_node();

    // 内容 signature 恒定；仅 placement 变化。同一资源注册一次，引用逐帧更新 placement。
    let snapshot = sphere_snapshot("content");
    let resources = resource_table([(
        reference_for(&snapshot, ModelPlacement::default()).resource_key,
        snapshot,
    )]);
    let base = reference_for(&sphere_snapshot("content"), ModelPlacement::default());

    run_sync(
        &mut world,
        &scene_with(&node, Some(base.clone())),
        &resources,
    );
    let entity_count = world.iter_entities().count();
    let mesh_count = world.resource::<Assets<Mesh>>().len();
    let material_count = world.resource::<Assets<StandardMaterial>>().len();
    assert!(mesh_count >= 1 && material_count >= 1);

    for index in 0..8 {
        let placement = ModelPlacement {
            offset: crate::protocol::ModelOffset {
                x: index as f32 * 0.25,
                y: 0.0,
                z: 0.0,
            },
            scale: 1.0 + index as f32 * 0.1,
            yaw: index as f32 * 0.2,
        };
        let mut reference = base.clone();
        reference.placement = placement;
        run_sync(&mut world, &scene_with(&node, Some(reference)), &resources);
    }
    assert_eq!(
        world.iter_entities().count(),
        entity_count,
        "placement preview 不应增删实体"
    );
    assert_eq!(
        world.resource::<Assets<Mesh>>().len(),
        mesh_count,
        "mesh 数不应增长"
    );
    assert_eq!(
        world.resource::<Assets<StandardMaterial>>().len(),
        material_count,
        "material 数不应增长"
    );
}

/// 聚焦可见性（任务 2.1）：只显示目标模型，其余模型隐藏但不销毁实体。
#[test]
fn focus_hides_non_target_models_without_despawn() {
    let mut world = world_with_resources();

    let node = |id: &str| GraphNode {
        model_preview: None,
        id: id.to_owned(),
        kind: "model".into(),
        x: 0.0,
        y: 0.0,
        width: 224.0,
        height: 116.0,
        body: String::new(),
        title: String::new(),
        type_label: String::new(),
        progress: 0.0,
        busy: false,
        texture: false,
        media_loading: false,
        resizable: false,
        ghost: false,
        card_label: None,
        group: None,
        model: None,
        composite_asset: None,
        history_strip: None,
        aggregate_run: None,
        shot_preview: None,
    };
    let snapshot = ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "b".into(),
            parent: None,
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [1.0; 3],
        }],
        signature: "sig".into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    };
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let resources = resource_table([(reference.resource_key.clone(), snapshot)]);
    let mut scene = Scene {
        nodes: vec![node("n1"), node("n2")],
        ..Scene::default()
    };
    for entry in &mut scene.nodes {
        entry.model = Some(reference.clone());
    }
    run_sync(&mut world, &scene, &resources);
    let entities_after_spawn = world.iter_entities().count();

    // 聚焦 n1：n2 隐藏。
    scene.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "n1".to_owned(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 10.0,
        fov: 0.8,
        radius: 1.0,
    });
    run_sync(&mut world, &scene, &resources);
    // 实体未销毁（无副本、无重建）：数量不减少。
    assert!(world.iter_entities().count() >= entities_after_spawn);
    assert_eq!(
        world
            .resource::<super::super::runtime::FocusVisuals>()
            .node
            .as_deref(),
        Some("n1")
    );
}

#[test]
fn explicit_resource_references_track_two_roots_and_frozen_capture_until_last_release() {
    use super::super::runtime::{CaptureRetention, ModelVisuals};
    let mut world = world_with_resources();
    let (resources, references) = table_for(&["shared-content"]);
    let mut a = model_node();
    a.id = "a".into();
    a.model = Some(references[0].clone());
    let mut b = a.clone();
    b.id = "b".into();
    b.x = 600.;
    let mut scene = Scene {
        nodes: vec![a, b],
        ..Scene::default()
    };
    run_sync(&mut world, &scene, &resources);
    let (mesh, material) = {
        let visuals = world.resource::<ModelVisuals>();
        let root = &visuals.roots["a"];
        let mesh = root.mesh_handles[0].clone();
        let material = root.material_handles[0].clone();
        assert_eq!(visuals.mesh_references.count(&mesh.id()), 2);
        assert_eq!(visuals.material_references.count(&material.id()), 2);
        (mesh, material)
    };
    world
        .resource_mut::<ModelVisuals>()
        .capture_retention
        .insert(
            42,
            CaptureRetention {
                meshes: vec![mesh.clone(), mesh.clone()],
                materials: vec![material.clone(), material.clone()],
                bytes: 0,
            },
        );
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .mesh_references
            .count(&mesh.id()),
        3
    );
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .material_references
            .count(&material.id()),
        3
    );
    scene.nodes.retain(|n| n.id == "b");
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .mesh_references
            .count(&mesh.id()),
        2
    );
    assert!(world.resource::<Assets<Mesh>>().contains(mesh.id()));
    scene.nodes.clear();
    run_sync(&mut world, &scene, &resources);
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .mesh_references
            .count(&mesh.id()),
        1
    );
    assert_eq!(
        world
            .resource::<ModelVisuals>()
            .material_references
            .count(&material.id()),
        1
    );
    assert!(world.resource::<Assets<Mesh>>().contains(mesh.id()));
    assert!(
        world
            .resource::<Assets<StandardMaterial>>()
            .contains(material.id())
    );
    let budget: serde_json::Value =
        serde_json::from_str(&world.resource::<ModelVisuals>().budget_json(
            world.resource::<Assets<Mesh>>(),
            world.resource::<Assets<StandardMaterial>>(),
        ))
        .unwrap();
    assert_eq!(budget["resourceOwnership"]["consumers"], 1);
    assert_eq!(budget["resourceOwnership"]["meshReferences"], 1);
    assert_eq!(budget["resourceOwnership"]["materialReferences"], 1);
    world
        .resource_mut::<ModelVisuals>()
        .capture_retention
        .remove(&42);
    run_sync(&mut world, &scene, &resources);
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(visuals.mesh_references.count(&mesh.id()), 0);
    assert_eq!(visuals.material_references.count(&material.id()), 0);
    assert_eq!(visuals.mesh_references.references(), 0);
    assert_eq!(visuals.material_references.references(), 0);
    assert!(world.resource::<Assets<Mesh>>().is_empty());
    assert!(world.resource::<Assets<StandardMaterial>>().is_empty());
}

/// 聚焦可见性只写层级根：后代靠 Bevy 可见性传播继承，不再逐实体下发命令
/// （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D6）。
#[test]
fn focus_visibility_writes_only_hierarchy_root_and_leaves_descendants_inherited() {
    use super::super::runtime::ModelVisuals;

    let mut world = world_with_resources();
    let (resources, references) = table_for(&["shared-content"]);
    let mut a = model_node();
    a.id = "a".into();
    a.model = Some(references[0].clone());
    let mut b = a.clone();
    b.id = "b".into();
    b.x = 600.0;
    let mut scene = Scene {
        nodes: vec![a, b],
        ..Scene::default()
    };
    run_sync(&mut world, &scene, &resources);

    scene.model_focus = Some(crate::protocol::ModelFocus {
        version: crate::protocol::MODEL_FOCUS_VERSION.to_owned(),
        node_id: "a".to_owned(),
        target: [0.0, 0.0, 0.0],
        yaw: 0.0,
        pitch: 0.0,
        distance: 10.0,
        fov: 0.8,
        radius: 1.0,
    });
    run_sync(&mut world, &scene, &resources);

    let (target_root, target_entities, other_root, other_entities, inserts) = {
        let visuals = world.resource::<ModelVisuals>();
        (
            visuals.roots["a"].root_entity(),
            visuals.roots["a"].entities.clone(),
            visuals.roots["b"].root_entity(),
            visuals.roots["b"].entities.clone(),
            visuals.hot_path.focus_visibility_inserts,
        )
    };
    assert_eq!(
        world.get::<Visibility>(target_root),
        Some(&Visibility::Inherited)
    );
    assert_eq!(
        world.get::<Visibility>(other_root),
        Some(&Visibility::Hidden)
    );
    // 只写根：没有任何后代被写成 Hidden，全部保持默认 Inherited 交给传播。
    assert!(target_entities.len() > 1);
    for entity in target_entities.iter().chain(other_entities.iter()) {
        if *entity == target_root || *entity == other_root {
            continue;
        }
        assert_ne!(
            world.get::<Visibility>(*entity),
            Some(&Visibility::Hidden),
            "非根实体不应被逐帧写入 Hidden"
        );
    }
    // 每次同步只在根上写一次命令（两个根 × 两轮同步）。
    assert_eq!(inserts, 4);
}

/// 归属集合不变时跳过资源引用全量重建，但引用计数仍然可用
/// （change: 2026-10-14-scope-film-set-object-picking-to-focus，design D8）。
#[test]
fn unchanged_ownership_skips_reference_rebuild_but_keeps_counts() {
    use super::super::runtime::ModelVisuals;

    let mut world = world_with_resources();
    let (resources, references) = table_for(&["shared-content"]);
    let mut node = model_node();
    node.model = Some(references[0].clone());
    let scene = Scene {
        nodes: vec![node],
        ..Scene::default()
    };

    run_sync(&mut world, &scene, &resources);
    let first_rebuilds = world
        .resource::<ModelVisuals>()
        .hot_path
        .resource_reference_rebuilds;
    assert!(first_rebuilds >= 1, "首次必须建立引用");

    run_sync(&mut world, &scene, &resources);
    let visuals = world.resource::<ModelVisuals>();
    assert_eq!(
        visuals.hot_path.resource_reference_rebuilds, first_rebuilds,
        "归属未变不应重建引用"
    );
    assert!(visuals.hot_path.resource_reference_skips >= 1);
    let mesh = visuals.roots[&scene.nodes[0].id].mesh_handles[0].id();
    assert_eq!(
        visuals.mesh_references.count(&mesh),
        1,
        "跳过重建后引用仍然有效"
    );
}
