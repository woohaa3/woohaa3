//! One validated active-clip plan. Clock and owner updates do not reanalyse tracks.
use super::runtime::ModelVisuals;
use crate::{motion::MotionIr, protocol::AnimationPlayback};
use std::{collections::HashSet, sync::Arc};

pub(super) struct MotionPlan {
    input: AnimationPlayback,
    pub top: Option<MotionIr>,
    pub targets: Arc<HashSet<String>>,
}
impl MotionPlan {
    fn matches(&self, input: &AnimationPlayback) -> bool {
        let old = &self.input;
        old.node_id == input.node_id
            && old.source_identity == input.source_identity
            && old.clip_id == input.clip_id
            && old.version == input.version
            && old.duration == input.duration
            && old.model_motion == input.model_motion
            && old.camera_motion == input.camera_motion
    }
}
pub(super) fn resolve(models: &mut ModelVisuals, input: &AnimationPlayback) -> Arc<MotionPlan> {
    if let Some(plan) = &models.motion_plan
        && plan.matches(input)
    {
        return plan.clone();
    }
    let started = bevy::platform::time::Instant::now();
    let top = crate::motion::validate(
        &input.version,
        input.camera_motion.clone(),
        input.model_motion.clone(),
        input.duration,
    )
    .ok();
    let mut targets = HashSet::new();
    if top.is_some() {
        targets.extend(
            input
                .model_motion
                .iter()
                .map(|track| track.target_id.clone()),
        );
    }
    let plan = Arc::new(MotionPlan {
        input: input.clone(),
        top,
        targets: Arc::new(targets),
    });
    let root = models.roots.get(&input.node_id);
    let merged = plan
        .targets
        .iter()
        .filter(|id| root.is_some_and(|root| root.part_batches.contains_key(*id)))
        .count();
    let missing: Vec<_> = plan
        .targets
        .iter()
        .filter(|id| {
            root.is_some_and(|root| {
                !root.part_batches.contains_key(*id) && !root.part_entities.contains_key(*id)
            })
        })
        .collect();
    models.record_playback(serde_json::json!({"event":"target-analysis", "nodeId":input.node_id,
        "clipId":input.clip_id, "generation":input.generation, "cpuMs":started.elapsed().as_secs_f64() * 1000.0, "targets":plan.targets.len(), "mergedTargets":merged, "unresolvedTargets":missing,
        "classification": if plan.targets.is_empty() { "camera-only" } else if merged == 0 { "independent-or-group" } else { "merged-local" }}));
    models.motion_plan = Some(plan.clone());
    plan
}
impl ModelVisuals {
    pub(super) fn record_playback(&mut self, mut event: serde_json::Value) {
        event["atMonotonicMs"] = serde_json::json!(elapsed_ms());
        if self.playback_events.len() == 64 {
            self.playback_events.pop_front();
        }
        bevy::log::info!("[shot-startup] rust {}", event);
        self.playback_events.push_back(event);
    }
}

pub(super) fn elapsed_ms() -> f64 {
    static START: std::sync::OnceLock<bevy::platform::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(bevy::platform::time::Instant::now)
        .elapsed()
        .as_secs_f64()
        * 1000.0
}
