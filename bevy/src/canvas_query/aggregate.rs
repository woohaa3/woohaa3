//! 聚合选区几何：绘制与 interaction snapshot 共用同一事实源。
use crate::protocol::GraphNode;

/// 聚合把手圆钮半径，必须与 contracts 的 `AGGREGATE_HANDLE_RADIUS` 一致
/// （change: add-multi-select-aggregate-connect；由 `render-scene.test.ts` 断言两边相同）。
pub(crate) const AGGREGATE_HANDLE_RADIUS: f32 = 8.0;
/// 把手相对选区边缘的外移间隙，必须与 contracts 的 `AGGREGATE_HANDLE_GAP` 一致。
pub(crate) const AGGREGATE_HANDLE_GAP: f32 = 18.0;

/// 选中节点的轴对齐包围盒（世界坐标）；空集合返回 `None`。
pub(crate) fn selection_bounds(nodes: &[GraphNode], selected: &[String]) -> Option<[f32; 4]> {
    selection_bounds_iter(nodes.iter(), selected)
}

/// 同一包围盒派生，供只持有 ECS 布局组件的生产者使用（不遍历协议快照）。
pub(crate) fn selection_bounds_iter<'a>(
    nodes: impl IntoIterator<Item = &'a GraphNode>,
    selected: &[String],
) -> Option<[f32; 4]> {
    selection_bounds_rects(
        nodes
            .into_iter()
            .map(|node| (node.id.as_str(), [node.x, node.y, node.width, node.height])),
        selected,
    )
}

/// 同一包围盒派生，输入为 `(nodeId, [x, y, width, height])`。
pub(crate) fn selection_bounds_rects<'a>(
    nodes: impl IntoIterator<Item = (&'a str, [f32; 4])>,
    selected: &[String],
) -> Option<[f32; 4]> {
    let ids: std::collections::HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    let mut found = false;
    for (id, [x, y, width, height]) in nodes {
        if !ids.contains(id) {
            continue;
        }
        found = true;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + width);
        max_y = max_y.max(y + height);
    }
    found.then_some([min_x, min_y, max_x - min_x, max_y - min_y])
}

/// 聚合把手中心（世界坐标）：`[x, y, width, height]` 包围盒 → 左/右中，各外移固定间隙。
pub(crate) fn aggregate_handle(bounds: [f32; 4], output: bool) -> (f32, f32) {
    let [x, y, width, height] = bounds;
    let center_y = y + height / 2.0;
    let center_x = if output {
        x + width + AGGREGATE_HANDLE_GAP
    } else {
        x - AGGREGATE_HANDLE_GAP
    };
    (center_x, center_y)
}
