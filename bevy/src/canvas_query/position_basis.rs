//! Immutable full-scene candidate basis. Absolute previews never accumulate drift.
use super::interaction::PositionDelta;
use bevy::prelude::*;
use std::collections::HashMap;

pub(super) struct PositionBasis<T> {
    base: Vec<T>,
    slots: HashMap<String, Vec<usize>>,
}
impl<T> Default for PositionBasis<T> {
    fn default() -> Self {
        Self {
            base: Vec::new(),
            slots: HashMap::new(),
        }
    }
}
impl<T: Clone> PositionBasis<T> {
    pub(super) fn reset(&mut self, items: &[T], id: impl Fn(&T) -> &str) {
        self.base = items.to_vec();
        self.slots.clear();
        for (index, item) in items.iter().enumerate() {
            self.slots
                .entry(id(item).to_owned())
                .or_default()
                .push(index);
        }
    }
    pub(super) fn plan(
        &self,
        deltas: &[PositionDelta],
        shift: impl Fn(&T, Vec3) -> Result<T, &'static str>,
    ) -> Result<Vec<(usize, T)>, &'static str> {
        let mut plan = Vec::new();
        for delta in deltas {
            let Some(slots) = self.slots.get(&delta.id) else {
                continue;
            };
            let world = crate::isometric_grid::canvas_point_to_world(delta.dx, delta.dy, 0.);
            if !world.is_finite() {
                return Err("Invalid model position geometry");
            }
            for &index in slots {
                plan.push((index, shift(&self.base[index], world)?));
            }
        }
        Ok(plan)
    }
}

pub(super) fn shift_bounds(
    min: [f32; 3],
    max: [f32; 3],
    delta: Vec3,
) -> Result<([f32; 3], [f32; 3]), &'static str> {
    let min = Vec3::from_array(min) + delta;
    let max = Vec3::from_array(max) + delta;
    if !min.is_finite() || !max.is_finite() {
        return Err("Invalid model position geometry");
    }
    Ok((min.to_array(), max.to_array()))
}
