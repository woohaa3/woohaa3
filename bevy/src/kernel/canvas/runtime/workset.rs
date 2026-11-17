//! Spatial workset planning for the main 2D viewport.
//!
//! This is a pure broad phase.  It returns stable block ids and never decides
//! visibility for nodes, models, captures, or query snapshots.

use std::collections::{BTreeSet, HashMap};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Aabb {
    pub(crate) min: [f32; 2],
    pub(crate) max: [f32; 2],
}

impl Aabb {
    /// Canvas viewport x/y are screen-space translations, not world centers.
    pub(crate) fn from_viewport(viewport: &crate::protocol::Viewport, surface: [f32; 2]) -> Self {
        let zoom = viewport.zoom.max(0.01);
        Self {
            min: [-viewport.x / zoom, -viewport.y / zoom],
            max: [(surface[0] - viewport.x) / zoom, (surface[1] - viewport.y) / zoom],
        }
    }
    pub(crate) fn intersects(self, other: Self) -> bool {
        self.min[0] <= other.max[0]
            && self.max[0] >= other.min[0]
            && self.min[1] <= other.max[1]
            && self.max[1] >= other.min[1]
    }

    pub(crate) fn expand(self, amount: f32) -> Self {
        let amount = amount.max(0.0);
        Self {
            min: [self.min[0] - amount, self.min[1] - amount],
            max: [self.max[0] + amount, self.max[1] + amount],
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorksetDelta {
    pub(crate) entered: Vec<u32>,
    pub(crate) left: Vec<u32>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Workset {
    active: BTreeSet<u32>,
}

impl Workset {
    pub(crate) fn active(&self) -> &BTreeSet<u32> {
        &self.active
    }

    pub(crate) fn update(&mut self, next: impl IntoIterator<Item = u32>) -> WorksetDelta {
        let next: BTreeSet<u32> = next.into_iter().collect();
        let mut delta = WorksetDelta {
            entered: next.difference(&self.active).copied().collect(),
            left: self.active.difference(&next).copied().collect(),
        };
        delta.entered.sort_unstable();
        delta.left.sort_unstable();
        self.active = next;
        delta
    }

    pub(crate) fn reset(&mut self) -> WorksetDelta {
        self.update(std::iter::empty())
    }
}

/// Block AABBs with a conservative oversized fallback.
#[derive(Clone, Debug)]
pub(crate) struct WorksetIndex {
    blocks: HashMap<u32, Aabb>,
    oversized: BTreeSet<u32>,
    cells: HashMap<(i32, i32), BTreeSet<u32>>,
    block_cells: HashMap<u32, Vec<(i32, i32)>>,
}

impl Default for WorksetIndex {
    fn default() -> Self {
        Self {
            blocks: HashMap::new(),
            oversized: BTreeSet::new(),
            cells: HashMap::new(),
            block_cells: HashMap::new(),
        }
    }
}

impl WorksetIndex {
    pub(crate) fn clear(&mut self) {
        self.blocks.clear();
        self.oversized.clear();
        self.cells.clear();
        self.block_cells.clear();
    }

    pub(crate) fn insert(&mut self, block: u32, bounds: Aabb) {
        self.remove(block);
        self.blocks.insert(block, bounds);
        let Some(cells) = cells_for(bounds, 256) else {
            self.oversized.insert(block);
            return;
        };
        for cell in &cells {
            self.cells.entry(*cell).or_default().insert(block);
        }
        self.block_cells.insert(block, cells);
    }

    pub(crate) fn insert_oversized(&mut self, block: u32) {
        self.remove(block);
        self.oversized.insert(block);
    }

    pub(crate) fn remove(&mut self, block: u32) {
        self.blocks.remove(&block);
        self.oversized.remove(&block);
        if let Some(cells) = self.block_cells.remove(&block) {
            for cell in cells {
                if let Some(ids) = self.cells.get_mut(&cell) {
                    ids.remove(&block);
                    if ids.is_empty() { self.cells.remove(&cell); }
                }
            }
        }
    }

    pub(crate) fn query(&self, viewport: Aabb, margin: f32) -> Vec<u32> {
        self.query_with_hysteresis(viewport, margin, margin, &BTreeSet::new())
    }

    /// Query with separate enter/leave margins. The leave margin must be at least
    /// the enter margin so blocks remain visible while crossing the hysteresis band.
    pub(crate) fn query_with_hysteresis(
        &self,
        viewport: Aabb,
        enter_margin: f32,
        leave_margin: f32,
        active: &BTreeSet<u32>,
    ) -> Vec<u32> {
        let leave_margin = leave_margin.max(enter_margin);
        let mut result = self.oversized.clone();
        let enter = viewport.expand(enter_margin);
        let leave = viewport.expand(leave_margin);
        let mut candidates = BTreeSet::new();
        if let Some(cells) = cells_for(enter, 4096) {
            for cell in cells {
                if let Some(ids) = self.cells.get(&cell) { candidates.extend(ids); }
            }
        } else {
            candidates.extend(self.blocks.keys().copied());
        }
        candidates.extend(active.iter().copied());
        result.extend(candidates.into_iter().filter(|block| {
            self.blocks.get(block).is_some_and(|bounds| {
                bounds.intersects(if active.contains(block) { leave } else { enter })
            })
        }));
        result.into_iter().collect()
    }
}

/// Bounded grid enumeration; very large or invalid rectangles take the conservative path.
fn cells_for(bounds: Aabb, limit: u64) -> Option<Vec<(i32, i32)>> {
    const CELL_SIZE: f32 = 1024.0;
    if !bounds.min.iter().chain(bounds.max.iter()).all(|v| v.is_finite())
        || bounds.min[0] > bounds.max[0] || bounds.min[1] > bounds.max[1] {
        return None;
    }
    let cell = |value: f32| -> Option<i32> {
        let value = (value as f64 / CELL_SIZE as f64).floor();
        (value >= i32::MIN as f64 && value <= i32::MAX as f64).then_some(value as i32)
    };
    let (x0, y0, x1, y1) = (cell(bounds.min[0])?, cell(bounds.min[1])?, cell(bounds.max[0])?, cell(bounds.max[1])?);
    let width = (i64::from(x1) - i64::from(x0) + 1) as u64;
    let height = (i64::from(y1) - i64::from(y0) + 1) as u64;
    if width.checked_mul(height)? > limit { return None; }
    let mut result = Vec::with_capacity((width * height) as usize);
    for x in x0..=x1 { for y in y0..=y1 { result.push((x, y)); } }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box2(x: f32, y: f32, w: f32, h: f32) -> Aabb {
        Aabb { min: [x, y], max: [x + w, y + h] }
    }

    #[test]
    fn viewport_translation_and_zoom_produce_world_bounds() {
        let view = crate::protocol::Viewport { x: -200., y: 100., zoom: 2. };
        assert_eq!(Aabb::from_viewport(&view, [800., 600.]), box2(100., -50., 400., 300.));
    }

    #[test]
    fn query_returns_only_intersecting_blocks_and_oversized() {
        let mut index = WorksetIndex::default();
        index.insert(0, box2(0., 0., 10., 10.));
        index.insert(1, box2(100., 100., 10., 10.));
        index.insert_oversized(9);
        assert_eq!(index.query(box2(-1., -1., 12., 12.), 0.), vec![0, 9]);
    }

    #[test]
    fn delta_is_stable_and_sorted() {
        let mut workset = Workset::default();
        assert_eq!(workset.update([3, 1]), WorksetDelta { entered: vec![1, 3], left: vec![] });
        assert_eq!(workset.update([2, 3]), WorksetDelta { entered: vec![2], left: vec![1] });
        assert_eq!(workset.reset(), WorksetDelta { entered: vec![], left: vec![2, 3] });
    }

    #[test]
    fn active_blocks_stay_visible_until_they_leave_the_outer_margin() {
        let mut index = WorksetIndex::default();
        index.insert(1, box2(110., 0., 10., 10.));
        let mut workset = Workset::default();
        let next = index.query_with_hysteresis(box2(0., 0., 100., 100.), 20., 36., workset.active());
        assert_eq!(workset.update(next).entered, vec![1]);
        for _ in 0..3 {
            let next = index.query_with_hysteresis(box2(-15., 0., 100., 100.), 20., 36., workset.active());
            assert_eq!(workset.update(next), WorksetDelta::default());
        }
        let next = index.query_with_hysteresis(box2(-27., 0., 100., 100.), 20., 36., workset.active());
        assert_eq!(workset.update(next).left, vec![1]);
    }

    #[test]
    fn grid_updates_moved_and_oversized_blocks_without_losing_boundary_hits() {
        let mut index = WorksetIndex::default();
        index.insert(1, box2(-1024., -10., 1024., 20.));
        index.insert(2, box2(100_000., 100_000., 500_000., 500_000.));
        assert_eq!(index.query(box2(0., 0., 1., 1.), 0.), vec![1, 2]);
        index.insert(1, box2(3000., 3000., 10., 10.));
        assert_eq!(index.query(box2(0., 0., 1., 1.), 0.), vec![2]);
        assert_eq!(index.query(box2(3000., 3000., 1., 1.), 0.), vec![1, 2]);
        index.remove(2);
        assert_eq!(index.query(box2(3000., 3000., 1., 1.), 0.), vec![1]);
        assert_eq!(index.query(box2(-1_000_000., -1_000_000., 2_000_000., 2_000_000.), 0.), vec![1]);
    }

    #[test]
    fn grid_matches_linear_reference_across_moves_and_hysteresis() {
        let mut index = WorksetIndex::default();
        let mut bounds = HashMap::new();
        for id in 0..300 {
            let rect = box2((id % 20) as f32 * 700. - 7000., (id / 20) as f32 * 900. - 6000., 200., 350.);
            index.insert(id, rect);
            bounds.insert(id, rect);
        }
        let mut active = BTreeSet::new();
        for step in 0..80 {
            let moved = step % 300;
            let rect = box2(step as f32 * 317. - 9000., step as f32 * -211. + 7000., 200., 350.);
            index.insert(moved, rect);
            bounds.insert(moved, rect);
            let viewport = box2(step as f32 * 250. - 8000., step as f32 * 145. - 6500., 1600., 1100.);
            let expected: BTreeSet<_> = bounds.iter().filter_map(|(&id, &rect)| {
                rect.intersects(viewport.expand(if active.contains(&id) { 80. } else { 64. })).then_some(id)
            }).collect();
            let actual: BTreeSet<_> = index.query_with_hysteresis(viewport, 64., 80., &active).into_iter().collect();
            assert_eq!(actual, expected, "step {step}");
            active = actual;
        }
    }
}
