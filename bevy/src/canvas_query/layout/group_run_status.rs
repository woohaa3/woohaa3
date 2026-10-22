use crate::protocol::GraphNode;

/// Shared by drawing and hit testing; fixed to the group's top-right header in world space.
pub(crate) fn group_run_status_rect(node: &GraphNode) -> Option<(f32, f32, f32, f32)> {
    let status = node.group.as_ref()?.run_status.as_ref()?;
    let width = (super::estimated_text_width(&status.label, 12.) + 36.)
        .clamp(96., 160.).min((node.width - 24.).max(0.));
    if width < 48. { return None; }
    Some((node.x + node.width - width - 10., node.y + 4., width, 24.))
}
