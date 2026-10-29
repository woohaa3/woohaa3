//! Apply canonical motion tracks to independent runtime parts and restore base poses.
use std::collections::HashMap;

use super::ModelVisuals;
use crate::protocol::Scene;
use bevy::prelude::*;

use super::super::opacity::DesiredOpacity;

/// 活动动画节点的运动求值：为该节点独立求值模型部件姿态与镜头姿态
/// （change: 2026-10-05-bind-model-animation-to-shots，任务 4.1；
///  change: 2026-10-09-add-film-set-object-motion-and-editing 增加片场对象 child 运动；
///  change: 2026-10-19-extend-film-set-for-motion-graphics 增加透明度动作）。
///
/// 只影响 `animation_playback.node_id` 指向的模型根：其它节点保持各自姿态与时钟。运动求值
/// 是纯函数（`crate::motion`），不依赖 watch/每帧重跑 JavaScript。节点切换或投影清除时，
/// 上一节点恢复基础姿态与材质。返回解析出的镜头姿态（供 shot adapter 使用）。
pub(crate) fn apply_motion_playback(
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
        return None;
    };
    let plan = super::super::motion_plan::resolve(models, playback);
    super::super::motion_reset::reset_targets(commands, models, playback, &plan.targets);
    let mut desired: DesiredOpacity = HashMap::new();
    apply_film_set_object_motion(commands, models, playback, &plan, &mut desired);

    let Some(motion) = &plan.top else {
        if let Some(root) = models.roots.get_mut(&playback.node_id) {
            root.opacity.sync_frame(materials, commands, opacity, &desired);
        }
        return None;
    };
    let initial = playback.initial_camera_state();
    let (camera, model_deltas) = crate::motion::evaluate(&motion, playback.time, initial);

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

/// 片场对象 child 运动的求值与应用（change: 2026-10-09-add-film-set-object-motion-and-editing）。
///
/// 每个对象独立映射局部时间，把对象动作轨道目标解析为组合作用域 partId，叠加到对应部件
/// 的基础姿态。目标缺失/越权只跳过该对象，其他对象继续。对象根 group 的变换由组合 IR 承载，
/// 根动作直接叠加到对象根 entity。
fn apply_film_set_object_motion(
    commands: &mut Commands,
    models: &mut ModelVisuals,
    playback: &crate::protocol::AnimationPlayback,
    plan: &super::super::motion_plan::MotionPlan,
    desired: &mut DesiredOpacity,
) {
    if playback.managed_item_motion.is_empty() {
        return;
    }
    let Some(root) = models.roots.get_mut(&playback.node_id) else {
        return;
    };
    for (object, motion) in playback.managed_item_motion.iter().zip(&plan.objects) {
        let Some(local_time) = object.local_time(playback.time) else {
            continue;
        };
        let Some(motion) = motion else {
            continue;
        };
        let (_camera, deltas) =
            crate::motion::evaluate(&motion, local_time, playback.initial_camera_state());
        for (target, delta) in &deltas {
            let Some(runtime_id) = object.part_ids.get(target) else {
                continue;
            };
            let Some(entity) = root.part_entities.get(runtime_id).copied() else {
                continue;
            };
            let Some(base) = root.part_bases.get(runtime_id).copied() else {
                continue;
            };
            let transform = compose_delta(base, delta);
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(transform);
            }
            queue_opacity(root, runtime_id, delta.opacity, desired);
        }
    }
}

/// 记录一个动作目标的透明度。
///
/// - 普通部件：只作用于该部件实体；
/// - 对象根（`itemId` + 空 partId）：作用于该对象名下的**全部块**，不拆块、不改 mesh 与
///   合批计划（D2）。同一实体被多条轨道命中时相乘。
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
    let is_object_root = super::super::part_id::decode_part_id(target_id)
        .is_some_and(|decoded| decoded.part_id.is_empty());
    if is_object_root {
        let item_id =
            super::super::part_id::decode_part_id(target_id).map(|decoded| decoded.item_id);
        for (part_id, material) in &root.part_materials {
            if !item_id.is_some_and(|item| super::super::part_id::belongs_to_item(part_id, item)) {
                continue;
            }
            let Some(entity) = root.part_entities.get(part_id).copied() else {
                continue;
            };
            merge_desired(desired, entity, material.clone(), opacity);
        }
        return;
    }
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
