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
    let (camera, deltas) =
        motion::evaluate(&ir, request.time_seconds, request.initial_camera.state());
    Some((camera, deltas))
}
