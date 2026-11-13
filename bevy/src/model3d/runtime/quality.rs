//! Quality changes replace shared handles while preserving model entities.
//!
//! 每个根在同一帧内先准备全部 replacement，再原子替换实体句柄与档位身份；任一批次失败
//! 保留完整旧表示，不把保留的低档几何标成高档。
use super::ModelVisuals;
use crate::protocol::Scene;
use bevy::prelude::*;
use std::collections::HashSet;

/// 普通升降档的最小发布间隔（秒）；High 消费者提升绕过。
const QUALITY_HOLD_SECONDS: f64 = 0.25;

/// 同步档位：`pins` 同时当作高优先需求，等价于 [`sync_quality_with_demand`] 传同一集合。
pub(crate) fn sync_quality(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    models: &mut ModelVisuals,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &HashSet<String>,
) -> bool {
    sync_quality_with_demand(commands, meshes, models, scene, focus, now, pins)
}

/// 同步档位，并把「需要 High 的根」与「需要保持驻留的根」分开。
///
/// `pins` 是驻留集合（截图请求等）；`high_demand` 只含真正需要 High 表示的根。
pub(crate) fn sync_quality_with_demand(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    models: &mut ModelVisuals,
    scene: &Scene,
    focus: Option<&str>,
    now: f64,
    pins: &HashSet<String>,
) -> bool {
    let ModelVisuals {
        roots,
        shared,
        capture_pins,
        .. 
    } = models;
    if *capture_pins != *pins {
        capture_pins.clone_from(pins);
    }
    // High 消费者集合与驻留 pin 是同一份（生产调用方 `sync_models` 已按截图/导出需求算出
    // `pins`；旧的 `high_demand` 形参让内部调用与系统参数列表不一致，导致 WASM 校验失败）。
    let high_demand: HashSet<String> = pins.clone();

    let completed = shared.poll_jobs(meshes);
    let mut changed = completed.is_some();
    if let Some((geometry, quality, true)) = completed.as_ref() {
        for root in roots.values_mut() {
            if *quality == root.quality
                && root
                    .geometries
                    .iter()
                    .any(|(_, _, bound)| std::sync::Arc::ptr_eq(geometry, bound))
            {
                root.quality_refresh_pending = true;
            }
        }
    }

    'roots: for node in &scene.nodes {
        let Some(root) = roots.get_mut(&node.id) else {
            continue;
        };
        let purpose =
            super::super::quality::purpose(node, scene, focus, high_demand.contains(&node.id));
        let high_owner = purpose.requires_high();
        // 世界模型始终参与绘制；是否驻留只由需求集合决定（离屏宽限、捕获 pin、聚焦）。
        // 旧卡片节点没有世界实例，因此没有可视几何。
        if node.shared_world_instance.is_none() {
            continue;
        }
        let demanded = models
            .demand
            .as_ref()
            .is_none_or(|demand| demand.contains(&node.id));
        if !high_owner && !demanded {
            continue;
        }
        let next = if high_owner {
            super::super::quality::Quality::High
        } else {
            super::super::quality::desired(node, scene, focus, root.quality, &root.resource)
        };
        let generated = root.quality_refresh_pending;

        if (next == root.quality && !generated)
            || (next != root.quality
                && !high_owner
                && root
                    .quality_changed_at
                    .is_some_and(|t| now - t < QUALITY_HOLD_SECONDS))
        {
            continue;
        }
        // Prepare every replacement before publishing any entity handle or quality
        // identity. A failed batch must not label retained low geometry as high.
        let mut prepared_parts = Vec::with_capacity(root.geometries.len());
        let mut prepared_batches = Vec::with_capacity(root.batches.len());
        let mut active = std::collections::HashMap::new();
        for (entity, base, geometry) in &root.geometries {
            // 每几何有效档位：Box/自定义 Mesh 恒 High，其余用根目标档位。
            let effective = super::super::mesh::effective_quality(geometry, next);
            let key = super::super::mesh::quality_key(base, geometry, effective);
            let Some((handle, _)) = shared.mesh(meshes, base, geometry, effective) else {
                root.quality_refresh_pending = true;
                continue 'roots;
            };
            active.insert(key, handle.clone());
            prepared_parts.push((*entity, handle));
        }
        for batch in &root.batches {
            let batch_quality = batch
                .source
                .specs
                .iter()
                .filter_map(|spec| spec.geometry.as_ref())
                .map(|geometry| super::super::mesh::effective_quality(geometry, next))
                .min()
                .unwrap_or(next);
            let Some(asset) = shared.batches.get(meshes, &batch.source, batch_quality) else {
                root.quality_refresh_pending = true;
                continue 'roots;
            };
            active.insert(format!("batch:{:?}", batch.entity), asset.handle.clone());
            prepared_batches.push(asset);
        }
        for (entity, handle) in prepared_parts {
            // Bevy recalculates bounds from the replacement mesh before visibility.
            commands
                .entity(entity)
                .remove::<bevy::camera::primitives::Aabb>()
                .insert(Mesh3d(handle));
        }
        for (batch, asset) in root.batches.iter_mut().zip(prepared_batches) {
            commands.entity(batch.entity).insert((
                Mesh3d(asset.handle.clone()),
                bevy::camera::primitives::Aabb::from_min_max(asset.min, asset.max),
            ));
            batch.set_asset(asset);
        }
        root.active_mesh_handles = active.into_values().collect();
        root.mesh_handles = root.active_mesh_handles.clone();
        changed = true;
        if root.quality != next {
            root.quality_changed_at = Some(now);
        }
        root.quality = next;
        root.quality_refresh_pending = false;
        root.representation_generation = root.representation_generation.wrapping_add(1);
    }
    changed
}

impl ModelVisuals {
    pub(crate) fn capture_pins(&self) -> &HashSet<String> {
        &self.capture_pins
    }
    pub(crate) fn capture_content(&self, id: &str) -> Option<&str> {
        self.roots
            .get(id)
            .map(|root| root.content_signature.as_str())
    }
    pub(crate) fn quality(&self, id: &str) -> super::super::quality::Quality {
        self.roots
            .get(id)
            .map_or(super::super::quality::Quality::High, |root| root.quality)
    }
    /// 该节点此刻是否有已 spawn 的模型根。
    ///
    /// 与 `preview_meshes(id).is_empty()` 不等价：根存在但内容为空（合法空模型）也返回 `true`。
    pub(crate) fn has_root(&self, id: &str) -> bool {
        self.roots.contains_key(id) || {
            #[cfg(test)]
            {
                self.ready_roots_for_test.contains(id)
            }
            #[cfg(not(test))]
            {
                false
            }
        }
    }
    /// 该节点是否有根（等待判定用）。
    pub(crate) fn has_or_prepares_root(&self, id: &str) -> bool {
        self.roots.contains_key(id)
    }
    /// 表示身份（质量档位 + 表示代数），供预览缓存去重与根重建失效使用。
    ///
    /// 根缺失时返回独立的 `"absent"` 标记，而不是与「刚创建的根」相同的 `"High:0"`：
    /// 卡片可能先建立视图、后 spawn 模型根（需求驱动的 spawn 在另一系统），两者若同身份，
    /// 签名/`quality_changed` 都不会变化，卡片就再也不会重渲染。
    pub(crate) fn quality_identity(&self, id: &str) -> String {
        let Some(root) = self.roots.get(id) else {
            return "absent".to_owned();
        };
        format!("{:?}:{}", root.quality, root.representation_generation)
    }
}

impl ModelVisuals {
    pub(crate) fn refresh_resource_references(&mut self) {
        self.mesh_references.clear();
        self.material_references.clear();
        for root in self.roots.values() {
            self.mesh_references
                .add_consumer(root.mesh_handles.iter().map(|h| h.id()));
            self.material_references
                .add_consumer(root.material_handles.iter().map(|h| h.id()));
        }
        for retained in self.capture_retention.values() {
            self.mesh_references
                .add_consumer(retained.meshes.iter().map(|h| h.id()));
            self.material_references
                .add_consumer(retained.materials.iter().map(|h| h.id()));
        }
    }

    pub(crate) fn trim_resources(
        &mut self,
        meshes: &mut Assets<Mesh>,
        materials: &mut Assets<StandardMaterial>,
    ) {
        // 归属集合未变时引用计数与上一轮完全相同，跳过 O(根×handle) 的全量重建；
        // 仍执行 `trim`，以便回收 prepare 期间新增但未被引用的缓存条目。
        let key = super::OwnershipKey::of(self);
        if self.references_key == Some(key) {
            self.hot_path.resource_reference_skips += 1;
        } else {
            self.refresh_resource_references();
            self.references_key = Some(key);
            self.hot_path.resource_reference_rebuilds += 1;
        }
        self.shared.trim(
            meshes,
            materials,
            &self.mesh_references,
            &self.material_references,
            self.roots.is_empty() && self.capture_retention.is_empty(),
        );
    }
}
