//! Renderer-consumer reference counts, independent of cache-held handles.
//! Rebuild only when representation/capture ownership changes, before trimming.
use std::collections::{HashMap, HashSet};
use std::hash::Hash;

/// Cache eviction accepts counted production owners or explicit test owners.
pub(super) trait LiveResources<K> {
    fn contains(&self, id: &K) -> bool;
}
impl<K: Eq + Hash> LiveResources<K> for HashSet<K> {
    fn contains(&self, id: &K) -> bool { HashSet::contains(self, id) }
}

pub(super) struct ResourceReferences<K> {
    counts: HashMap<K, usize>,
    scratch: HashSet<K>,
    consumers: usize,
}
impl<K> Default for ResourceReferences<K> {
    fn default() -> Self {
        Self { counts: HashMap::new(), scratch: HashSet::new(), consumers: 0 }
    }
}
impl<K: Copy + Eq + Hash> ResourceReferences<K> {
    pub(super) fn clear(&mut self) {
        self.counts.clear();
        self.scratch.clear();
        self.consumers = 0;
    }
    /// A root or frozen output owns one reference per unique asset, regardless
    /// of part count, quality aliases or duplicate retained Handle entries.
    pub(super) fn add_consumer(&mut self, assets: impl IntoIterator<Item = K>) {
        self.consumers += 1;
        self.scratch.clear();
        for id in assets {
            if self.scratch.insert(id) {
                *self.counts.entry(id).or_default() += 1;
            }
        }
    }
    pub(super) fn count(&self, id: &K) -> usize {
        self.counts.get(id).copied().unwrap_or(0)
    }
    pub(super) fn is_live(&self, id: &K) -> bool { self.count(id) > 0 }
    pub(super) fn consumers(&self) -> usize { self.consumers }
    pub(super) fn assets(&self) -> usize { self.counts.len() }
    pub(super) fn references(&self) -> usize { self.counts.values().sum() }
    pub(super) fn maximum(&self) -> usize { self.counts.values().copied().max().unwrap_or(0) }
}
impl<K: Copy + Eq + Hash> LiveResources<K> for ResourceReferences<K> {
    fn contains(&self, id: &K) -> bool { self.is_live(id) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicate_parts_and_quality_aliases_count_one_reference_per_consumer() {
        let mut refs = ResourceReferences::default();
        refs.add_consumer([1u64, 1, 2, 1]);
        refs.add_consumer([1u64, 3, 3]);
        assert_eq!(refs.count(&1), 2);
        assert_eq!(refs.count(&2), 1);
        assert_eq!(refs.consumers(), 2);
        assert_eq!(refs.assets(), 3);
        assert_eq!(refs.references(), 4);
        assert_eq!(refs.maximum(), 2);
    }
    #[test]
    fn deleting_one_root_retains_other_root_and_capture_then_final_release_is_zero() {
        let mut refs = ResourceReferences::default();
        for _ in 0..3 { refs.add_consumer([7u64]); } // two roots, one frozen capture
        assert_eq!(refs.count(&7), 3);
        refs.clear(); refs.add_consumer([7]); refs.add_consumer([7]);
        assert_eq!(refs.count(&7), 2); assert!(refs.is_live(&7));
        refs.clear(); refs.add_consumer([7]); // only frozen readback remains
        assert_eq!(refs.count(&7), 1); assert!(refs.is_live(&7));
        refs.clear();
        assert_eq!(refs.count(&7), 0); assert!(!refs.is_live(&7));
        assert_eq!(refs.references(), 0); assert_eq!(refs.maximum(), 0);
    }
    #[test]
    fn representation_replacement_does_not_leave_old_quality_or_material_pinned() {
        let mut refs = ResourceReferences::default();
        refs.add_consumer([10u64, 11]); refs.add_consumer([10]);
        refs.clear(); refs.add_consumer([20u64, 21]); refs.add_consumer([10]);
        assert!(refs.is_live(&10)); assert!(!refs.is_live(&11));
        assert!(refs.is_live(&20)); assert!(refs.is_live(&21));
        assert_eq!(refs.references(), 3);
    }
    #[test]
    fn empty_consumers_do_not_create_phantom_asset_references() {
        let mut refs = ResourceReferences::<u64>::default();
        refs.add_consumer([]); refs.add_consumer([]);
        assert_eq!(refs.consumers(), 2); assert_eq!(refs.assets(), 0);
        assert_eq!(refs.references(), 0); assert!(!refs.is_live(&0));
    }
    #[test]
    fn counted_ownership_and_test_set_have_identical_eviction_membership() {
        fn live<K>(owners: &impl LiveResources<K>, id: &K) -> bool { owners.contains(id) }
        let set = HashSet::from([1u64, 2]);
        let mut refs = ResourceReferences::default(); refs.add_consumer([1u64, 1, 2]);
        for id in [0, 1, 2, 3] { assert_eq!(live(&refs, &id), live(&set, &id)); }
    }
}
