//! 第三方展示类型 fixture（change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，任务 3.3）。
//!
//! 这里完全在测试模块内定义一个新的 presentation component 与 producer system，只复用公共
//! `CanvasLayout` / `CanvasDepth` / `CanvasSelection` 和 `SelectionOutlineBatch` writer，
//! 不修改任何既有系统源码。目标是证明：新增展示类型不需要中心 enum、trait 或 `CanvasOverlayCache` 注册。
use super::*;
use crate::canvas_ecs::components::{CanvasDepth, CanvasLayout, CanvasSelection};
use crate::canvas_ecs::{CanvasBatchWriter, flush_selection_outlines};

/// 第三方展示能力：只携带自己的绘制参数。
#[derive(Component)]
struct ThirdPartyPresentation {
    inset: f32,
}

/// 第三方 producer：选中时向共享批次写一个菱形描边。
fn produce_third_party_outline(
    mut batch: ResMut<SelectionOutlineBatch>,
    nodes: Query<(
        &CanvasLayout,
        &CanvasDepth,
        &CanvasSelection,
        &ThirdPartyPresentation,
    )>,
) {
    let writer = batch.writer();
    for (layout, depth, selection, presentation) in &nodes {
        if !selection.selected {
            continue;
        }
        let center = layout.center();
        let half = Vec2::new(layout.width, layout.height) * 0.5;
        let inset = presentation.inset;
        let points = [
            center + Vec2::new(0.0, -half.y + inset),
            center + Vec2::new(half.x - inset, 0.0),
            center + Vec2::new(0.0, half.y - inset),
            center + Vec2::new(-half.x + inset, 0.0),
        ];
        writer.polygon(&points, depth.z + 0.01, 0xffff_ffff);
    }
}

fn outline_vertices(world: &World) -> usize {
    let Some(handle) = world.resource::<SelectionOutlineLayer>().mesh().cloned() else {
        return 0;
    };
    world
        .resource::<Assets<Mesh>>()
        .get(&handle)
        .and_then(|mesh| mesh.attribute(Mesh::ATTRIBUTE_POSITION))
        .map_or(0, |positions| match positions {
            // 空批次用远离画布的兜底三角形，不是第三方描边。
            bevy::mesh::VertexAttributeValues::Float32x3(values) => {
                values.iter().filter(|point| point[0] > -100_000.0).count()
            }
            _ => 0,
        })
}

#[test]
fn third_party_component_and_system_reuse_the_shared_batch() {
    let mut world = world();
    world.resource_mut::<CurrentScene>().0.nodes.truncate(1);
    render(&mut world);
    assert_eq!(outline_vertices(&world), 0, "未选中时批次应为空");

    let entity = node_entity(&mut world, "0").expect("projected node");
    world
        .entity_mut(entity)
        .insert(ThirdPartyPresentation { inset: 6.0 });
    world.get_mut::<CanvasSelection>(entity).unwrap().selected = true;

    world.run_system_once(begin_selection_outlines).unwrap();
    world.run_system_once(produce_third_party_outline).unwrap();
    world.run_system_once(flush_selection_outlines).unwrap();
    world.flush();
    let drawn = outline_vertices(&world);
    assert!(drawn > 0, "第三方 producer 必须写入共享批次");

    // 取消选中：同一批次在下一帧清空，不依赖第三方自己保存实体句柄。
    world.get_mut::<CanvasSelection>(entity).unwrap().selected = false;
    world.run_system_once(begin_selection_outlines).unwrap();
    world.run_system_once(produce_third_party_outline).unwrap();
    world.run_system_once(flush_selection_outlines).unwrap();
    world.flush();
    assert_eq!(outline_vertices(&world), 0, "未选中的第三方节点贡献空结果");
}
