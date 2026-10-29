//! 任务 1.1 基线：固定夹具下的节点/实体/资产数量与几何 fingerprint。
//!
//! 这不是性能结论，而是「ECS 投影 + 分类型 producer」迁移前后的结构回归：相同输入的
//! 节点实体、标签实体、几何块、mesh/image 引用数量和顶点 fingerprint 必须稳定。
use super::*;
use crate::canvas2d::CanvasOverlayCache;

#[test]
fn render_baseline_counts_and_geometry_fingerprint_are_stable() {
    use bevy::asset::AssetId;
    use bevy::mesh::VertexAttributeValues;

    fn mix(mut hash: u64, value: u64) -> u64 {
        hash ^= value;
        hash.wrapping_mul(0x1000_0000_01b3)
    }

    fn mesh_hash(hash: u64, mesh: &Mesh) -> u64 {
        let mut hash = hash;
        for attribute in [Mesh::ATTRIBUTE_POSITION, Mesh::ATTRIBUTE_COLOR] {
            match mesh.attribute(attribute) {
                Some(VertexAttributeValues::Float32x3(values)) => {
                    for value in values {
                        for component in value {
                            hash = mix(hash, component.to_bits() as u64);
                        }
                    }
                }
                Some(VertexAttributeValues::Float32x4(values)) => {
                    for value in values {
                        for component in value {
                            hash = mix(hash, component.to_bits() as u64);
                        }
                    }
                }
                _ => {}
            }
        }
        hash
    }

    fn geometry_fingerprint(world: &mut World) -> u64 {
        let ids: Vec<AssetId<Mesh>> = {
            let visuals = world.resource::<CanvasOverlayCache>();
            let mut ids: Vec<AssetId<Mesh>> = Vec::new();
            for block in &world.resource::<crate::canvas2d::CardBlockCache>().blocks {
                ids.extend(block.mesh.as_ref().map(Handle::id));
            }
            ids.extend(
                world
                    .resource::<crate::canvas2d::CardDecorationCache>()
                    .blocks
                    .iter()
                    .filter_map(|block| block.handle()),
            );
            for block in &world
                .resource::<crate::canvas2d::ContainerBlockCache>()
                .blocks
            {
                ids.extend(block.state().into_iter().flatten());
            }
            ids.extend(
                world
                    .resource::<crate::canvas2d::EdgeBlockCache>()
                    .blocks
                    .iter()
                    .map(|block| block.state().0),
            );
            ids
        };
        let mut ids = ids;
        ids.sort_by_key(|id| format!("{id:?}"));
        let assets = world.resource::<Assets<Mesh>>();
        ids.into_iter().fold(0xcbf2_9ce4_8422_2325, |hash, id| {
            assets.get(id).map_or(hash, |mesh| mesh_hash(hash, mesh))
        })
    }

    type Counts = (
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
        usize,
    );

    fn counts(world: &mut World) -> Counts {
        let nodes = world.query::<&CanvasNodeId>().iter(world).count();
        let labels = world.query::<&CanvasLabel>().iter(world).count();
        let visuals = world.resource::<CanvasOverlayCache>();
        (
            nodes,
            labels,
            world
                .resource::<crate::canvas2d::CardBlockCache>()
                .blocks
                .len(),
            world
                .resource::<crate::canvas2d::CardBlockCache>()
                .blocks
                .iter()
                .filter(|block| block.entity.is_some())
                .count(),
            world
                .resource::<crate::canvas2d::CardDecorationCache>()
                .blocks
                .iter()
                .filter(|block| block.handle().is_some())
                .count(),
            world
                .resource::<crate::canvas2d::ContainerBlockCache>()
                .blocks
                .len(),
            world
                .resource::<crate::canvas2d::EdgeBlockCache>()
                .blocks
                .len(),
            world.resource::<Assets<Mesh>>().len(),
            world.resource::<Assets<Image>>().len(),
        )
    }

    let mut world = world();
    render(&mut world);
    let baseline_counts = counts(&mut world);
    let baseline_fingerprint = geometry_fingerprint(&mut world);

    // 任务 1.1 记录的基线（33 张 text 卡片夹具）：
    //   节点实体 33、标签实体 231、卡片块 3、容器块 3、mesh 资产 6、image 资产 0。
    // fingerprint 覆盖所有块引用的顶点位置与颜色。
    assert_eq!(
        baseline_counts,
        (33, 231, 3, 3, 0, 3, 0, 6, 0),
        "投影/producer 的实体与资产基线漂移"
    );
    assert_eq!(
        baseline_fingerprint, 0x36fb_0735_14bf_2f89,
        "卡片/容器几何指纹不得漂移"
    );

    // 相同 accepted snapshot：投影与 producer 不得新增实体、资产或改写几何。
    assert_eq!(render(&mut world), 0);
    assert_eq!(
        counts(&mut world),
        baseline_counts,
        "重复帧必须复用实体/资产"
    );
    assert_eq!(
        geometry_fingerprint(&mut world),
        baseline_fingerprint,
        "重复帧不得改写几何"
    );

    // 布局变化只改受影响的块：fingerprint 必须变化，节点/标签实体数不变。
    world.resource_mut::<CurrentScene>().0.nodes[17].x += 25.0;
    assert_eq!(render(&mut world), 1);
    assert_ne!(geometry_fingerprint(&mut world), baseline_fingerprint);
    assert_eq!(
        world.query::<&CanvasNodeId>().iter(&world).count(),
        baseline_counts.0
    );
    assert_eq!(
        world.query::<&CanvasLabel>().iter(&world).count(),
        baseline_counts.1
    );

    world.resource_mut::<CurrentScene>().0.nodes.clear();
    render(&mut world);
    assert_eq!(
        world.query::<&CanvasNodeId>().iter(&world).count(),
        0,
        "清空场景后投影实体必须全部回收"
    );
    assert_eq!(
        world.query::<&CanvasLabel>().iter(&world).count(),
        0,
        "清空场景后标签实体必须全部回收"
    );
    assert!(
        world
            .resource::<crate::canvas2d::CardBlockCache>()
            .blocks
            .is_empty()
    );
    eprintln!("baseline counts: {baseline_counts:?}, fingerprint: {baseline_fingerprint:#x}");
}
