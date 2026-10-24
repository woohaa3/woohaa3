//! One layout for container text and thumbnail sprites; positions are canvas world coordinates.
use crate::protocol::GraphNode;
use bevy::prelude::*;
#[derive(Debug)]
pub(crate) struct PanelLayout {
    pub(crate) bounds: [f32; 4],
    pub(crate) title: Vec2,
    pub(crate) message: Vec2,
    pub(crate) hint: Vec2,
    pub(crate) images: Vec<[f32; 4]>,
}
pub(crate) fn layout(node: &GraphNode, count: usize) -> PanelLayout {
    let b = super::scope::node_scope(node).aabb;
    let count = count.min(8);
    let columns = count.clamp(1, 4);
    let rows = count.div_ceil(columns).max(1);
    let gap = 8.;
    let width = ((b.width - 28. - gap * (columns - 1) as f32) / columns as f32).max(1.);
    let height = ((b.height - 88. - gap * (rows - 1) as f32) / rows as f32).max(1.);
    PanelLayout {
        bounds: [b.x, b.y, b.width, b.height],
        title: Vec2::new(b.x + b.width / 2., b.y + 24.),
        message: Vec2::new(b.x + b.width / 2., b.y + b.height / 2.),
        hint: Vec2::new(b.x + b.width / 2., b.y + b.height - 22.),
        images: (0..count)
            .map(|index| {
                [
                    b.x + 14. + (index % columns) as f32 * (width + gap),
                    b.y + 48. + (index / columns) as f32 * (height + gap),
                    width,
                    height,
                ]
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composite_panel_thumbnails_follow_the_same_world_scope_as_picking() {
        let node: GraphNode = serde_json::from_value(
            serde_json::json!({"id":"reference","type":"model","x":100,"y":200,
            "compositeAsset":{"x":110,"y":220,"width":280,"height":210,"scopeShape":"rect"}}),
        )
        .unwrap();
        let panel = layout(&node, 8);
        assert_eq!(panel.bounds, [110., 220., 280., 210.]);
        assert_eq!(panel.images.len(), 8);
        for [x, y, w, h] in &panel.images {
            assert!(*x >= 124. && x + w <= 376.);
            assert!(*y >= 268. && y + h <= 390.);
        }
        assert_eq!(layout(&node, 0).images.len(), 0);
    }
}
