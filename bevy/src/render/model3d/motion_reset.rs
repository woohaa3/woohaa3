//! Seek 或循环回到动作开始前时恢复基础姿态，只处理动作引用的部件。
use super::runtime::ModelVisuals;
use crate::protocol::AnimationPlayback;
use bevy::prelude::*;

pub(super) fn reset_targets(
    commands: &mut Commands,
    models: &mut ModelVisuals,
    playback: &AnimationPlayback,
    targets: &std::sync::Arc<std::collections::HashSet<String>>,
) {
    let previous = models
        .motion_targets
        .replace((playback.node_id.clone(), targets.clone()));
    let removed = previous
        .as_ref()
        .filter(|(node_id, _)| node_id == &playback.node_id);
    let Some(root) = models.roots.get(&playback.node_id) else {
        return;
    };
    let removed = removed
        .into_iter()
        .flat_map(|(_, previous)| previous.difference(targets));
    for target in targets.iter().chain(removed) {
        let (Some(entity), Some(base)) =
            (root.part_entities.get(target), root.part_bases.get(target))
        else {
            continue;
        };
        if let Ok(mut entity_commands) = commands.get_entity(*entity) {
            entity_commands.insert(*base);
        }
    }
}
