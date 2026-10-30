//! Shared immutable batch assets, retained under a separate bounded LRU budget.
use super::{
    batching::{self, BatchPlan, PartRange},
    quality::Quality,
    scene::ModelEntitySpec,
};
use bevy::{asset::AssetId, prelude::*};
use std::{
    collections::HashMap,
    hash::{DefaultHasher, Hash, Hasher},
    sync::Arc,
};

#[derive(Debug, PartialEq, Eq)]
struct BatchIdentity {
    text: String,
    hash: u64,
}
impl Hash for BatchIdentity {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.hash.hash(state);
    }
}

#[derive(Debug)]
pub(super) struct BatchSource {
    pub specs: Vec<ModelEntitySpec>,
    identity: Arc<BatchIdentity>,
}
impl BatchSource {
    pub fn new(specs: Vec<ModelEntitySpec>) -> Self {
        // Build an exact immutable identity once when preparing the batch source.
        // Quality lookups only clone its Arc; no per-transition Debug formatting.
        let geometry: Vec<_> = specs
            .iter()
            .map(|spec| {
                (
                    spec.position,
                    spec.rotation_radians,
                    spec.scale,
                    &spec.geometry,
                )
            })
            .collect();
        let text = format!("batch-v2-q{}:{geometry:?}", super::quality::QUALITY_VERSION);
        let mut hasher = DefaultHasher::new();
        text.hash(&mut hasher);
        let identity = Arc::new(BatchIdentity {
            text,
            hash: hasher.finish(),
        });
        Self { specs, identity }
    }
    /// 精确身份文本的估算字节（CPU 工作额度记账用；不重新格式化）。
    pub(super) fn identity_bytes(&self) -> usize {
        self.identity.text.len()
    }
}
pub(super) struct BatchAsset {
    pub handle: Handle<Mesh>,
    pub ranges: Vec<PartRange>,
    pub min: Vec3,
    pub max: Vec3,
    pub source_buffer_bytes: usize,
    pub buffer_bytes: usize,
}
pub(super) struct BatchBinding {
    pub entity: Entity,
    pub source: Arc<BatchSource>,
    pub asset: Arc<BatchAsset>,
    pub ranges: Vec<PartRange>,
}
impl BatchBinding {
    pub fn new(entity: Entity, source: Arc<BatchSource>, asset: Arc<BatchAsset>) -> Self {
        let ranges = source
            .specs
            .iter()
            .zip(&asset.ranges)
            .map(|(spec, range)| PartRange {
                id: spec.id.clone(),
                vertices: range.vertices.clone(),
                indices: range.indices.clone(),
            })
            .collect();
        Self {
            entity,
            source,
            asset,
            ranges,
        }
    }
    pub fn set_asset(&mut self, asset: Arc<BatchAsset>) {
        self.ranges = self
            .source
            .specs
            .iter()
            .zip(&asset.ranges)
            .map(|(spec, range)| PartRange {
                id: spec.id.clone(),
                vertices: range.vertices.clone(),
                indices: range.indices.clone(),
            })
            .collect();
        self.asset = asset;
    }
}
struct Entry {
    asset: Arc<BatchAsset>,
    bytes: usize,
    used: u64,
}
#[derive(Default)]
pub(super) struct BatchCache {
    entries: HashMap<(Arc<BatchIdentity>, Quality), Entry>,
    clock: u64,
    pub(super) source_mesh_builds: u64,
    pub(super) created_buffer_bytes: u64,
    pub(super) peak_retained_bytes: usize,
    pub(super) work: super::resource_work::ResourceWork,
}
impl BatchCache {
    pub fn get(
        &mut self,
        meshes: &mut Assets<Mesh>,
        source: &BatchSource,
        quality: Quality,
    ) -> Option<Arc<BatchAsset>> {
        self.clock = self.clock.wrapping_add(1);
        // Exact string equality remains the authority after hash lookup.
        let key = (source.identity.clone(), quality);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.used = self.clock;
            self.work.cache_hits += 1;
            return Some(entry.asset.clone());
        }
        let plan = BatchPlan {
            parent: None,
            material: String::new(),
            parts: (0..source.specs.len()).collect(),
        };
        let started = bevy::platform::time::Instant::now();
        let result = batching::build(&plan, &source.specs, quality);
        self.work
            .built(result.is_some(), started.elapsed().as_secs_f64() * 1000.0);
        let built = result?;
        Some(self.insert_with_work(key, meshes, built, true))
    }

    /// 登记一份**已经构建好**的 CPU 批次；缓存命中时 `build` 不会被调用。
    ///
    /// 身份、精确文本相等与字节记账与 [`Self::get`] 完全一致；宿主线程只做 `Assets::add`
    /// （change: 2026-10-18-prepare-native-film-sets-in-background，design D2）。
    pub fn adopt_with(
        &mut self,
        meshes: &mut Assets<Mesh>,
        source: &BatchSource,
        quality: Quality,
        build: impl FnOnce() -> Option<batching::BuiltBatch>,
    ) -> Option<Arc<BatchAsset>> {
        self.clock = self.clock.wrapping_add(1);
        let key = (source.identity.clone(), quality);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.used = self.clock;
            self.work.cache_hits += 1;
            return Some(entry.asset.clone());
        }
        let built = build()?;
        Some(self.insert_with_work(key, meshes, built, false))
    }

    fn insert_with_work(
        &mut self,
        key: (Arc<BatchIdentity>, Quality),
        meshes: &mut Assets<Mesh>,
        built: batching::BuiltBatch,
        count_build: bool,
    ) -> Arc<BatchAsset> {
        if count_build {
            self.work.built(true, 0.0);
        }
        self.source_mesh_builds += built.source_mesh_builds as u64;
        let buffer_bytes =
            built.mesh.get_vertex_buffer_size() + built.mesh.indices().map_or(0, |i| i.len() * 4);
        let bytes = key.0.text.len() + buffer_bytes;
        self.created_buffer_bytes += buffer_bytes as u64;
        let asset = Arc::new(BatchAsset {
            source_buffer_bytes: built.source_buffer_bytes,
            buffer_bytes,
            handle: meshes.add(built.mesh),
            ranges: built
                .ranges
                .into_iter()
                .map(|mut range| {
                    range.id.clear();
                    range
                })
                .collect(),
            min: built.min,
            max: built.max,
        });
        self.entries.insert(
            key,
            Entry {
                asset: asset.clone(),
                bytes,
                used: self.clock,
            },
        );
        self.peak_retained_bytes = self.peak_retained_bytes.max(self.bytes());
        asset
    }
    pub fn trim(
        &mut self,
        meshes: &mut Assets<Mesh>,
        live: &impl super::resource_ownership::LiveResources<AssetId<Mesh>>,
        empty: bool,
    ) {
        let mut bytes: usize = self.entries.values().map(|e| e.bytes).sum();
        let mut candidates: Vec<_> = self
            .entries
            .iter()
            .filter(|(_, e)| !live.contains(&e.asset.handle.id()))
            .map(|(k, e)| (e.used, k.clone()))
            .collect();
        candidates.sort_by_key(|e| e.0);
        for (_, key) in candidates {
            if !empty && bytes <= 64 * 1024 * 1024 && self.entries.len() <= 256 {
                break;
            }
            if let Some(entry) = self.entries.remove(&key) {
                bytes = bytes.saturating_sub(entry.bytes);
                meshes.remove(entry.asset.handle.id());
            }
        }
    }
    pub fn bytes(&self) -> usize {
        self.entries.values().map(|e| e.bytes).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identical_geometry_shares_across_scopes_with_instance_owned_ranges() {
        let first = ModelEntitySpec {
            id: "scope-a::part".into(),
            parent: Some("parent-a".into()),
            position: [1., 2., 3.],
            rotation_radians: [0.; 3],
            scale: [1.; 3],
            geometry: Some(super::super::scene::ModelGeometry::Sphere { radius: 1. }),
            material_key: "material-a".into(),
            animation: None,
        };
        let mut second = first.clone();
        second.id = "scope-b::part".into();
        second.parent = Some("parent-b".into());
        second.material_key = "material-b".into();
        let a = Arc::new(BatchSource::new(vec![first]));
        let b = Arc::new(BatchSource::new(vec![second]));
        let mut cache = BatchCache::default();
        let mut meshes = Assets::<Mesh>::default();
        let low_a = cache.get(&mut meshes, &a, Quality::Low).unwrap();
        let low_b = cache.get(&mut meshes, &b, Quality::Low).unwrap();
        assert_eq!(low_a.handle, low_b.handle);
        let binding_a = BatchBinding::new(Entity::PLACEHOLDER, a, low_a);
        let mut binding_b = BatchBinding::new(Entity::PLACEHOLDER, b.clone(), low_b);
        assert_eq!(binding_a.ranges[0].id, "scope-a::part");
        assert_eq!(binding_b.ranges[0].id, "scope-b::part");
        let before = binding_b.ranges[0].indices.end;
        binding_b.set_asset(cache.get(&mut meshes, &b, Quality::High).unwrap());
        assert_eq!(binding_b.ranges[0].id, "scope-b::part");
        assert!(binding_b.ranges[0].indices.end > before);
        assert_eq!(binding_a.ranges[0].indices.end, before);
    }

    #[test]
    fn prepared_hash_collision_keeps_exact_batch_identity() {
        let first = Arc::new(BatchIdentity {
            text: "first finite batch".into(),
            hash: 7,
        });
        let second = Arc::new(BatchIdentity {
            text: "different finite batch".into(),
            hash: 7,
        });
        let mut values = HashMap::new();
        values.insert((first.clone(), Quality::Low), 1);
        values.insert((second.clone(), Quality::Low), 2);
        values.insert((first.clone(), Quality::High), 3);
        assert_eq!(values.len(), 3);
        assert_eq!(values[&(first.clone(), Quality::Low)], 1);
        assert_eq!(values[&(second, Quality::Low)], 2);
        assert_eq!(values[&(first, Quality::High)], 3);
    }
}
