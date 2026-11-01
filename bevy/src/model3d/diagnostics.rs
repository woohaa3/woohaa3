//! Measured mesh instance/unique budgets; called only after representation changes.
use super::ModelVisuals;
use bevy::prelude::*;
use std::collections::HashSet;
impl ModelVisuals {
    pub(crate) fn budget_json(
        &self,
        meshes: &Assets<Mesh>,
        materials: &Assets<StandardMaterial>,
    ) -> String {
        self.budget_json_with_requests(meshes, materials, &[])
    }

    /// 同 [`Self::budget_json`]，额外记录当前截图请求的（节点, 来源）。
    ///
    /// 来源只进本地诊断快照：pin 集合只有节点 id，分辨不出是视频导出、镜头图片参考、
    /// 镜头参考录制还是模型编辑器截图把根按在 High。
    pub(crate) fn budget_json_with_requests(
        &self,
        meshes: &Assets<Mesh>,
        materials: &Assets<StandardMaterial>,
        capture_requests: &[(String, String)],
    ) -> String {
        let mut vertices = 0usize;
        let mut triangles = 0usize;
        let mut parts = 0usize;
        let mut unique = HashSet::new();
        let mut batch_count = 0usize;
        let mut batched_parts = 0usize;
        let mut mapped_vertices = 0usize;
        let mut mapped_indices = 0usize;
        let mut entities = 0usize;
        let mut batch_buffers = HashSet::new();
        let mut batch_buffer_bytes = 0usize;
        let mut batch_source_buffer_bytes = 0usize;
        let mut tiers = [0usize; 3];
        for root in self.roots.values() {
            entities += root.entities.len();
            for batch in &root.batches {
                if batch_buffers.insert(batch.asset.handle.id()) {
                    batch_buffer_bytes += batch.asset.buffer_bytes;
                    batch_source_buffer_bytes += batch.asset.source_buffer_bytes;
                }
                batch_count += 1;
                for range in &batch.ranges {
                    if !range.id.is_empty() {
                        batched_parts += 1;
                    }
                    mapped_vertices += (range.vertices.end - range.vertices.start) as usize;
                    mapped_indices += (range.indices.end - range.indices.start) as usize;
                }
                unique.insert(batch.asset.handle.id());
                if let Some(mesh) = meshes.get(&batch.asset.handle) {
                    parts += batch.ranges.len();
                    vertices += mesh.count_vertices();
                    triangles += mesh.indices().map_or(0, |i| i.len() / 3);
                }
            }
            tiers[match root.quality.tier() {
                super::quality::Quality::Low => 0,
                super::quality::Quality::Medium => 1,
                super::quality::Quality::High => 2,
            }] += 1;
            for (_entity, base, geometry) in &root.geometries {
                let count = 1;
                #[cfg(feature = "explicit-instancing")]
                let count = root
                    .instance_parts
                    .get(_entity)
                    .map_or(count, |ids| ids.len());
                // 每几何有效档位：总览根的自定义 Mesh / Box 恒 High，按实际 handle 计数，
                // 不按根 desired 枚举漏计（change: 2026-10-15-add-film-set-overview-lod，design D3/D6）。
                let effective =
                    super::mesh::effective_quality(geometry, root.quality);
                if let Some(handle) = self.shared.lookup(base, geometry, effective) {
                    unique.insert(handle.id());
                    if let Some(mesh) = meshes.get(handle) {
                        parts += count;
                        vertices += mesh.count_vertices() * count;
                        triangles += mesh.indices().map_or(0, |i| i.len() / 3) * count;
                    }
                }
            }
        }
        let unique_vertices: usize = unique
            .iter()
            .filter_map(|id| meshes.get(*id))
            .map(Mesh::count_vertices)
            .sum();
        let unique_triangles: usize = unique
            .iter()
            .filter_map(|id| meshes.get(*id))
            .map(|m| m.indices().map_or(0, |i| i.len() / 3))
            .sum();
        let retained = self.shared.counts();
        let mut value = serde_json::json!({
            "qualityVersion": super::quality::QUALITY_VERSION,
            "staticBatchStrategy": self.batching_strategy.name(),
            "roots": self.roots.len(), "parts": parts,
            "resourceOwnership": {
                "scope": "unique-assets-per-root-or-frozen-capture",
                "consumers": self.mesh_references.consumers(),
                "meshAssets": self.mesh_references.assets(),
                "meshReferences": self.mesh_references.references(),
                "maxMeshConsumers": self.mesh_references.maximum(),
                "materialAssets": self.material_references.assets(),
                "materialReferences": self.material_references.references(),
                "maxMaterialConsumers": self.material_references.maximum()
            },
            "captureSnapshots": self.capture_retention.len(),
            "captureSnapshotBytes": self.capture_retention.values().map(|r| r.bytes).sum::<usize>(),
            "modelEntities": entities, "staticBatches": batch_count, "batchedParts": batched_parts,
            "batchMappedVertices": mapped_vertices, "batchMappedIndices": mapped_indices,
            "retainedBatchBytes": self.shared.batches.bytes(),
            "peakRetainedBatchBytes": self.shared.batches.peak_retained_bytes,
            "batchCreatedBufferBytes": self.shared.batches.created_buffer_bytes,
            "activeUniqueBatchBufferBytes": batch_buffer_bytes,
            "activeBatchSourceBufferBytes": batch_source_buffer_bytes,
            "low": tiers[0], "medium": tiers[1], "high": tiers[2],
            "instanceVertices": vertices, "instanceTriangles": triangles,
            "uniqueMeshes": unique.len(), "uniqueVertices": unique_vertices,
            "uniqueTriangles": unique_triangles,
            "retainedMeshes": retained.0, "retainedMaterials": retained.1,
            "allMeshAssets": meshes.len(), "allMaterialAssets": materials.len(),
            "retainedMeshBytes": self.shared.bytes(),
            "geometryWork": &self.shared.work,
            "simplification": self.shared.simplification_diagnostics(),
            "batchSourceMeshBuilds": self.shared.batches.source_mesh_builds,
            "batchGeometryWork": &self.shared.batches.work,
            "gpuTime": "unavailable", "presentationTime": "unavailable",
            "gpuUploadBytes": "unavailable", "drawSubmissions": "unavailable"
        });
        value["playback"] = serde_json::json!({
            "statisticsScope": "last-reported resource snapshot; not per-frame drawn triangles",
            "reportedAtMonotonicMs": super::motion_plan::elapsed_ms(),
            "events": self.playback_events,
            "representations": self.roots.iter().map(|(id, root)| serde_json::json!({"nodeId":id,"generation":root.representation_generation,"preparedTargets":root.prepared_targets.len()})).collect::<Vec<_>>()
        });
        value["hotPath"] = serde_json::json!({
            "scope": "cumulative-since-renderer-start; not GPU time",
            "focusVisibilityInserts": self.hot_path.focus_visibility_inserts,
            "focusVisibilitySkips": self.hot_path.focus_visibility_skips,
            "previewLayerInserts": self.hot_path.preview_layer_inserts,
            "previewLayerSkips": self.hot_path.preview_layer_skips,
            "resourceReferenceRebuilds": self.hot_path.resource_reference_rebuilds,
            "resourceReferenceSkips": self.hot_path.resource_reference_skips,
            "previewSpriteInserts": self.hot_path.preview_sprite_inserts,
            "previewSpriteSkips": self.hot_path.preview_sprite_skips,
            "previewPoseInserts": self.hot_path.preview_pose_inserts,
            "previewPoseSkips": self.hot_path.preview_pose_skips
        });
        #[cfg(feature = "explicit-instancing")]
        let value = {
            let mut value = value;
            let groups: usize = self
                .roots
                .values()
                .map(|root| root.instance_parts.len())
                .sum();
            let parts: usize = self
                .roots
                .values()
                .flat_map(|root| root.instance_parts.values())
                .map(|ids| ids.len())
                .sum();
            value["explicitInstances"] = serde_json::json!({"groups": groups, "parts": parts,
                "cpuTransformBytes": parts * super::instancing::INSTANCE_STRIDE});
            value
        };
        value.to_string()
    }
}
