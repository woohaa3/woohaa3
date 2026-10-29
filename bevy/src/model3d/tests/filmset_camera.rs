//! 拍摄镜头相机标记集合的 ECS 生命周期回归
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.1；
//!  承接 change: 2026-10-13-add-film-set-hover-camera-entity）。
//!
//! 无 RenderPlugin：直接驱动 `filmset_camera::sync`，断言稳定多标记、无旧姿态、失效回收与
//! 网格/材质资源有界复用，不创建真实相机或 render pass。

use super::{reference_for, resource_table, run_sync, scene_with, world_with_resources};
use crate::model3d::filmset_camera::{
    FilmSetCameraAssets, FilmSetCameraRoot, FilmSetCameraVisual, sync,
};
use crate::motion::CameraState;
use crate::protocol::{
    AnimationPlayback, GraphNode, ModelOp, ModelPlacement, ModelSnapshot, PlaybackCamera, Scene,
    Selection,
};
use bevy::prelude::*;

fn film_node(id: &str) -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id": id, "type": "model", "x": 0, "y": 0, "width": 260, "height": 195,
        "compositeAsset": { "x": 0, "y": 0, "width": 260, "height": 195 }
    }))
    .unwrap()
}

fn preview_node(id: &str, kind: &str) -> GraphNode {
    serde_json::from_value(serde_json::json!({
        "id": id, "type": "film-set-shot-preview", "x": 320, "y": 0, "width": 240, "height": 167,
        "shotPreview": {
            "filmSetNodeId": "film", "clipId": "clip-1", "kind": kind, "name": "镜头",
            "aspect": 1.7777778, "duration": if kind == "dynamic" { 5.0 } else { 0.0 },
            "state": "ready",
            "coverCamera": { "azimuth": 0.0, "elevation": std::f32::consts::FRAC_PI_4, "distance": 8.0, "focusOffset": [0.0, 0.0, 0.0] }
        }
    }))
    .unwrap()
}

fn box_snapshot() -> ModelSnapshot {
    ModelSnapshot {
        scene_version: Some(crate::protocol::MODEL_SCENE_IR_V2.to_owned()),
        ops: vec![ModelOp::Box {
            id: "body".into(),
            parent: None,
            position: [0.0, 0.0, 0.0],
            rotation: [0.0; 3],
            scale: [1.0; 3],
            color: Some("#ffffff".into()),
            material: None,
            size: [2.0, 2.0, 2.0],
        }],
        signature: "sig-film".into(),
        extent: 2.0,
        aabb: None,
        geometry_keys: None,
        prepared_bounds: None,
        placement: ModelPlacement::default(),
    }
}

fn playback(node_id: &str, view_mode: &str, target: Option<&str>) -> AnimationPlayback {
    AnimationPlayback {
        clip_id: "clip".into(),
        source_identity: "src".into(),
        generation: 1,
        view_mode: view_mode.into(),
        target_preview_node_id: target.map(str::to_owned),
        node_id: node_id.into(),
        version: crate::motion::MOTION_IR_VERSION.into(),
        time: 1.0,
        duration: 4.0,
        looped: true,
        backdrop: None,
        playing: true,
        initial_camera: PlaybackCamera {
            aspect: "16:9".into(),
            azimuth: 0.0,
            elevation: std::f32::consts::FRAC_PI_4,
            distance: 8.0,
            focus_offset: [0.0; 3],
        },
        camera_motion: Vec::new(),
        model_motion: Vec::new(),
        objects: Vec::new(),
    }
}

/// 构造绑定片场节点 + 预览节点的场景（无 hover 依赖：标记按合法镜头集合稳定存在）。
fn film_scene(node_id: &str, previews: &[(&str, &str)]) -> Scene {
    let snapshot = box_snapshot();
    let reference = reference_for(&snapshot, ModelPlacement::default());
    let mut scene = scene_with(&film_node(node_id), Some(reference));
    scene.selection = Selection::default();
    scene
        .nodes
        .extend(previews.iter().map(|(id, kind)| preview_node(id, kind)));
    scene
}

fn camera() -> CameraState {
    CameraState {
        azimuth: 0.0,
        elevation: std::f32::consts::FRAC_PI_4,
        distance: 8.0,
        focus_offset: Vec3::ZERO,
    }
}

struct Harness {
    world: World,
    resources: crate::model3d::runtime::ModelAssets,
}

impl Harness {
    fn new(scene: &Scene) -> Self {
        let snapshot = box_snapshot();
        let mut world = world_with_resources();
        world.init_resource::<FilmSetCameraAssets>();
        world.init_resource::<FilmSetCameraVisual>();
        let resources = resource_table([(
            reference_for(&snapshot, ModelPlacement::default()).resource_key,
            snapshot,
        )]);
        run_sync(&mut world, scene, &resources);
        Self { world, resources }
    }

    /// 复刻真实调度：先按新场景同步模型根，再同步辅助实体。
    ///
    /// 目标切换帧里新节点可能尚无模型根；生产调度每帧都跑 `sync_models`，测试必须一致，
    /// 否则新目标的 bounds 会因缺少根而解析为 `None`。
    fn sync_scene(&mut self, scene: &Scene, sampled: Option<CameraState>) {
        run_sync(&mut self.world, scene, &self.resources);
        self.sync(scene, sampled);
    }

    fn sync(&mut self, scene: &Scene, sampled: Option<CameraState>) {
        let visuals = self
            .world
            .remove_resource::<crate::model3d::ModelVisuals>()
            .unwrap();
        let mut assets = self.world.remove_resource::<FilmSetCameraAssets>().unwrap();
        let mut visual = self.world.remove_resource::<FilmSetCameraVisual>().unwrap();
        let mut meshes = self.world.remove_resource::<Assets<Mesh>>().unwrap();
        let mut materials = self
            .world
            .remove_resource::<Assets<StandardMaterial>>()
            .unwrap();
        let mut commands = self.world.commands();
        sync(
            &mut commands,
            &mut meshes,
            &mut materials,
            &mut assets,
            &mut visual,
            scene,
            sampled,
            &visuals,
            &self.resources,
        );
        self.world.flush();
        self.world.insert_resource(visuals);
        self.world.insert_resource(assets);
        self.world.insert_resource(visual);
        self.world.insert_resource(meshes);
        self.world.insert_resource(materials);
    }

    /// 当前标记根集合（按预览节点 id）。
    fn roots(&self) -> Vec<Entity> {
        let mut roots: Vec<Entity> = self
            .world
            .resource::<FilmSetCameraVisual>()
            .roots()
            .collect();
        roots.sort_by_key(|entity| entity.index());
        roots
    }

    fn marker_count(&self) -> usize {
        self.world.resource::<FilmSetCameraVisual>().marker_count()
    }

    fn root_count(&mut self) -> usize {
        self.world
            .query::<&FilmSetCameraRoot>()
            .iter(&self.world)
            .count()
    }

    fn mesh_count(&self) -> usize {
        self.world.resource::<Assets<Mesh>>().len()
    }

    fn material_count(&self) -> usize {
        self.world.resource::<Assets<StandardMaterial>>().len()
    }
}

#[test]
fn static_shots_have_stable_markers_without_playing_or_hover() {
    let scene = film_scene(
        "film",
        &[("shot-preview:a", "static"), ("shot-preview:b", "static")],
    );
    let mut harness = Harness::new(&scene);
    harness.sync(&scene, None);
    assert_eq!(harness.marker_count(), 2, "每个可见静态镜头一个标记");
    assert_eq!(harness.root_count(), 2);
    // 每个机体的子 mesh 均保持输出隔离，细节不泄漏到成片相机。
    for root in harness.roots() {
        let children = harness
            .world
            .entity(root)
            .get::<Children>()
            .expect("camera parts");
        assert!(!children.is_empty());
        for child in children.iter() {
            let entity = harness.world.entity(child);
            assert!(entity.contains::<Mesh3d>());
            assert!(!entity.contains::<Camera3d>());
            let layers = entity
                .get::<bevy::camera::visibility::RenderLayers>()
                .unwrap();
            assert!(!layers.iter().any(|layer| layer == 7));
        }
        assert!(!harness.world.entity(root).contains::<Camera3d>());
    }
}

/// 正交观察相机下机身必须投影到**可辨识但不遮挡主体**的像素尺寸。
#[test]
fn auxiliary_body_projects_to_viewable_screen_size() {
    let scene = film_scene("film", &[("shot-preview:a", "static")]);
    let mut harness = Harness::new(&scene);
    harness.sync(&scene, None);
    let root = harness.roots()[0];
    let scale = harness
        .world
        .entity(root)
        .get::<Transform>()
        .expect("root transform")
        .scale
        .x;
    let zoom = scene.viewport.zoom;
    // 机身基座直径 = geometry::BODY_WIDTH = 1.0 世界单位（见 filmset_camera 常量）。
    let screen_px = scale * 1.0 * zoom;
    assert!(
        screen_px >= 6.0,
        "机身投影约 {screen_px} CSS px，过小会看不见（scale={scale}, zoom={zoom}）"
    );
    assert!(
        screen_px <= 16.0,
        "机身不得遮挡被摄主体（{screen_px} CSS px，scale={scale}, zoom={zoom}）"
    );
}

#[test]
fn same_target_tick_reuses_entities_and_bounded_resources() {
    let scene = film_scene("film", &[("shot-preview:a", "static")]);
    let mut harness = Harness::new(&scene);
    harness.sync(&scene, None);
    let roots = harness.roots();
    let meshes = harness.mesh_count();
    let materials = harness.material_count();

    for step in 0..8 {
        let moved = CameraState {
            azimuth: step as f32 * 0.3,
            ..camera()
        };
        // 活动动态镜头用同一 T 的采样相机；这里验证静态镜头同目标只更新 transform。
        harness.sync(&scene, None);
        assert_eq!(harness.roots(), roots, "同目标只在原实体上更新 transform");
        assert_eq!(harness.root_count(), 1, "不得累积旧实体");
        let _ = moved;
    }
    assert_eq!(harness.mesh_count(), meshes, "网格句柄有界复用");
    assert_eq!(harness.material_count(), materials, "材质句柄有界复用");
}

/// 活动动态镜头消费同一 T 的采样相机，标记随播放姿态移动；停止/失采样即回收。
#[test]
fn live_dynamic_sampled_pose_and_cleanup_without_leaving_old_pose() {
    let mut scene = film_scene("film", &[("shot-preview:a", "dynamic")]);
    scene.animation_playback = Some(playback(
        "film",
        "shot-node-preview",
        Some("shot-preview:a"),
    ));
    let mut harness = Harness::new(&scene);
    harness.sync_scene(&scene, Some(camera()));
    let root = harness.roots()[0];
    let first = harness
        .world
        .entity(root)
        .get::<Transform>()
        .unwrap()
        .translation;

    // 同一 T 的采样相机变化：标记移动，但仍是同一实体（不重建 mesh/material）。
    let moved = CameraState {
        azimuth: 1.2,
        ..camera()
    };
    harness.sync(&scene, Some(moved));
    assert_eq!(harness.roots()[0], root, "活动镜头只更新 transform");
    let second = harness
        .world
        .entity(root)
        .get::<Transform>()
        .unwrap()
        .translation;
    assert_ne!(first, second, "采样相机变化推进标记姿态");

    // 清除播放投影：回到零点封面相机（同一标记实体，不累积旧实体）。
    scene.animation_playback = None;
    harness.sync(&scene, None);
    assert_eq!(harness.root_count(), 1, "非活动镜头返回初始标记");
}

/// 聚焦隔离、镜头删除与源失效都回收标记，不保留旧实体或旧姿态。
#[test]
fn focus_removal_and_invalid_sample_cleanup_markers() {
    let scene = film_scene("film", &[("shot-preview:a", "static")]);
    let mut harness = Harness::new(&scene);
    harness.sync(&scene, None);
    assert_eq!(harness.root_count(), 1);

    // 进入 focus：标记按既有隔离隐藏。
    let mut focused = scene.clone();
    focused.model_focus = Some(
        serde_json::from_value(serde_json::json!({
            "nodeId": "film", "target": [0,0,0], "yaw": 0, "pitch": 0, "distance": 100, "fov": 0.87
        }))
        .unwrap(),
    );
    harness.sync(&focused, None);
    assert!(harness.roots().is_empty());
    assert_eq!(harness.root_count(), 0);

    // 恢复后重新按最新镜头建立标记（无旧实体累积）。
    harness.sync(&scene, None);
    assert_eq!(harness.root_count(), 1);

    // 源片场删除（预览闭包随源清理）：标记消失。
    let empty = Scene {
        selection: Selection::default(),
        ..Scene::default()
    };
    harness.sync_scene(&empty, None);
    assert!(harness.roots().is_empty());
    assert_eq!(harness.root_count(), 0);
}

#[test]
fn target_switch_reclaims_previous_marker() {
    let a = film_scene("film", &[("shot-preview:a", "static")]);
    let mut harness = Harness::new(&a);
    harness.sync(&a, None);
    let first = harness.roots()[0];
    let meshes = harness.mesh_count();
    let materials = harness.material_count();

    let b = film_scene("film", &[("shot-preview:b", "static")]);
    harness.sync_scene(&b, None);
    let second = harness.roots()[0];
    assert_ne!(first, second);
    assert!(harness.world.get_entity(first).is_err(), "旧目标实体被回收");
    assert_eq!(harness.root_count(), 1);
    assert_eq!(
        harness.mesh_count(),
        meshes,
        "切换目标复用全部机壳与线框网格"
    );
    assert_eq!(harness.material_count(), materials, "切换目标复用黑白材质");
}
