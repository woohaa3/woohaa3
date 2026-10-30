use crate::{motion, renderer_protocol::MotionRequest};

pub(super) fn sample(
    request: &MotionRequest,
) -> Option<(motion::CameraState, Vec<(String, motion::ModelDelta)>)> {
    let ir = motion::validate(
        motion::MOTION_IR_VERSION,
        request.camera_motion.clone(),
        request.model_motion.clone(),
        request.duration,
    )
    .ok()?;
    let (camera, mut deltas) =
        motion::evaluate(&ir, request.time_seconds, request.initial_camera.state());
    for object in &request.objects {
        let Some(time) = object.local_time(request.time_seconds) else {
            continue;
        };
        let Ok(ir) = motion::validate(
            motion::MOTION_IR_VERSION,
            Vec::new(),
            object.model_motion.clone(),
            object.playback.duration,
        ) else {
            continue;
        };
        let (_, child) = motion::evaluate(&ir, time, request.initial_camera.state());
        deltas.extend(child.into_iter().map(|(target, delta)| {
            (
                object.part_ids.get(&target).cloned().unwrap_or(target),
                delta,
            )
        }));
    }
    Some((camera, deltas))
}
