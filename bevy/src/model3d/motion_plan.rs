//! One validated active-clip plan. Clock and owner updates do not reanalyse tracks.
use super::runtime::ModelVisuals;
use crate::{motion::MotionIr, protocol::AnimationPlayback};
use std::{collections::HashSet, sync::Arc};

pub(super) struct MotionPlan {
    input: AnimationPlayback,
    pub top: Option<MotionIr>,
    pub objects: Vec<Option<MotionIr>>,
    pub targets: Arc<HashSet<String>>,
    /// 是否含放大几何的 scale/关键帧缩放动作：规范 bounds 可能不再保守，总览 LOD 据此保守
    /// 提升（change: 2026-10-15-add-film-set-overview-lod，design D2/D5）。
    pub scales_bounds: bool,
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
            && old.objects == input.objects
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
    let objects: Vec<_> = input
        .objects
        .iter()
        .map(|object| {
            crate::motion::validate(
                &input.version,
                Vec::new(),
                object.model_motion.clone(),
                object.playback.duration,
            )
            .ok()
        })
        .collect();
    let mut targets = HashSet::new();
    if top.is_some() {
        targets.extend(
            input
                .model_motion
                .iter()
                .map(|track| track.target_id.clone()),
        );
    }
    for (object, valid) in input.objects.iter().zip(&objects) {
        if valid.is_none() {
            continue;
        }
        for track in &object.model_motion {
            // Object tracks must resolve through their own author-to-runtime scope.
            if let Some(id) = object.part_ids.get(&track.target_id) {
                targets.insert(id.clone());
            }
        }
    }
    // 是否含放大几何的 scale 动作：规范 bounds 可能不再保守，总览 LOD 据此保守提升
    // （change: 2026-10-15-add-film-set-overview-lod，design D2/D5）。只读已校验动作，不另跑求值。
    let scales_bounds = top
        .iter()
        .flat_map(|motion| &motion.model_motion)
        .chain(
            objects
                .iter()
                .flatten()
                .flat_map(|motion| &motion.model_motion),
        )
        .any(|track| track.motion.property() == crate::motion::OscillateMode::Scale);
    let plan = Arc::new(MotionPlan {
        input: input.clone(),
        top,
        objects,
        targets: Arc::new(targets),
        scales_bounds,
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
