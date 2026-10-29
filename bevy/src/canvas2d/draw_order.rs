//! 共享 mesh 的绘制顺序（change: fix-group-and-marquee-preview；
//! change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D2）。
//!
//! 共享 mesh 没有深度测试，三角形的覆盖顺序**就是**提交顺序。Web 投影已把节点排成
//! 「未归属层 → 每个容器及其成员闭包」的发射序列：容器先于自己的成员，成员之上再叠后一个
//! 容器。本模块不再假设文档顺序或 group/card 两段分区，只保留两条稳定规则：
//!
//! 1. 非 ghost 节点按发射顺序递增；
//! 2. ghost 虽在投影末尾追加，仍固定在最低层（相对顺序不变），不因后加而盖住组面板。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫）。

use crate::protocol::GraphNode;

/// Return the derived render slot used by every 2D node primitive.
///
/// The Web projection owns the container/member order. Ghost nodes are appended
/// after that sequence, however, and must still remain in the lowest layer.
/// Keeping this policy in one helper prevents a late ghost (or a malformed frame
/// with mixed roots) from receiving a higher z than a group panel.
pub(crate) fn render_index(nodes: &[GraphNode], index: usize) -> usize {
    if index >= nodes.len() {
        return index;
    }
    if nodes[index].ghost {
        return nodes[..=index].iter().filter(|node| node.ghost).count() - 1;
    }
    let ghost_count = nodes.iter().filter(|node| node.ghost).count();
    ghost_count + nodes[..index].iter().filter(|node| !node.ghost).count()
}

/// Convert a derived slot to the actual canvas world z.
///
/// Bevy's `OrthographicProjection::default_2d` swaps near/far (`proj::orthographic(.., far, near)`),
/// so a **larger** world z maps to a **larger** depth value, and the 2D pipelines test depth with
/// `CompareFunction::GreaterEqual` against a depth buffer cleared to `0.0`. Larger z therefore
/// renders in front. This matches the rest of the canvas (cards `10.0 + i * 0.1`, overlays
/// `+1.5`, marquee `500`). Because the projection emits ungrouped roots first and each group
/// before its members, a group panel always lands above ungrouped cards and below its own members.
pub(crate) fn render_z(nodes: &[GraphNode], index: usize) -> f32 {
    10.0 + render_index(nodes, index) as f32 * 0.1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_node(id: &str, group: bool) -> GraphNode {
        GraphNode {
            model_preview: None,
            shot_preview: None,

            id: id.into(),
            kind: if group {
                "group".into()
            } else {
                "image".into()
            },
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            group: group.then(|| crate::protocol::GroupPresentation {
                collapsed: false,
                badge_scale: 1.,
                badge_resizable: false,
                action_bar: false,
                title: String::new(),
                member_count: 1,
                output_capable_leaf_count: 0,
                model_bounds: None,
                run_status: None,
                geometry_quality: None,
                drop_target: false,
            }),
            model: None,
            composite_asset: None,
            history_strip: None,
            aggregate_run: None,
        }
    }

    fn slots(nodes: &[GraphNode]) -> Vec<usize> {
        (0..nodes.len())
            .map(|index| render_index(nodes, index))
            .collect()
    }

    /// 投影已保证「未归属根 → 容器 → 成员」；帮助器不得再按 group 分区重排。
    #[test]
    fn emission_order_is_the_render_order() {
        let nodes = vec![
            graph_node("root", false),
            graph_node("g", true),
            graph_node("member", false),
            graph_node("h", true),
            graph_node("member2", false),
        ];
        assert_eq!(slots(&nodes), vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn late_ghost_stays_below_group_phase() {
        let mut ghost = graph_node("ghost", false);
        ghost.ghost = true;
        let nodes = vec![
            graph_node("root", false),
            graph_node("g", true),
            graph_node("member", false),
            ghost,
        ];
        assert_eq!(slots(&nodes), vec![1, 2, 3, 0]);
    }

    #[test]
    fn no_group_keeps_emission_order() {
        let nodes = vec![
            graph_node("a", false),
            graph_node("b", false),
            graph_node("c", false),
        ];
        assert_eq!(slots(&nodes), vec![0, 1, 2]);
    }

    /// Bevy 的 2D 深度方向：`OrthographicProjection::default_2d` 交换 near/far，
    /// 管线以 `GreaterEqual` 对比清空为 0.0 的深度缓冲，因此**更大的 world z 更靠前**。
    ///
    /// 该断言锁定 `render_z` 的单调方向：slot 越大 z 越大。若有人再次把它改成
    /// `10.0 - slot * 0.1`，组面板会掉到无组节点之后，重现「背板盖不住底部节点」。
    #[test]
    fn later_slots_render_in_front() {
        let mut ghost = graph_node("ghost", false);
        ghost.ghost = true;
        let nodes = vec![
            graph_node("root", false),
            graph_node("g", true),
            graph_node("member", false),
            ghost,
        ];
        let root_z = render_z(&nodes, 0);
        let group_z = render_z(&nodes, 1);
        let member_z = render_z(&nodes, 2);
        let ghost_z = render_z(&nodes, 3);
        // 无组（含末尾幽灵）在最低层，组面板高于它，组成员高于自己的面板。
        assert!(
            root_z < group_z,
            "ungrouped root must render behind the group panel"
        );
        assert!(
            ghost_z < group_z,
            "late ghost must still render behind the group panel"
        );
        assert!(
            member_z > group_z,
            "group member must render in front of its panel"
        );
        // 与既有卡片公式同一量纲，避免组面板越过操作条/框选等覆盖层。
        assert!(root_z >= 10.0 && ghost_z >= 10.0);
        assert!(render_z(&nodes, 2) < 10.0 + nodes.len() as f32 * 0.1 + 1.5);
    }
}
