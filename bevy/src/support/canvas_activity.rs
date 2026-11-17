//! Native presentation may retain the canvas state while pausing its work.
use bevy::prelude::*;
#[derive(Resource, Default)]
pub struct CanvasWorkSuspended(pub bool);
pub fn running(state: Option<Res<CanvasWorkSuspended>>) -> bool {
    state.is_none_or(|s| !s.0)
}
