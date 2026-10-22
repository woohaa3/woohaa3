//! 共享 mesh 的绘制顺序（change: fix-group-and-marquee-preview）。
//!
//! 共享 mesh 没有深度测试，三角形的覆盖顺序**就是**提交顺序；而文档顺序不保证父级先于
//! 子级——打组会把 group 追加到文档末尾。若按文档顺序画，group 的半透明底与选中态会盖在
//! 成员卡片之上，表现为「打完组/选中组后节点边界看不见」。这里把group 统一排到前面。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫）。

use crate::protocol::GraphNode;

/// 返回绘制顺序：group 容器先于普通卡片。
///
/// 组内/组间各自的相对顺序保持文档顺序不变。
pub(crate) fn group_first_order(nodes: &[GraphNode]) -> Vec<usize> {
    let (groups, cards): (Vec<usize>, Vec<usize>) =
        (0..nodes.len()).partition(|index| nodes[*index].group.is_some());
    groups.into_iter().chain(cards).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_node(id: &str, group: bool) -> GraphNode {
        GraphNode {
            model_preview: None,
            shot_preview: None,

            id: id.into(),
            kind: if group { "group".into() } else { "image".into() },
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
                title: String::new(),
                member_count: 1,
                output_capable_leaf_count: 0,
                run_status: None,
            }),
            model: None,
            composite_asset: None,
            history_strip: None,
            aggregate_run: None,
        }
    }

    /// 文档顺序把 group 放在成员之后（打组的真实顺序），绘制顺序必须把容器提前。
    #[test]
    fn container_drawn_before_its_members() {
        let nodes = vec![graph_node("a", false), graph_node("b", false), graph_node("g", true)];
        assert_eq!(group_first_order(&nodes), vec![2, 0, 1]);
    }

    /// 普通节点之间的相对顺序保持不变（后绘制的仍在后，覆盖语义不回归）。
    #[test]
    fn card_order_is_preserved() {
        let nodes = vec![graph_node("a", false), graph_node("b", false), graph_node("c", false)];
        assert_eq!(group_first_order(&nodes), vec![0, 1, 2]);
    }
}
