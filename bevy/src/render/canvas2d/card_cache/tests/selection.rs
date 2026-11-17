//! Card 持久选中描边的 ECS 回归
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，任务 3.2）。
//!
//! 断言：非选中态不产生几何、resize 抓手只在可缩放节点出现，且 hover/drop-target
//! 不会伪造选中描边。
use super::*;
use crate::protocol::Scene;
use bevy::mesh::VertexAttributeValues;

fn nodes() -> Vec<crate::protocol::GraphNode> {
    serde_json::from_value(serde_json::json!([
        {"id":"card", "type":"text", "x":0, "y":0, "width":240, "height":180,
         "resizable":true, "title":"Card", "body":"body"},
        {"id":"plain", "type":"text", "x":300, "y":0, "width":240, "height":180,
         "title":"Plain", "body":"body"}
    ]))
    .unwrap()
}

fn selection_world() -> World {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0 = Scene {
        nodes: nodes(),
        ..default()
    };
    world
}

fn select(world: &mut World, ids: &[&str]) {
    world.resource_mut::<CurrentScene>().0.selection.nodes =
        ids.iter().map(|id| (*id).to_owned()).collect();
}

fn outline(world: &World) -> Vec<Vec2> {
    let Some(handle) = world.resource::<SelectionOutlineLayer>().mesh().cloned() else {
        return Vec::new();
    };
    let Some(mesh) = world.resource::<Assets<Mesh>>().get(&handle) else {
        return Vec::new();
    };
    match mesh.attribute(Mesh::ATTRIBUTE_POSITION) {
        Some(VertexAttributeValues::Float32x3(values)) => values
            .iter()
            // 空批次用远离画布的兜底三角形清空上一帧；它不是节点几何。
            .filter(|point| point[0] > -100_000.0)
            .map(|point| Vec2::new(point[0], -point[1]))
            .collect(),
        _ => Vec::new(),
    }
}

fn draw(world: &mut World, ids: &[&str]) -> Vec<Vec2> {
    select(world, ids);
    render(world);
    outline(world)
}

#[test]
fn unselected_nodes_contribute_nothing_and_hover_never_fakes_selection() {
    let mut world = selection_world();
    assert!(draw(&mut world, &[]).is_empty(), "无选中时批次为空");

    // hover / drop-target 是瞬时状态，不产生持久选中描边。
    world.resource_mut::<CurrentScene>().0.hover =
        Some(serde_json::from_value(serde_json::json!({"nodeId":"plain"})).unwrap());
    render(&mut world);
    assert!(
        outline(&world).is_empty(),
        "hover/drop-target 不得写入选区批次"
    );
}

#[test]
fn card_outline_is_present_and_resize_grip_depends_on_resizable() {
    let mut world = selection_world();
    let plain = draw(&mut world, &["plain"]);
    assert!(!plain.is_empty(), "普通卡片选中必须产生描边");
    let resizable = draw(&mut world, &["card"]);
    assert!(!resizable.is_empty());
    assert!(
        resizable.len() > plain.len(),
        "可缩放卡片多出 resize 抓手：{} vs {}",
        resizable.len(),
        plain.len()
    );
}
