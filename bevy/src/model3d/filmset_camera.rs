//! 拍摄镜头相机标记集合
//! （change: 2026-10-15-add-film-set-shooting-shot-previews，任务 5.1 / design D5；
//!  承接 change: 2026-10-13-add-film-set-hover-camera-entity 的临时小相机）。
//!
//! 总览为**每个可见拍摄镜头**显示一台稳定关联的小相机标记：切角机壳、提手、黑白镜头环与
//! 开放线框视锥。静态与非活动动态镜头使用零点封面相机（`shotPreview.coverCamera`），活动
//! 动态镜头使用同一 T 的采样相机（`AnimationCameraState`）。它是可丢弃的辅助 Entity，不是
//! 规范对象：
//!
//! - 不创建真实 `Camera3d` / preview `Image` / render pass；
//! - 不加入模型 AABB、scope、layout、picking、截图 bounds 或 canonical；
//! - 只消费已接受场景与共享姿态派生（[`super::shot_adapter::model_bounds_for_node`] /
//!   [`super::shot_adapter::sampled_camera_pose`]），不订阅 hover、不自行开播。
//!
//! 输出隔离：实体只挂在独立辅助渲染层，overview 观察相机可见，shot preview/capture 与原生
//! 视频导出不可见（任务 5.1）。标记随镜头身份稳定存在，切换/删除/renderer 重建按 owner 清理。
//!
//! app 在运动求值后调用 [`sync`]，本模块不依赖 `bridge` / wasm，可在 ECS 单测中验证生命周期。

use std::collections::HashSet;

use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;

use super::runtime::{ModelAssets, ModelVisuals};
use super::shot_adapter::{model_bounds_for_node, sampled_camera_pose};
use crate::canvas_ecs::components::FilmSetCameraMarker;
use crate::protocol::Scene;
mod geometry;

/// 辅助相机使用的独立渲染层（任务 5.1）。
///
/// overview 观察相机（层 0）可见；shot preview/capture 的 view mask 只含 `[0, CAPTURE_LAYER]`，
/// 不含本层，因此截图、镜头预览与原生导出都不包含辅助机身/镜头/视锥。
pub(crate) const FILM_SET_CAMERA_LAYER: usize = 2;

/// 机身投影尺寸目标（CSS 像素；design D5，真实桌面验收后定稿）。
///
/// 首版取 24 偏大：缩小视野看整个片场时，恒定屏幕尺寸会相对人物显得臃肿并遮挡主体。
/// 收敛到 12 CSS px：仍清晰可辨，但明显小于被拍摄对象。
pub(crate) const FILM_SET_CAMERA_TARGET_CSS_PX: f32 = 12.0;
/// 距离/半径下限（避免除零与退化姿态）。
const MIN_EXTENT: f32 = 1e-3;

/// 辅助实体使用的视角隔离层：观察相机层与辅助层。
fn film_set_camera_layers() -> RenderLayers {
    RenderLayers::from_layers(&[0, FILM_SET_CAMERA_LAYER])
}

/// 复用的辅助 mesh/material 句柄缓存（renderer 生命周期内有界，不随 tick 增长）。
#[derive(Resource, Default)]
pub(crate) struct FilmSetCameraAssets {
    dark: Option<Handle<StandardMaterial>>,
    light: Option<Handle<StandardMaterial>>,
    meshes: Option<[Handle<Mesh>; 4]>,
}

/// 辅助相机根标记（机身/镜头/视锥子实体的父级）。
#[derive(Component)]
pub(crate) struct FilmSetCameraRoot;

/// 一个可见拍摄镜头标记的纯派生目标（design D5）。
///
/// 静态与非活动动态镜头用零点封面相机；活动动态镜头用同一 T 的采样相机。只按已接受场景与
/// 播放投影派生，不订阅 hover。
#[derive(Clone, Debug)]
pub(crate) struct MarkerTarget {
    /// 预览节点稳定 id（标记身份；位置/姿态变化不改变身份）。
    pub(crate) preview_node_id: String,
    /// 归属源片场 canonical 节点 id（包围球按它派生）。
    pub(crate) owner_node_id: String,
    /// 是否为唯一活动动态镜头（使用同一 T 的采样相机）。
    pub(crate) live: bool,
    /// 采样/封面相机（用于派生世界姿态）。
    pub(crate) camera: crate::motion::CameraState,
}

/// 由场景与采样镜头派生全部可见拍摄镜头标记目标（纯函数）。
///
/// 聚焦隔离（模型/图片/视频/模型编辑）时返回空集合，标记按既有隔离隐藏。活动动态镜头缺少
/// 有效采样时**跳过**该标记（不保留上一姿态），非活动镜头始终使用零点封面相机。
pub(crate) fn marker_targets(
    scene: &Scene,
    sampled: Option<&crate::motion::CameraState>,
) -> Vec<MarkerTarget> {
    if crate::canvas_query::shot_preview::focuses_isolate(scene) {
        return Vec::new();
    }
    let playback = scene
        .animation_playback
        .as_ref()
        .filter(|playback| playback.view_mode == "shot-node-preview");
    let mut targets = Vec::new();
    for node in &scene.nodes {
        let Some(preview) = node.shot_preview.as_ref() else {
            continue;
        };
        let is_live = preview.kind == "dynamic"
            && playback.is_some_and(|playback| {
                playback.node_id == preview.film_set_node_id
                    && playback.target_preview_node_id.as_deref() == Some(node.id.as_str())
            });
        let camera = if is_live {
            let Some(sampled) = sampled else {
                continue;
            };
            *sampled
        } else {
            crate::motion::CameraState {
                azimuth: preview.cover_camera.azimuth,
                elevation: preview.cover_camera.elevation,
                distance: preview.cover_camera.distance,
                focus_offset: Vec3::from_array(preview.cover_camera.focus_offset),
            }
        };
        targets.push(MarkerTarget {
            preview_node_id: node.id.clone(),
            owner_node_id: preview.film_set_node_id.clone(),
            live: is_live,
            camera,
        });
    }
    targets
}

/// 由画布缩放派生**有界**展示尺度（design D5）。
///
/// 等距观察相机是**正交**投影：`1 世界单位 = zoom CSS px`（`canvas_camera_projection` 的
/// `WindowSize` + `scale = 1/zoom`），投影后的屏幕尺寸**不随观察距离变化**。因此辅助实体的
/// 世界尺度直接由「目标屏幕像素 / (机身直径 × zoom)」派生，使机身投影恒为约 12 CSS px；
/// 只补偿辅助 mesh 的展示尺度，不修改真实相机位置/朝向。
/// 非法/非有限 zoom 回退为 zoom = 1 的尺度，绝不返回 0/NaN。
pub(crate) fn display_scale(zoom: f32) -> f32 {
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };
    let body_diameter = geometry::BODY_WIDTH;
    (FILM_SET_CAMERA_TARGET_CSS_PX / (body_diameter * zoom)).max(MIN_EXTENT)
}

/// 相机朝向：局部 -Z 指向有效注视点；退化时保持单位朝向。
fn facing_rotation(position: Vec3, focus: Vec3) -> Quat {
    let forward = focus - position;
    if !forward.is_finite() || forward.length() <= MIN_EXTENT {
        return Quat::IDENTITY;
    }
    Transform::from_translation(position)
        .looking_at(focus, Vec3::Y)
        .rotation
}

/// 同步全部拍摄镜头相机标记：合法目标创建/更新，失效/删除/聚焦清理（任务 5.1）。
///
/// 每帧只改根 transform/visibility 或增删标记实体；同目标不重建 mesh/material。活动镜头切换、
/// 镜头删除、进入 focus、renderer 重建都按 owner 清理，不留旧实体或旧姿态。
///
/// `markers` 是**从 ECS 派生的本帧视图**（`FilmSetCameraMarker` 组件），不是 Resource 里的第二份
/// owner 事实；调用方按当前 World 收集后传入，已销毁的实体不会留在状态里。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    assets: &mut FilmSetCameraAssets,
    markers: &[(Entity, FilmSetCameraMarker)],
    scene: &Scene,
    sampled: Option<crate::motion::CameraState>,
    models: &ModelVisuals,
    resources: &ModelAssets,
) {
    let targets = marker_targets(scene, sampled.as_ref());
    let find = |id: &str| {
        markers
            .iter()
            .find(|(_, marker)| marker.preview_node_id == id)
            .map(|(entity, _)| *entity)
    };
    // 清理：不再合格（镜头删除/聚焦隔离/无有效采样）的标记连同实体回收。
    let alive: HashSet<&str> = targets.iter().map(|target| target.preview_node_id.as_str()).collect();
    for (root, marker) in markers {
        if !alive.contains(marker.preview_node_id.as_str()) {
            commands.entity(*root).try_despawn();
        }
    }

    let scale = display_scale(scene.viewport.zoom);
    for target in &targets {
        let Some(bounds) = model_bounds_for_node(scene, models, resources, &target.owner_node_id)
        else {
            // 无合法目标边界：不伪造位置，回收旧标记。
            if let Some(root) = find(&target.preview_node_id) {
                commands.entity(root).try_despawn();
            }
            continue;
        };
        // 采样/封面相机是**场景单位**：与内容共用同一显示变换映射到画布世界
        // （change: 2026-10-23-isolate-film-set-camera-space，任务 2.2 / design D2）。
        let display =
            super::shot_adapter::display_unit_for_node(scene, resources, &target.owner_node_id);
        let Some((focus, position)) = sampled_camera_pose(bounds, display, &target.camera) else {
            if let Some(root) = find(&target.preview_node_id) {
                commands.entity(root).try_despawn();
            }
            continue;
        };
        let rotation = facing_rotation(position, focus);
        if let Some(root) = find(&target.preview_node_id) {
            // 同目标 tick：只更新根 transform 与可见性，不重建实体或 mesh。
            if let Ok(mut entity) = commands.get_entity(root) {
                entity.insert((
                    Transform {
                        translation: position,
                        rotation,
                        scale: Vec3::splat(scale),
                    },
                    Visibility::Inherited,
                ));
            }
            continue;
        }
        let camera_meshes = ensure_meshes(meshes, assets);
        let [dark, light] = ensure_materials(materials, assets);
        let layer = film_set_camera_layers();
        let root = commands
            .spawn((
                Name::new("film-set-shot-camera-marker"),
                FilmSetCameraRoot,
                FilmSetCameraMarker {
                    preview_node_id: target.preview_node_id.clone(),
                    owner_node_id: target.owner_node_id.clone(),
                },
                Transform {
                    translation: position,
                    rotation,
                    scale: Vec3::splat(scale),
                },
                Visibility::Inherited,
            ))
            .id();
        // 机体与开放视锥按黑白合并为四个子 mesh，所有细节复用两个不透明材质。
        for (mesh, material) in
            camera_meshes
                .into_iter()
                .zip([dark.clone(), light.clone(), dark, light])
        {
            commands.spawn((
                ChildOf(root),
                Mesh3d(mesh),
                MeshMaterial3d(material),
                Transform::IDENTITY,
                layer.clone(),
            ));
        }
    }
}

/// 隐藏并回收全部辅助实体（renderer 销毁/失效路径；不保留旧目标资源）。
pub(crate) fn despawn_all(commands: &mut Commands, markers: &[(Entity, FilmSetCameraMarker)]) {
    for (root, _) in markers {
        commands.entity(*root).try_despawn();
    }
}

fn ensure_meshes(meshes: &mut Assets<Mesh>, assets: &mut FilmSetCameraAssets) -> [Handle<Mesh>; 4] {
    assets
        .meshes
        .get_or_insert_with(|| geometry::build().map(|mesh| meshes.add(mesh)))
        .clone()
}

fn ensure_materials(
    materials: &mut Assets<StandardMaterial>,
    assets: &mut FilmSetCameraAssets,
) -> [Handle<StandardMaterial>; 2] {
    // 场景辅助标记使用恒定黑白，而不是随主题改变的品牌色：深浅背景均有对比区域。
    // unlit + opaque 保留黑白对比，不依赖场景灯光，也不被半透明混色削弱。
    let mut material = |color| {
        materials.add(StandardMaterial {
            base_color: color,
            unlit: true,
            ..default()
        })
    };
    let dark = assets
        .dark
        .get_or_insert_with(|| material(Color::BLACK))
        .clone();
    let light = assets
        .light
        .get_or_insert_with(|| material(Color::WHITE))
        .clone();
    [dark, light]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::GraphNode;

    fn preview_node(id: &str, kind: &str) -> GraphNode {
        serde_json::from_str(&format!(
            r#"{{"id":"{id}","type":"film-set-shot-preview","x":0,"y":0,"width":240,"height":167,
                "shotPreview":{{"filmSetNodeId":"film","clipId":"clip-1","kind":"{kind}","name":"镜头",
                "aspect":1.7777778,"duration":5,"state":"ready",
                "coverCamera":{{"azimuth":0.5,"elevation":0.7,"distance":8,"focusOffset":[0,1,0]}}}}}}"#
        ))
        .unwrap()
    }

    fn film_set_node() -> GraphNode {
        serde_json::from_str(
            r#"{"id":"film","type":"model","x":0,"y":0,"width":260,"height":195,
                "model":{"resourceKey":"v:sig"},
                "compositeAsset":{"x":0,"y":0,"width":260,"height":195}}"#,
        )
        .expect("film set node")
    }

    fn scene_with(preview: GraphNode) -> Scene {
        Scene {
            version: crate::protocol::CANVAS_RENDER_SCENE_VERSION.to_owned(),
            nodes: vec![film_set_node(), preview],
            selection: crate::protocol::Selection::default(),
            ..Scene::default()
        }
    }

    fn sampled(azimuth: f32) -> crate::motion::CameraState {
        crate::motion::CameraState {
            azimuth,
            elevation: 0.3,
            distance: 10.0,
            focus_offset: Vec3::ZERO,
        }
    }

    /// 静态与非活动动态镜头始终有标记，且使用零点封面相机（不要求先进入播放）。
    #[test]
    fn static_and_inactive_dynamic_use_cover_camera() {
        for kind in ["static", "dynamic"] {
            let scene = scene_with(preview_node("shot-preview:a", kind));
            let targets = marker_targets(&scene, None);
            assert_eq!(targets.len(), 1, "kind={kind}");
            assert!(!targets[0].live);
            assert_eq!(targets[0].camera.azimuth, 0.5);
            assert_eq!(targets[0].camera.distance, 8.0);
            assert_eq!(targets[0].owner_node_id, "film");
        }
    }

    /// 活动动态镜头使用同一 T 的采样相机；缺少有效采样时不伪造标记。
    #[test]
    fn live_dynamic_uses_same_t_sampled_camera_and_skips_without_sample() {
        let mut scene = scene_with(preview_node("shot-preview:a", "dynamic"));
        scene.animation_playback = Some(
            serde_json::from_str(
                r#"{"clipId":"clip-1","nodeId":"film","version":"woohaa-motion-ir-v1","viewMode":"shot-node-preview",
                    "targetPreviewNodeId":"shot-preview:a","time":2.5,"duration":5,"generation":7,
                    "initialCamera":{"aspect":"16:9","azimuth":0,"elevation":0.785398,"distance":8,"focusOffset":[0,0,0]}}"#,
            )
            .unwrap(),
        );
        let live = marker_targets(&scene, Some(&sampled(1.9)));
        assert_eq!(live.len(), 1);
        assert!(live[0].live);
        assert_eq!(live[0].camera.azimuth, 1.9, "活动镜头用采样相机，而非封面");
        assert!(
            marker_targets(&scene, None).is_empty(),
            "无有效采样不得保留上一姿态"
        );

        // 目标预览节点不匹配时不进入活动态（唯一活动时钟）。
        let mut mismatched = scene.clone();
        mismatched
            .animation_playback
            .as_mut()
            .unwrap()
            .target_preview_node_id = Some("shot-preview:other".to_owned());
        let covers = marker_targets(&mismatched, Some(&sampled(1.9)));
        assert!(!covers[0].live);
        assert_eq!(covers[0].camera.azimuth, 0.5);

        // 非动态卡片不进入活动态。
        let mut statics = scene_with(preview_node("shot-preview:a", "static"));
        statics.animation_playback = scene.animation_playback;
        assert!(!marker_targets(&statics, Some(&sampled(1.9)))[0].live);
    }

    /// 聚焦隔离隐藏全部标记；普通节点不产生标记。
    #[test]
    fn focus_isolates_and_plain_nodes_never_mark() {
        let mut scene = scene_with(preview_node("shot-preview:a", "static"));
        scene.model_focus = Some(
            serde_json::from_str(
                r#"{"nodeId":"film","target":[0,0,0],"yaw":0,"pitch":0,"distance":10,"fov":0.87}"#,
            )
            .unwrap(),
        );
        assert!(marker_targets(&scene, None).is_empty());
        let plain: Scene = Scene {
            nodes: vec![serde_json::from_str(r#"{"id":"n","type":"image","x":0,"y":0}"#).unwrap()],
            ..Scene::default()
        };
        assert!(marker_targets(&plain, None).is_empty());
    }

    #[test]
    fn monochrome_materials_keep_contrast_without_lighting_or_blending() {
        let mut materials = Assets::<StandardMaterial>::default();
        let mut assets = FilmSetCameraAssets::default();
        let handles = ensure_materials(&mut materials, &mut assets);
        let luminances = handles.map(|handle| {
            let material = materials.get(&handle).unwrap();
            assert!(material.unlit, "可见性不得依赖场景光照");
            assert_eq!(material.alpha_mode, AlphaMode::Opaque);
            let color = material.base_color.to_linear();
            assert_eq!(color.alpha, 1.0);
            0.2126 * color.red + 0.7152 * color.green + 0.0722 * color.blue
        });
        // 对所有采样的背景亮度，至少一种材质提供 >=4.5:1 的数学对比。
        // 这是材质数值检查，不代表复杂背景、遮挡或抗锯齿后的真实画面验收。
        for step in 0..=1000 {
            let background = step as f32 / 1000.0;
            let best = luminances
                .map(|luminance| {
                    (luminance.max(background) + 0.05) / (luminance.min(background) + 0.05)
                })
                .into_iter()
                .fold(0.0_f32, f32::max);
            assert!(best >= 4.5, "background={background}, contrast={best}");
        }
    }

    /// 展示尺度按画布 zoom 派生：zoom=1 时机身约 12 CSS px，随 zoom 反比缩小世界尺度，
    /// 非法 zoom 回退为有限默认（绝不返回 0/NaN）。
    #[test]
    fn display_scale_targets_constant_screen_size_and_never_huge() {
        assert!(
            (display_scale(1.0) - FILM_SET_CAMERA_TARGET_CSS_PX / geometry::BODY_WIDTH).abs()
                < 1e-4
        );
        assert!((display_scale(f32::NAN) - display_scale(1.0)).abs() < 1e-6);
        assert!((display_scale(0.0) - display_scale(1.0)).abs() < 1e-6);
        // zoom 越大，世界尺度越小（投影后屏幕尺寸近似恒定）。
        assert!(display_scale(4.0) < display_scale(1.0));
        // 任意合法/非法输入都有限且为正。
        for zoom in [0.1, 1.0, 12.0, f32::NAN, f32::INFINITY, -3.0, 0.0] {
            let scale = display_scale(zoom);
            assert!(scale.is_finite() && scale > 0.0, "zoom={zoom} -> {scale}");
        }
    }

    /// 朝向局部 -Z 指向注视点；退化时保持有限单位朝向。
    #[test]
    fn facing_never_turns_into_degenerate_rotation() {
        let identity = facing_rotation(Vec3::ZERO, Vec3::ZERO);
        assert!(identity.is_finite());
        let facing = facing_rotation(Vec3::new(0.0, 0.0, 10.0), Vec3::ZERO);
        assert!((facing * Vec3::NEG_Z).z < 0.0);
    }

    /// 辅助层与输出隔离：独立层、不含截图层。
    #[test]
    fn auxiliary_layer_is_isolated_from_capture() {
        assert_ne!(FILM_SET_CAMERA_LAYER, 0);
        assert_ne!(FILM_SET_CAMERA_LAYER, super::super::editor::EDITOR_LAYER);
        // 截图/预览层（7）必须排除；该常量仅在 wasm 下编译，这里用其固定字面量断言。
        #[cfg(feature = "canvas-core")]
        assert_ne!(
            FILM_SET_CAMERA_LAYER,
            crate::model3d::capture::CAPTURE_LAYER
        );
        let layers = film_set_camera_layers();
        assert!(layers.iter().any(|layer| layer == FILM_SET_CAMERA_LAYER));
        assert!(
            !layers.iter().any(|layer| layer == 7),
            "辅助实体不得进入截图/预览层"
        );
    }
}
