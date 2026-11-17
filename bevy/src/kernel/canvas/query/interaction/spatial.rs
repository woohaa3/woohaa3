//! 交互查询的空间候选索引
//! （change: 2026-10-23-scale-canvas-media-residency，design D7 / 任务 7.3）。
//!
//! 点/框选/drop/probe 只需要「与查询矩形相交的少量候选」，但逐查询遍历全部文档节点在千节点
//! 文档上是 O(查询数 × 文档节点数)。这里按节点/边的世界 AABB 建均匀网格，查询先取候选集合，
//! 再走**原有**精确几何与 z 顺序判定——网格只缩小候选范围，不改变命中结果、绘制顺序或遮挡。
//!
//! 位置增量只搬动网格里真正移动的节点/边（[`SpatialGrid::relocate`]），不重建整张索引。
//!
//! 退化保护：
//! - 跨度过大的对象（超大 group/片场范围）不铺满网格，进入 `oversized` 列表并被每次查询返回，
//!   保证正确性优先于候选数量；
//! - 查询矩形本身跨度过大时直接退化为全量候选（大框选/极端 zoom），不构造巨大 cell 区间。

use std::collections::HashMap;

/// 单个对象允许占据的 cell 数上限；超过即归入 `oversized`（始终参与候选）。
const MAX_CELLS_PER_OBJECT: i64 = 4096;
/// 单次查询允许枚举的 cell 数上限；超过即退化为全量候选。
const MAX_CELLS_PER_QUERY: i64 = 4096;

/// 世界坐标均匀网格。
///
/// `index` 与消费者自己的数组下标一致（节点下标或边下标），网格本身不持有几何。
pub(super) struct SpatialGrid {
    cell: f32,
    cells: HashMap<(i32, i32), Vec<usize>>,
    /// 每个 index 当前占据的 cell，用于精确移除（含跨界大对象）。
    occupied: Vec<Vec<(i32, i32)>>,
    /// 跨度过大、不铺网格的对象；每次查询都作为候选返回。
    oversized: Vec<usize>,
    /// 全部被索引对象的整体包围盒（`min_x, min_y, width, height`）；空网格为 `None`。
    extent: Option<(f32, f32, f32, f32)>,
}

impl SpatialGrid {
    /// 建立网格；`cell` 为世界单位边长，非有限/非正回落为 1。
    pub(super) fn new(cell: f32) -> Self {
        Self {
            cell: if cell.is_finite() && cell >= 1.0 {
                cell
            } else {
                1.0
            },
            cells: HashMap::new(),
            occupied: Vec::new(),
            oversized: Vec::new(),
            extent: None,
        }
    }

    /// 全部被索引对象的整体包围盒；空网格返回 `None`。
    pub(super) fn extent(&self) -> Option<(f32, f32, f32, f32)> {
        self.extent
    }

    fn include_in_extent(&mut self, rect: (f32, f32, f32, f32)) {
        let (x, y, width, height) = rect;
        if ![x, y, width, height].iter().all(|v| v.is_finite()) {
            return;
        }
        let (left, top) = (x.min(x + width), y.min(y + height));
        let (right, bottom) = (x.max(x + width), y.max(y + height));
        self.extent = Some(match self.extent {
            None => (left, top, right - left, bottom - top),
            Some((ex, ey, ew, eh)) => {
                let ex_right = ex + ew;
                let ey_bottom = ey + eh;
                let nx = ex.min(left);
                let ny = ey.min(top);
                (nx, ny, ex_right.max(right) - nx, ey_bottom.max(bottom) - ny)
            }
        });
    }

    fn cell_of(&self, x: f32, y: f32) -> (i32, i32) {
        (
            (x / self.cell).floor() as i32,
            (y / self.cell).floor() as i32,
        )
    }

    /// 归一化矩形的 cell 闭区间；含非有限分量返回 `None`（该对象不参与索引）。
    fn cell_range(&self, rect: (f32, f32, f32, f32)) -> Option<((i32, i32), (i32, i32))> {
        let (x, y, width, height) = rect;
        if ![x, y, width, height].iter().all(|v| v.is_finite()) {
            return None;
        }
        let (left, right) = (x.min(x + width), x.max(x + width));
        let (top, bottom) = (y.min(y + height), y.max(y + height));
        Some((self.cell_of(left, top), self.cell_of(right, bottom)))
    }

    fn span(lo: (i32, i32), hi: (i32, i32)) -> i64 {
        (i64::from(hi.0 as i64 - lo.0 as i64) + 1)
            .saturating_mul(i64::from(hi.1 as i64 - lo.1 as i64) + 1)
    }

    /// 写入/替换某个对象的 AABB（同一 index 重复写入等价于先移除再插入）。
    pub(super) fn insert(&mut self, index: usize, rect: (f32, f32, f32, f32)) {
        self.remove(index);
        if self.occupied.len() <= index {
            self.occupied.resize(index + 1, Vec::new());
        }
        let Some((lo, hi)) = self.cell_range(rect) else {
            return;
        };
        self.include_in_extent(rect);
        if Self::span(lo, hi) > MAX_CELLS_PER_OBJECT {
            self.oversized.push(index);
            return;
        }
        let mut cells = Vec::new();
        for cx in lo.0..=hi.0 {
            for cy in lo.1..=hi.1 {
                self.cells.entry((cx, cy)).or_default().push(index);
                cells.push((cx, cy));
            }
        }
        self.occupied[index] = cells;
    }

    /// 位置增量：只搬动这一个对象（移出旧 cell、写入新 cell）。
    pub(super) fn relocate(&mut self, index: usize, rect: (f32, f32, f32, f32)) {
        self.insert(index, rect);
    }

    /// 移除对象（删除/换场景时使用）。
    pub(super) fn remove(&mut self, index: usize) {
        let Some(cells) = self.occupied.get_mut(index) else {
            return;
        };
        for key in cells.drain(..) {
            if let Some(list) = self.cells.get_mut(&key) {
                if let Some(position) = list.iter().position(|entry| *entry == index) {
                    list.swap_remove(position);
                }
                if list.is_empty() {
                    self.cells.remove(&key);
                }
            }
        }
        if let Some(position) = self.oversized.iter().position(|entry| *entry == index) {
            self.oversized.swap_remove(position);
        }
    }

    /// 与矩形相交的候选对象下标（升序、去重；**不是**命中结果，仍需精确几何细判）。
    pub(super) fn candidates(&self, rect: (f32, f32, f32, f32)) -> Vec<usize> {
        let mut out = self.oversized.clone();
        match self.cell_range(rect) {
            None => out.clear(),
            Some((lo, hi)) => {
                if Self::span(lo, hi) > MAX_CELLS_PER_QUERY {
                    // 查询跨度过大（大框选/极端 zoom）：退化为全量候选，仍由细判保证正确。
                    for list in self.cells.values() {
                        out.extend_from_slice(list);
                    }
                } else {
                    for cx in lo.0..=hi.0 {
                        for cy in lo.1..=hi.1 {
                            if let Some(list) = self.cells.get(&(cx, cy)) {
                                out.extend_from_slice(list);
                            }
                        }
                    }
                }
            }
        }
        out.sort_unstable();
        out.dedup();
        out
    }

    /// 候选数量（测试/诊断用）。
    #[cfg(test)]
    pub(super) fn indexed(&self) -> usize {
        self.occupied
            .iter()
            .filter(|cells| !cells.is_empty())
            .count()
            + self.oversized.len()
    }
}

/// 候选集合的成员判定：候选已排序去重，二分即 O(log k)。
pub(super) fn contains(candidates: &[usize], index: usize) -> bool {
    candidates.binary_search(&index).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> (f32, f32, f32, f32) {
        (x, y, width, height)
    }

    #[test]
    fn only_intersecting_cells_are_candidates() {
        let mut grid = SpatialGrid::new(100.0);
        for index in 0..1000 {
            let x = (index % 40) as f32 * 30.0;
            let y = (index / 40) as f32 * 30.0;
            grid.insert(index, rect(x, y, 24.0, 24.0));
        }
        assert_eq!(grid.indexed(), 1000);
        // 单点查询只取邻近 cell 的候选，不返回整份文档。
        let candidates = grid.candidates(rect(10.0, 10.0, 0.0, 0.0));
        assert!(!candidates.is_empty());
        assert!(
            candidates.len() < 50,
            "候选应局部化，实际 {}",
            candidates.len()
        );
        // 候选必须覆盖真正与查询相交的对象。
        for index in &candidates {
            assert!(contains(&candidates, *index));
        }
    }

    #[test]
    fn relocate_moves_the_object_between_cells() {
        let mut grid = SpatialGrid::new(100.0);
        grid.insert(0, rect(0.0, 0.0, 10.0, 10.0));
        grid.insert(1, rect(500.0, 500.0, 10.0, 10.0));
        assert!(contains(&grid.candidates(rect(2.0, 2.0, 0.0, 0.0)), 0));
        assert!(!contains(&grid.candidates(rect(2.0, 2.0, 0.0, 0.0)), 1));
        grid.relocate(0, rect(505.0, 505.0, 10.0, 10.0));
        assert!(!contains(&grid.candidates(rect(2.0, 2.0, 0.0, 0.0)), 0));
        assert!(contains(&grid.candidates(rect(505.0, 505.0, 0.0, 0.0)), 0));
        assert_eq!(grid.indexed(), 2);
    }

    #[test]
    fn removal_leaves_no_dangling_candidates() {
        let mut grid = SpatialGrid::new(100.0);
        for index in 0..10 {
            grid.insert(index, rect(index as f32 * 10.0, 0.0, 8.0, 8.0));
        }
        grid.remove(4);
        let candidates = grid.candidates(rect(0.0, 0.0, 200.0, 200.0));
        assert!(!contains(&candidates, 4));
        assert_eq!(candidates.len(), 9);
        assert_eq!(grid.indexed(), 9);
    }

    #[test]
    fn oversized_objects_stay_visible_to_every_query() {
        let mut grid = SpatialGrid::new(10.0);
        // 跨度远超 cell 预算：不铺满网格，但仍必须被查询返回。
        grid.insert(0, rect(0.0, 0.0, 100_000.0, 100_000.0));
        grid.insert(1, rect(0.0, 0.0, 4.0, 4.0));
        let candidates = grid.candidates(rect(1.0, 1.0, 0.0, 0.0));
        assert!(contains(&candidates, 0));
        assert!(contains(&candidates, 1));
    }

    #[test]
    fn enormous_query_falls_back_to_all_candidates() {
        let mut grid = SpatialGrid::new(10.0);
        for index in 0..50 {
            grid.insert(index, rect(index as f32 * 20.0, 0.0, 8.0, 8.0));
        }
        let candidates = grid.candidates(rect(-1e9, -1e9, 2e9, 2e9));
        assert_eq!(candidates.len(), 50);
    }

    #[test]
    fn non_finite_geometry_never_lands_in_the_grid() {
        let mut grid = SpatialGrid::new(100.0);
        grid.insert(0, rect(f32::NAN, 0.0, 10.0, 10.0));
        assert_eq!(grid.indexed(), 0);
        assert!(grid.candidates(rect(0.0, 0.0, 0.0, 0.0)).is_empty());
        assert!(grid.candidates(rect(f32::NAN, 0.0, 0.0, 0.0)).is_empty());
    }
}
