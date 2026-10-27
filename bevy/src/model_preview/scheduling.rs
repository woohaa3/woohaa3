//! View admission, readiness publication and bounded scheduling.
use super::*;

/// Reserve a slot for static work while interactive views are active. This
/// prevents continuous hover/playback from starving an older dirty card.
pub(super) fn schedule(
    commands: &mut Commands,
    state: &mut Previews,
    images: &mut Assets<Image>,
    ready: &Ready,
    cameras: &mut Query<&mut Camera>,
) {
    let mut ready = ready.0.lock().unwrap();
    // Render extraction can deliver readiness one frame after deletion. Keep
    // only current cameras, including inactive static views already settled.
    let alive: std::collections::HashSet<_> =
        state.cards.values().map(|card| card.camera).collect();
    ready.retain(|camera, _| alive.contains(camera) || cameras.get_mut(*camera).is_ok());
    let mut pending = Vec::new();
    for (id, card) in &mut state.cards {
        let rendered = ready.get(&card.camera).copied() == Some(card.generation);
        if rendered {
            state.latency.ready(id, card.generation);
        }
        if rendered && card.displayed != card.image {
            let old = std::mem::replace(&mut card.displayed, card.image.clone());
            images.remove(old.id());
            let image = card.displayed.clone();
            let sprite = card.sprite;
            commands.queue(move |world: &mut World| {
                if let Some(mut sprite) = world.get_mut::<Sprite>(sprite) {
                    sprite.image = image;
                }
            });
        }
        if card.visible && (!rendered || card.live) {
            // 长期没有模型根的卡片画不出内容；给它一个有界等待窗口后让出槽位，避免其它卡片
            // 被饿死。根出现会改变表示身份、推进代数，从而重新武装这张卡片。
            let starved_root = card
                .awaiting_root_since
                .is_some_and(|since| state.tick.saturating_sub(since) >= policy::AWAITING_ROOT_FRAMES);
            if !starved_root {
                pending.push((id.clone(), !card.live, card.waiting_since));
            }
        }
        if let Ok(mut camera) = cameras.get_mut(card.camera) {
            camera.is_active = false;
        } else {
            set_camera_active(commands, card.camera, false);
        }
    }
    let selected = policy::select_views(&pending, state.tick);
    let bytes = texture_bytes(state, images);
    let queued: std::collections::HashSet<_> = pending
        .iter()
        .map(|p| p.0.as_str())
        .chain(state.deferred.keys().map(String::as_str))
        .collect();
    crate::bridge::set_preview_diagnostics([
        selected.len() as u64,
        queued.len() as u64,
        bytes,
        state.cards.values().filter(|card| card.visible).count() as u64,
        state.cards.len() as u64,
        state
            .cards
            .values()
            .filter(|card| card.visible && card.live)
            .count() as u64,
        state.deferred.len() as u64,
        state
            .cards
            .values()
            .filter(|card| ready.get(&card.camera).copied() == Some(card.generation))
            .count() as u64,
    ]);
    if crate::runtime_health::benchmark_enabled() {
        crate::runtime_health::benchmark_models_ready(state.cards.iter()
            .filter(|(_, card)| card.visible && ready.get(&card.camera).copied() == Some(card.generation))
            .map(|(id, _)| id.clone()).collect());
    }
    if let Some(snapshot) = state.latency.snapshot_if_changed() {
        crate::bridge::set_preview_latency_diagnostics(snapshot);
    }
    for id in selected {
        state.latency.selected(&id);
        let entity = state.cards[id].camera;
        if let Ok(mut camera) = cameras.get_mut(entity) {
            camera.is_active = true;
        } else {
            set_camera_active(commands, entity, true);
        }
    }
}

fn set_camera_active(commands: &mut Commands, entity: Entity, active: bool) {
    commands.queue(move |world: &mut World| {
        if let Some(mut camera) = world.get_mut::<Camera>(entity) {
            camera.is_active = active;
        }
    });
}
