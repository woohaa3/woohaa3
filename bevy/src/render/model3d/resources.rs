//! Immutable renderer resources shared across roots, with collision verification
//! and bounded retention of unreferenced variants. Instance state stays on roots.
//!
//! Custom-mesh simplification (D2) and static batching (D1) are delivered by
//! dependent changes; this module owns mesh/material sharing, quality identity
//! and LRU ownership only.
use super::{mesh, quality::Quality, scene::ModelGeometry};
use bevy::{asset::AssetId, prelude::*};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const MAX_MESH_BYTES: usize = 256 * 1024 * 1024;
const MAX_RESOURCES: usize = 4096;
struct MeshEntry {
    geometry: Arc<ModelGeometry>,
    handle: Handle<Mesh>,
    bytes: usize,
    used: u64,
}
struct MaterialEntry {
    handle: Handle<StandardMaterial>,
    used: u64,
}
#[derive(Default)]
pub(super) struct SharedResources {
    meshes: HashMap<String, Vec<MeshEntry>>,
    materials: HashMap<String, MaterialEntry>,
    clock: u64,
    pub(super) work: super::resource_work::ResourceWork,
    jobs: super::simplification_jobs::Jobs,
    pub(super) batches: super::batch_cache::BatchCache,
}

/// material 共享身份：受控 PBR 字段全参与，脚本侧名字不参与
/// （后台准备与同步登记共用同一函数，避免两处格式漂移）。
pub(super) fn material_cache_key(material: &StandardMaterial) -> String {
    format!("material-v1:{material:?}")
}
impl SharedResources {
    pub(super) fn counts(&self) -> (usize, usize) {
        (
            self.meshes.values().map(Vec::len).sum(),
            self.materials.len(),
        )
    }
    /// 共享 mesh/material/批次缓存的累计命中数（诊断用；命中不重建几何）。
    pub(super) fn cache_hits(&self) -> u64 {
        self.work.cache_hits + self.batches.work.cache_hits
    }
    pub(super) fn bytes(&self) -> usize {
        self.meshes.values().flatten().map(|e| e.bytes).sum()
    }
    pub(super) fn lookup(
        &self,
        base: &str,
        geometry: &ModelGeometry,
        quality: Quality,
    ) -> Option<&Handle<Mesh>> {
        self.meshes
            .get(&mesh::quality_key(base, geometry, quality))?
            .iter()
            .find(|e| {
                std::ptr::eq(e.geometry.as_ref(), geometry) || e.geometry.as_ref() == geometry
            })
            .map(|e| &e.handle)
    }

    pub(super) fn mesh(
        &mut self,
        assets: &mut Assets<Mesh>,
        base: &str,
        geometry: &ModelGeometry,
        quality: Quality,
    ) -> Option<(Handle<Mesh>, Arc<ModelGeometry>)> {
        self.mesh_from(assets, base, geometry, quality, |quality| {
            mesh::build_mesh_quality(geometry, quality)
        })
    }

    /// 登记一份**已经构建好**的 CPU 网格（后台准备产物）；缓存命中时不消费 `build`。
    ///
    /// 与 [`Self::mesh`] 共用同一身份、精确相等校验、档位别名与简化任务语义，宿主线程因此
    /// 不必重新展开几何或重复构建同档网格（change: 2026-10-18-prepare-native-film-sets-in-background，
    /// design D2）。
    pub(super) fn adopt_mesh(
        &mut self,
        assets: &mut Assets<Mesh>,
        base: &str,
        geometry: &ModelGeometry,
        quality: Quality,
        build: impl FnOnce(Quality) -> Option<Mesh>,
    ) -> Option<(Handle<Mesh>, Arc<ModelGeometry>)> {
        self.mesh_from(assets, base, geometry, quality, build)
    }

    fn mesh_from(
        &mut self,
        assets: &mut Assets<Mesh>,
        base: &str,
        geometry: &ModelGeometry,
        quality: Quality,
        build: impl FnOnce(Quality) -> Option<Mesh>,
    ) -> Option<(Handle<Mesh>, Arc<ModelGeometry>)> {
        self.clock = self.clock.wrapping_add(1);
        let key = mesh::quality_key(base, geometry, quality);
        if matches!(geometry, ModelGeometry::Mesh { .. }) && quality != Quality::High {
            if let Some(entry) = self.meshes.get_mut(&key).and_then(|bucket| {
                bucket.iter_mut().find(|entry| {
                    std::ptr::eq(entry.geometry.as_ref(), geometry)
                        || entry.geometry.as_ref() == geometry
                })
            }) {
                entry.used = self.clock;
                self.work.cache_hits += 1;
                return Some((entry.handle.clone(), entry.geometry.clone()));
            }
            // Keep the original legal representation until the content task
            // completes. Aliases carry zero bytes because high owns the buffer.
            let (handle, shared_geometry) =
                self.mesh_from(assets, base, geometry, Quality::High, build)?;
            self.meshes.entry(key.clone()).or_default().push(MeshEntry {
                geometry: shared_geometry.clone(),
                handle: handle.clone(),
                bytes: 0,
                used: self.clock,
            });
            self.jobs.enqueue(key, shared_geometry.clone(), quality);
            return Some((handle, shared_geometry));
        }
        let bucket = self.meshes.entry(key).or_default();
        // Hashes accelerate lookup; exact equality is the authority on collision.
        if let Some(entry) = bucket.iter_mut().find(|entry| {
            std::ptr::eq(entry.geometry.as_ref(), geometry) || entry.geometry.as_ref() == geometry
        }) {
            entry.used = self.clock;
            self.work.cache_hits += 1;
            return Some((entry.handle.clone(), entry.geometry.clone()));
        }
        let started = bevy::platform::time::Instant::now();
        let built = build(quality);
        self.work
            .built(built.is_some(), started.elapsed().as_secs_f64() * 1000.0);
        let mesh = built?;
        let bytes =
            mesh.get_vertex_buffer_size() + mesh.indices().map_or(0, |indices| indices.len() * 4);
        let handle = assets.add(mesh);
        let geometry = Arc::new(geometry.clone());
        bucket.push(MeshEntry {
            handle: handle.clone(),
            geometry: geometry.clone(),
            bytes,
            used: self.clock,
        });
        Some((handle, geometry))
    }
    /// 登记一份已构建的 material（后台算好的 cache key + 描述）。
    pub(super) fn adopt_material(
        &mut self,
        assets: &mut Assets<StandardMaterial>,
        key: String,
        material: StandardMaterial,
    ) -> Handle<StandardMaterial> {
        self.clock = self.clock.wrapping_add(1);
        let entry = self.materials.entry(key).or_insert_with(|| MaterialEntry {
            handle: assets.add(material),
            used: self.clock,
        });
        entry.used = self.clock;
        entry.handle.clone()
    }
    pub(super) fn material(
        &mut self,
        assets: &mut Assets<StandardMaterial>,
        material: StandardMaterial,
    ) -> Handle<StandardMaterial> {
        self.clock = self.clock.wrapping_add(1);
        // All fields of the controlled PBR material, including alpha/culling,
        // participate. Script-local material names do not affect sharing.
        let key = material_cache_key(&material);
        let entry = self.materials.entry(key).or_insert_with(|| MaterialEntry {
            handle: assets.add(material),
            used: self.clock,
        });
        entry.used = self.clock;
        entry.handle.clone()
    }
    pub(super) fn trim(
        &mut self,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
        live_meshes: &impl super::resource_ownership::LiveResources<AssetId<Mesh>>,
        live_materials: &impl super::resource_ownership::LiveResources<AssetId<StandardMaterial>>,
        empty: bool,
    ) {
        self.batches.trim(meshes, live_meshes, empty);
        if empty {
            self.jobs.clear();
            let ids: Vec<_> = self
                .meshes
                .values()
                .flatten()
                .map(|entry| entry.handle.id())
                .collect();
            for id in ids {
                meshes.remove(id);
            }
            self.meshes.clear();
        } else {
            let entries = &self.meshes;
            let cancelled = self.jobs.retain_pending(|job| {
                entries.get(&job.key).is_some_and(|bucket| {
                    bucket.iter().any(|entry| {
                        Arc::ptr_eq(&entry.geometry, &job.geometry)
                            && live_meshes.contains(&entry.handle.id())
                    })
                })
            });
            // Remove cancelled aliases so a later demand retries generation.
            for job in cancelled {
                if let Some(bucket) = self.meshes.get_mut(&job.key) {
                    bucket.retain(|entry| {
                        !Arc::ptr_eq(&entry.geometry, &job.geometry) || entry.bytes != 0
                    });
                }
            }
            self.meshes.retain(|_, bucket| !bucket.is_empty());
        }
        let mut bytes: usize = self
            .meshes
            .values()
            .flatten()
            .map(|entry| entry.bytes)
            .sum();
        let mut count: usize = self.meshes.values().map(Vec::len).sum();
        // Several quality identities may alias the same original GPU buffer.
        // Evict/account that buffer once, using its most recent consumer use.
        let mut buffers = HashMap::<AssetId<Mesh>, (u64, usize, usize)>::new();
        for entry in self
            .meshes
            .values()
            .flatten()
            .filter(|e| !live_meshes.contains(&e.handle.id()))
        {
            let buffer = buffers.entry(entry.handle.id()).or_insert((0, 0, 0));
            buffer.0 = buffer.0.max(entry.used);
            buffer.1 = buffer.1.saturating_add(entry.bytes);
            buffer.2 += 1;
        }
        let mut candidates: Vec<_> = buffers.into_iter().collect();
        candidates.sort_by_key(|(_, (used, _, _))| *used);
        let mut remove = HashSet::new();
        for (id, (_, size, aliases)) in candidates {
            if !empty && bytes <= MAX_MESH_BYTES && count <= MAX_RESOURCES {
                break;
            }
            remove.insert(id);
            bytes = bytes.saturating_sub(size);
            count = count.saturating_sub(aliases);
            meshes.remove(id);
        }
        self.meshes.retain(|_, bucket| {
            bucket.retain(|e| !remove.contains(&e.handle.id()));
            !bucket.is_empty()
        });
        let mut candidates: Vec<_> = self
            .materials
            .iter()
            .filter(|(_, e)| !live_materials.contains(&e.handle.id()))
            .map(|(key, e)| (e.used, key.clone()))
            .collect();
        candidates.sort_by_key(|entry| entry.0);
        for (_, key) in candidates {
            if !empty && self.materials.len() <= MAX_RESOURCES {
                break;
            }
            if let Some(entry) = self.materials.remove(&key) {
                materials.remove(entry.handle.id());
            }
        }
    }
    pub(super) fn poll_jobs(
        &mut self,
        assets: &mut Assets<Mesh>,
    ) -> Option<(Arc<ModelGeometry>, Quality, bool)> {
        let finished = self.jobs.poll()?;
        let key = finished.job.key;
        let geometry = finished.job.geometry;
        let quality = finished.job.quality;
        let Ok(reduced) = finished.result else {
            return Some((geometry, quality, false));
        };
        let Some(entry) = self.meshes.get_mut(&key).and_then(|bucket| {
            bucket
                .iter_mut()
                .find(|entry| Arc::ptr_eq(&entry.geometry, &geometry))
        }) else {
            return Some((geometry, quality, false));
        };
        entry.bytes = reduced.mesh.get_vertex_buffer_size()
            + reduced.mesh.indices().map_or(0, |i| i.len() * 4);
        entry.handle = assets.add(reduced.mesh);
        Some((geometry, quality, true))
    }
    pub(super) fn simplification_diagnostics(&self) -> serde_json::Value {
        self.jobs.diagnostics()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleted_geometry_drops_pending_job_and_reentry_retries_alias() {
        let mut cache = SharedResources::default();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let a = super::super::simplification::tests::sphere();
        let mut b = a.clone();
        if let ModelGeometry::Mesh { vertices, .. } = &mut b {
            for vertex in vertices {
                vertex[0] += 3.;
            }
        }
        cache.mesh(&mut meshes, "a", &a, Quality::Low).unwrap();
        let (live, _) = cache.mesh(&mut meshes, "b", &b, Quality::Low).unwrap();
        assert_eq!(cache.simplification_diagnostics()["pending"], 2);
        cache.trim(
            &mut meshes,
            &mut materials,
            &HashSet::from([live.id()]),
            &HashSet::new(),
            false,
        );
        assert_eq!(cache.simplification_diagnostics()["pending"], 1);
        assert_eq!(cache.simplification_diagnostics()["cancelled"], 1);
        assert!(cache.lookup("a", &a, Quality::Low).is_none());
        assert!(cache.lookup("b", &b, Quality::Low).is_some());
        cache.mesh(&mut meshes, "a", &a, Quality::Low).unwrap();
        assert_eq!(cache.simplification_diagnostics()["pending"], 2);
    }

    #[test]
    fn colliding_hashes_verify_geometry_and_material_state_never_aliases() {
        let mut cache = SharedResources::default();
        let mut meshes = Assets::<Mesh>::default();
        let a = ModelGeometry::Sphere { radius: 1. };
        let b = ModelGeometry::Sphere { radius: 2. };
        let (first, _) = cache
            .mesh(&mut meshes, "forced-collision", &a, Quality::Low)
            .unwrap();
        let (second, _) = cache
            .mesh(&mut meshes, "forced-collision", &b, Quality::Low)
            .unwrap();
        assert_ne!(first, second);
        assert_eq!(
            cache
                .mesh(&mut meshes, "forced-collision", &a, Quality::Low)
                .unwrap()
                .0,
            first
        );
        assert_eq!(cache.work.built_meshes, 2);
        assert_eq!(cache.work.cache_hits, 1);
        assert!(cache.work.build_ms.is_finite());
        let mut materials = Assets::<StandardMaterial>::default();
        let opaque = cache.material(&mut materials, StandardMaterial::default());
        let blend = cache.material(
            &mut materials,
            StandardMaterial {
                alpha_mode: bevy::material::AlphaMode::Blend,
                ..default()
            },
        );
        let double_sided = cache.material(
            &mut materials,
            StandardMaterial {
                cull_mode: None,
                ..default()
            },
        );
        assert_ne!(opaque, blend);
        assert_ne!(opaque, double_sided);
    }

    #[test]
    fn quality_aliases_share_one_lru_budget_and_keep_the_most_recent_buffer() {
        let mut cache = SharedResources::default();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let geometry = ModelGeometry::Mesh {
            vertices: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
            faces: vec![[0, 1, 2]],
            normals: None,
            uvs: None,
            colors: None,
        };
        let (shared, _) = cache
            .mesh(&mut meshes, "custom", &geometry, Quality::Low)
            .unwrap();
        cache
            .mesh(&mut meshes, "custom", &geometry, Quality::Medium)
            .unwrap();
        let (older, _) = cache
            .mesh(
                &mut meshes,
                "other",
                &ModelGeometry::Sphere { radius: 1. },
                Quality::Low,
            )
            .unwrap();
        cache
            .mesh(&mut meshes, "custom", &geometry, Quality::High)
            .unwrap();
        // Synthetic footprints exercise a 256 MiB budget without allocating it.
        for entry in cache.meshes.values_mut().flatten() {
            if entry.bytes != 0 {
                entry.bytes = if entry.handle == shared { 200 } else { 100 } * 1024 * 1024;
            }
        }
        cache.trim(
            &mut meshes,
            &mut materials,
            &HashSet::new(),
            &HashSet::new(),
            false,
        );
        assert!(meshes.contains(shared.id()));
        assert!(!meshes.contains(older.id()));
        assert_eq!(cache.counts().0, 3);
        assert_eq!(cache.bytes(), 200 * 1024 * 1024);
        assert_eq!(
            cache.lookup("custom", &geometry, Quality::Low),
            Some(&shared)
        );
        assert_eq!(
            cache.lookup("custom", &geometry, Quality::Medium),
            Some(&shared)
        );
    }

    #[test]
    fn quality_identity_separates_variants_and_shares_identical_geometry_only() {
        let mut cache = SharedResources::default();
        let mut meshes = Assets::<Mesh>::default();
        let geometry = ModelGeometry::Sphere { radius: 1. };
        let (low, _) = cache
            .mesh(&mut meshes, "sphere", &geometry, Quality::Low)
            .unwrap();
        let (high, _) = cache
            .mesh(&mut meshes, "sphere", &geometry, Quality::High)
            .unwrap();
        assert_ne!(low, high, "quality identity must not alias across tiers");
        assert_eq!(
            cache
                .mesh(&mut meshes, "sphere", &geometry, Quality::Low)
                .unwrap()
                .0,
            low
        );
        assert_eq!(cache.counts().0, 2);
    }

    #[test]
    fn lru_only_evicts_unreferenced_resources_and_final_release_clears_assets() {
        let mut cache = SharedResources::default();
        let mut meshes = Assets::<Mesh>::default();
        let mut materials = Assets::<StandardMaterial>::default();
        let mut handles = Vec::new();
        for index in 0..MAX_RESOURCES + 2 {
            let geometry = ModelGeometry::Sphere {
                radius: (index + 1) as f32,
            };
            handles.push(
                cache
                    .mesh(&mut meshes, &index.to_string(), &geometry, Quality::Low)
                    .unwrap()
                    .0,
            );
        }
        let material = cache.material(&mut materials, StandardMaterial::default());
        let live_meshes = HashSet::from([handles[0].id()]);
        let live_materials = HashSet::from([material.id()]);
        cache.trim(
            &mut meshes,
            &mut materials,
            &live_meshes,
            &live_materials,
            false,
        );
        assert_eq!(cache.counts().0, MAX_RESOURCES);
        assert!(
            meshes.contains(handles[0].id()),
            "oldest active mesh must survive"
        );
        assert!(!meshes.contains(handles[1].id()));
        assert!(!meshes.contains(handles[2].id()));
        assert!(materials.contains(material.id()));
        // Caller-held handles do not constitute renderer ownership after the
        // final root disappears; the explicit Assets entries are reclaimed.
        cache.trim(
            &mut meshes,
            &mut materials,
            &HashSet::new(),
            &HashSet::new(),
            true,
        );
        assert_eq!(cache.counts(), (0, 0));
        assert_eq!(cache.bytes(), 0);
        assert!(meshes.is_empty());
        assert!(materials.is_empty());
    }
}
