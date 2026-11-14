//! Apply canonical motion tracks to independent runtime parts and restore base poses.
use std::collections::HashMap;

use super::ModelVisuals;
use crate::protocol::Scene;
use bevy::prelude::*;

use super::super::opacity::DesiredOpacity;

/// 活动动画节点的运动求值：为该节点独立求值模型部件姿态与镜头姿态
/// （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1；
///  change: 2026-10-19-extend-film-set-for-motion-graphics 增加透明度动作）。
///
/// 只影响 `animation_playback.node_id` 指向的模型根：其它节点保持各自姿态与时钟。运动求值
/// 是纯函数（`crate::motion`），不依赖 watch/每帧重跑 JavaScript。节点切换或投影清除时，
/// 上一节点恢复基础姿态与材质。返回解析出的镜头姿态（供 shot adapter 使用）。
fn apply_clip_playback(
    commands: &mut Commands,
    models: &mut ModelVisuals,
    materials: &mut Assets<StandardMaterial>,
    opacity: &HashMap<Entity, crate::canvas_ecs::components::OpacityMaterialInstance>,
    scene: &Scene,
) -> Option<crate::motion::CameraState> {
    // Restore only the previous clip's actual targets, once, when its owner leaves.
    let leaving = models
        .motion_targets
        .as_ref()
        .filter(|(previous, _)| {
            scene
                .animation_playback
                .as_ref()
                .is_none_or(|p| p.node_id != *previous)
        })
        .map(|(previous, _)| previous.clone());
    if let Some(previous) = leaving {
        reset_motion_parts(commands, models, &previous, opacity);
    }
    let Some(playback) = scene.animation_playback.as_ref() else {
        models.motion_targets = None;
        super::super::pick::publish_motion(None, HashMap::new());
        return None;
    };
    let plan = super::super::motion_plan::resolve(models, playback);
    super::super::motion_reset::reset_targets(commands, models, playback, &plan.targets);
    let mut desired: DesiredOpacity = HashMap::new();

    let Some(motion) = &plan.top else {
        super::super::pick::publish_motion(None, HashMap::new());
        if let Some(root) = models.roots.get_mut(&playback.node_id) {
            root.opacity.sync_frame(materials, commands, opacity, &desired);
        }
        return None;
    };
    let initial = playback.initial_camera_state();
    let (camera, model_deltas) = crate::motion::evaluate(&motion, playback.time, initial);
    super::super::pick::publish_motion(Some(&playback.node_id), model_deltas.iter().cloned().collect());

    if let Some(root) = models.roots.get_mut(&playback.node_id) {
        for (part_id, delta) in &model_deltas {
            let Some(entity) = root.part_entities.get(part_id).copied() else {
                continue;
            };
            let Some(base) = root.part_bases.get(part_id).copied() else {
                continue;
            };
            let transform = compose_delta(base, delta);
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(transform);
            }
            queue_opacity(root, part_id, delta.opacity, &mut desired);
        }
        root.opacity.sync_frame(materials, commands, opacity, &desired);
    }
    Some(camera)
}

/// 记录一个动作目标的透明度；同一实体被多条轨道命中时相乘。
fn queue_opacity(
    root: &super::ModelRoot,
    target_id: &str,
    opacity: f32,
    desired: &mut DesiredOpacity,
) {
    if !(opacity.is_finite()) || opacity >= 1.0 {
        return;
    }
    let opacity = opacity.max(0.0);
    let (Some(entity), Some(material)) = (
        root.part_entities.get(target_id).copied(),
        root.part_materials.get(target_id).cloned(),
    ) else {
        return;
    };
    merge_desired(desired, entity, material, opacity);
}

fn merge_desired(
    desired: &mut DesiredOpacity,
    entity: Entity,
    material: Handle<StandardMaterial>,
    opacity: f32,
) {
    let entry = desired.entry(entity).or_insert((material, 1.0));
    entry.1 = (entry.1 * opacity).clamp(0.0, 1.0);
}

/// 只恢复上一会话实际引用的部件（离开活动动画节点时）。
fn reset_motion_parts(
    commands: &mut Commands,
    models: &mut ModelVisuals,
    node_id: &str,
    opacity: &HashMap<Entity, crate::canvas_ecs::components::OpacityMaterialInstance>,
) {
    let Some(root) = models.roots.get_mut(node_id) else {
        return;
    };
    // 透明度实例必须随姿态一起恢复，否则离开动画节点后画面会保持半透明。
    root.opacity.restore_all(commands, opacity);
    let Some((id, targets)) = &models.motion_targets else { return; };
    if id != node_id { return; }
    for part_id in targets.iter() {
        let Some(entity) = root.part_entities.get(part_id) else {
            continue;
        };
        let Some(base) = root.part_bases.get(part_id).copied() else {
            continue;
        };
        if let Ok(mut entity_commands) = commands.get_entity(*entity) {
            entity_commands.insert(base);
        }
    }
}

/// 增量合成：旋转乘在基础旋转之后；平移与缩放叠加（与 `motion::ModelDelta` 语义一致）。
pub(crate) fn compose_delta(base: Transform, delta: &crate::motion::ModelDelta) -> Transform {
    Transform {
        translation: base.translation + delta.translation,
        rotation: base.rotation * delta.rotation,
        scale: base.scale * delta.scale,
    }
}

/// Apply joint samples after the existing clip, composing from rest every frame.
pub(crate) fn apply_motion_playback(
    commands: &mut Commands,
    models: &mut ModelVisuals,
    materials: &mut Assets<StandardMaterial>,
    opacity: &HashMap<Entity, crate::canvas_ecs::components::OpacityMaterialInstance>,
    scene: &Scene,
) -> Option<crate::motion::CameraState> {
    let camera = apply_clip_playback(commands, models, materials, opacity, scene);
    let current: HashMap<_, _> = scene.nodes.iter().filter_map(|node| {
        let model = node.model.as_ref()?;
        if model.part_rotations.is_none() && model.part_positions.is_none() { return None; }
        Some((node.id.as_str(), (model.part_rotations.as_ref(), model.part_positions.as_ref())))
    }).collect();
    if models.joint_targets.is_empty() && current.values().all(|(r,p)| r.is_none_or(|v| v.is_empty()) && p.is_none_or(|v| v.is_empty())) {
        return camera;
    }
    let previous = std::mem::take(&mut models.joint_targets);
    let active: std::collections::HashSet<&str> = previous.keys().map(String::as_str)
        .chain(current.keys().copied()).collect();
    let mut clip = HashMap::new();
    if let Some(playback) = &scene.animation_playback {
        let plan = super::super::motion_plan::resolve(models, playback);
        if let Some(top) = &plan.top {
            clip = crate::motion::evaluate(top, playback.time, playback.initial_camera_state())
                .1.into_iter().collect();
        }
    }
    for node_id in active {
        let Some(root) = models.roots.get(node_id) else { continue };
        let (rotations, positions) = current.get(node_id).copied().unwrap_or((None, None));
        let targets: std::collections::HashSet<String> = rotations
            .map(|r| r.keys().cloned().collect()).unwrap_or_default();
        let mut targets = targets;
        if let Some(positions) = positions { targets.extend(positions.keys().cloned()); }
        let mut affected = previous.get(node_id).cloned().unwrap_or_default();
        affected.extend(targets.iter().cloned());
        for id in affected {
            let (Some(entity), Some(base)) = (
                root.part_entities.get(&id), root.part_bases.get(&id),
            ) else { continue };
            let mut pose = *base;
            if scene.animation_playback.as_ref().is_some_and(|p| p.node_id == node_id) {
                if let Some(delta) = clip.get(&id) {
                    pose = compose_delta(pose, delta);
                }
            }
            if let Some(q) = rotations.and_then(|r| r.get(&id)) {
                pose.rotation *= Quat::from_array(*q);
            }
            if let Some(p) = positions.and_then(|p| p.get(&id)) { pose.translation += Vec3::from_array(*p); }
            if let Ok(mut entity) = commands.get_entity(*entity) {
                entity.insert(pose);
            }
        }
        if !targets.is_empty() {
            models.joint_targets.insert(node_id.to_owned(), targets);
        }
    }
    camera
}
