//! 模型工作区 → shot camera rig 的生产 adapter
//! （change: add-reusable-bevy-shot-camera，任务 5.1–5.3 / design D7）。
//!
//! 把当前聚焦模型节点、规范镜头参数（`modelEditor.shot`）、画幅与主题投影为 `shot_camera`
//! 模块的稳定 rig。canonical `modelCameras`、命令提交、输入优先级仍由 Web 拥有；本 adapter
//! 只拥有可丢弃的运行时 rig、gizmo、preview 与 capture 生命周期。
//!
//! 目标包围球（center/radius）在 scene 变化帧预计算并写入 rig，避免模块逐帧遍历 mesh 顶点。
//! 本模块只做纯投影，不依赖 `app` / bridge；具体系统接线由 `app` 完成。

use bevy::camera::visibility::RenderLayers;
use bevy::prelude::*;

use crate::protocol::Scene;
use crate::shot_camera::{
    Aabb, PreviewTarget, ShotCameraCommands, ShotCameraConfig, ShotCameraEditable, ShotCameraLens,
    ShotCameraPose, ShotCameraPreview, ShotCameraTarget, ShotCameraViewMask, ShotGizmoSelection,
    ShotPreviewClearColor, ShotPreviewViewport,
};

use super::layout::{model_anchor, model_unit, model_view_rotation};
use super::runtime::{ModelAssets, ModelVisuals};
use super::scene::{self, ModelAabb};

/// adapter 当前持有的 rig 与来源 identity。
#[derive(Resource, Default)]
pub(crate) struct ShotAdapterState {
    /// 当前 rig entity。
    pub(crate) rig: Option<Entity>,
    /// rig 对应的 canonical 镜头 id（切换时需要重建）。
    pub(crate) camera_id: Option<String>,
    /// rig 对应的模型节点 id。
    pub(crate) node_id: Option<String>,
}

/// 当前聚焦模型的世界包围球（中心 + 半径）。
#[derive(Clone, Copy)]
pub(crate) struct ModelBounds {
    pub(crate) center: Vec3,
    pub(crate) radius: f32,
}

/// 镜头窗口相机要看到的模型层。
///
/// 网格 mesh 在主画布层 0（wasm 上同时挂截图层）。只留截图层时，聚焦里能看见
/// gizmo（层 1），模型却不画。层 0 把模型带进来；gizmo 由预览同步另行叠上，截图帧再去掉。
pub(crate) fn shot_view_layers() -> RenderLayers {
    #[cfg(feature = "canvas-core")]
    {
        RenderLayers::from_layers(&[0, super::capture::CAPTURE_LAYER])
    }
    #[cfg(not(feature = "canvas-core"))]
    {
        RenderLayers::layer(0)
    }
}

/// 由已构建的模型根计算世界包围球（事件驱动，非逐帧；固定世界，不读取 viewport/surface）。
pub(crate) fn focused_model_bounds(
    scene: &Scene,
    models: &ModelVisuals,
    resources: &ModelAssets,
) -> Option<ModelBounds> {
    let node_id = scene
        .model_editor
        .as_ref()
        .map(|editor| editor.node_id.as_str())
        .or_else(|| {
            scene
                .model_focus
                .as_ref()
                .map(|focus| focus.node_id.as_str())
        })?;
    model_bounds_for_node(scene, models, resources, node_id)
}

/// 按**显式 nodeId** 派生模型/媒体目标世界包围球
/// （change: 2026-10-13-add-film-set-hover-camera-entity，任务 2.1 / design D2）。
///
/// 消除 `focused_model_bounds` 只能从 editor/focus 找目标的限制：overview 播放辅助视图与
/// focus-preview 共用同一公式，节点位置、placement、媒体平面与分组投影只应用一次，不重复叠加
/// 根变换。未注册资源/无模型引用且无媒体时返回 `None`。
pub(crate) fn model_bounds_for_node(
    scene: &Scene,
    models: &ModelVisuals,
    resources: &ModelAssets,
    node_id: &str,
) -> Option<ModelBounds> {
    let node = scene.nodes.iter().find(|node| node.id == node_id)?;
    let reference = node.model.as_ref()?;
    let root = models.roots.get(node_id)?;
    let model = resources
        .get(&reference.resource_key)
        .map(|arc| arc.as_ref())
        .unwrap_or(root.resource.as_ref());
    let placement = &reference.placement;
    let unit = model_unit(node, model, placement);
    let root_rotation = model_view_rotation(placement);
    let local = scene::placed_local_aabb(model, None)?.transformed(&Transform {
        rotation: root_rotation,
        scale: Vec3::splat(unit),
        ..default()
    });
    Some(ModelBounds::from_local_aabb(
        &local,
        model_anchor(node, model, placement, unit),
    ))
}

/// 由共享目标包围球与采样镜头状态派生世界姿态（focus + position）
/// （change: 2026-10-13-add-film-set-hover-camera-entity，任务 2.1 / design D2；
///  change: 2026-10-23-isolate-film-set-camera-space，任务 2.2 / design D2：完整相机经同一显示
///  变换映射，构图与节点矩形无关）。
///
/// `bounds.center` 已是画布世界的包围球中心；`camera` 的 distance 与 focus_offset 是世界
/// 单位。非有限输入返回 `None`（不伪造位置）。
pub(crate) fn sampled_camera_pose(
    bounds: ModelBounds,
    camera: &crate::motion::CameraState,
) -> Option<(Vec3, Vec3)> {
    if !bounds.center.is_finite() || !bounds.radius.is_finite() {
        return None;
    }
    let focus = bounds.center + camera.focus_offset;
    let position = crate::shot_camera::shot_camera_position(
        focus,
        camera.azimuth,
        camera.distance,
        camera.elevation,
    );
    Some((focus, position))
}

impl ModelBounds {
    /// 把根锚点平移叠加到局部 AABB，得到世界中心与包围球半径（纯计算，不遍历顶点）。
    pub(crate) fn from_local_aabb(local: &ModelAabb, translation: Vec3) -> ModelBounds {
        ModelBounds {
            center: translation + local.center(),
            radius: local.radius(),
        }
    }
}

/// surface 归一化尺寸。
fn surface_vec(scene: &Scene) -> Vec2 {
    scene
        .surface
        .as_ref()
        .map(|size| Vec2::new(size.width, size.height))
        .unwrap_or(Vec2::new(1.0, 1.0))
}

/** 当前 scene 是否应显示 shot rig（camera 模式且带 shot）。 */
///
/// 返回的 pose 语义按来源区分（change: 2026-10-23-isolate-film-set-camera-space）：
/// - 活动播放（`focus-preview`）的 `initialCamera` / 采样相机是**场景单位**，由 adapter 用显示
///   变换映射；
/// - `modelEditor.shot` 是前端已映射好的**画布世界**姿态（gizmo、命中与截图共用同一坐标）。
fn desired_shot(scene: &Scene) -> Option<(String, Option<String>, f32, ShotCameraPose, bool)> {
    let editor = scene.model_editor.as_ref()?;
    if editor.tool_mode != "camera" {
        return None;
    }
    let shot = editor.shot.as_ref()?;
    let pose = ShotCameraPose {
        azimuth: shot.azimuth,
        elevation: shot.elevation,
        distance: shot.distance,
        // 前端传入有效注视点，以模型中心为基准还原偏移。
        focus_offset: Vec3::from_array(shot.focus) - Vec3::from_array(editor.focus),
    };
    Some((
        editor.node_id.clone(),
        editor.camera_id.clone(),
        aspect_ratio(&shot.aspect),
        pose,
        false,
    ))
}

/// 同步 adapter：按 `modelEditor.shot` 创建/更新/销毁 rig，并驱动 gizmo 选择与 preview 布局。
///
/// 只在 scene 变化帧调用；静止帧不重建 rig、不重算包围球。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_shot_adapter(
    commands: &mut Commands,
    state: &mut ShotAdapterState,
    selection: &mut ShotGizmoSelection,
    viewport: &mut ShotPreviewViewport,
    clear: &mut ShotPreviewClearColor,
    scene: &Scene,
    models: &ModelVisuals,
    resources: &ModelAssets,
    clear_color: Color,
) {
    let surface = surface_vec(scene);
    viewport.surface = surface;
    if let Some(surface_size) = &scene.surface {
        viewport.pixel_ratio = surface_size.pixel_ratio;
    }
    // 镜头背景（D6）：活动播放投影带具体色时用它清屏，否则用主题色。
    // 只作用于镜头预览/拍摄，编辑片场的工作区视图不受影响。
    clear.0 = scene
        .animation_playback
        .as_ref()
        .and_then(|playback| playback.backdrop.as_deref())
        .filter(|value| is_hex_color(value))
        .map(crate::model3d::scene::parse_hex)
        .unwrap_or(clear_color);

    let Some((node_id, camera_id, aspect, scene_pose, scene_units)) = desired_shot(scene) else {
        if let Some(rig) = state.rig.take() {
            commands.entity(rig).try_despawn();
        }
        state.camera_id = None;
        state.node_id = None;
        selection.entities.clear();
        return;
    };

    let bounds = focused_model_bounds(scene, models, resources);
    let _ = scene_units;
    let pose = scene_pose;

    let identity_changed = state.node_id.as_deref() != Some(node_id.as_str())
        || state.camera_id != camera_id
        || state.rig.is_none();
    let rig = if identity_changed {
        if let Some(previous) = state.rig.take() {
            commands.entity(previous).try_despawn();
        }
        state.node_id = Some(node_id);
        state.camera_id = camera_id;
        None
    } else {
        state.rig
    };

    let animation_preview = scene
        .animation_playback
        .as_ref()
        .is_some_and(|p| p.view_mode == "focus-preview");
    let lens = ShotCameraLens::from_aspect(aspect);
    // 窗口相机的矩形由 `sync_shot_main_view` 写成左下角预览框；这里的尺寸只参与预览预算。
    let preview = ShotCameraPreview::new(320, 180)
        .with_policy(crate::shot_camera::PreviewUpdatePolicy::Continuous)
        .with_target(PreviewTarget::Window);

    match rig {
        Some(rig) => {
            let mut entity = commands.entity(rig);
            entity.insert((
                pose,
                lens,
                preview,
                ShotCameraEditable {
                    enabled: !animation_preview,
                },
                ShotCameraViewMask(shot_view_layers()),
            ));
            entity.insert(target_for(bounds));
        }
        None => {
            let entity = commands.spawn_shot_camera(ShotCameraConfig {
                pose,
                lens,
                target: target_for(bounds),
                // 模型在层 0。gizmo 层只在实时主视图叠上，截图帧会去掉。
                view_mask: ShotCameraViewMask(shot_view_layers()),
                preview: Some(preview),
                editable: !animation_preview,
            });
            state.rig = Some(entity);
        }
    }

    if let Some(rig) = state.rig {
        selection.entities.clear();
        if !animation_preview {
            selection.entities.push(rig);
        }
    }
}

fn target_for(bounds: Option<ModelBounds>) -> ShotCameraTarget {
    let mut target = ShotCameraTarget::default();
    match bounds {
        Some(bounds) => target.set_center_radius(bounds.center, bounds.radius),
        None => target.bounds = Some(Aabb::new(Vec3::ZERO, Vec3::ZERO)),
    }
    target
}

/// `W:H` 画幅字面量 → 数值比例（宽 / 高）；非法或非受支持值回退 `16:9`。
///
/// 用字符串解析而不是穷举 `match`，新增画幅时无需改这里；受支持集合由
/// `protocol::is_supported_shot_aspect` 守卫。
pub(crate) fn aspect_ratio(aspect: &str) -> f32 {
    crate::protocol::parse_shot_aspect_ratio(aspect).unwrap_or(16.0 / 9.0)
}

/// `#rrggbb` 背景校验；非法值不参与清屏色覆盖（回落主题色）。
fn is_hex_color(value: &str) -> bool {
    value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desired_shot_preserves_focus_offset() {
        let mut scene = Scene::default();
        scene.model_editor = Some(
            serde_json::from_value(serde_json::json!({
                "version": "woohaa-model-editor-v2", "nodeId": "m1", "toolMode": "camera",
                "focus": [100.0, 200.0, 300.0], "radius": 20.0,
                "shot": {
                    "position": [0.0, 0.0, 0.0], "focus": [110.0, 195.0, 303.0],
                    "fov": 0.87, "azimuth": 0.0, "elevation": 0.785398,
                    "distance": 60.0, "aspect": "16:9"
                }
            }))
            .unwrap(),
        );
        let (_, _, _, pose, scene_units) = desired_shot(&scene).unwrap();
        assert_eq!(pose.focus_offset, Vec3::new(10.0, -5.0, 3.0));
        assert!(!scene_units);
    }

    #[test]
    fn sampled_pose_rejects_non_finite_inputs() {
        let camera = |distance: f32| crate::motion::CameraState {
            azimuth: 0.0,
            elevation: 0.4,
            distance,
            focus_offset: Vec3::ZERO,
        };
        let bounds = ModelBounds {
            center: Vec3::ZERO,
            radius: 5.0,
        };
        assert!(sampled_camera_pose(bounds, &camera(10.0)).is_some());
        assert!(sampled_camera_pose(bounds, &camera(f32::NAN)).is_none());
    }
}
