//! 与 ECS 无关的片场准备产物（change: 2026-10-18-prepare-native-film-sets-in-background，
//! design D2 / 任务 1.1–1.3）。
//!
//! 这里只读取不可变 [`ModelSnapshot`]，产出可跨线程转移的 CPU 数据：规范部件 specs、
//! material 描述与共享 cache key、既有合批计划结果、CPU Mesh、局部 AABB、原部件到批次范围映射。
//! **不**访问 `World` / `Commands` / `Assets` / TLS bridge，也不登记任何 Handle 或 Entity。
//!
//! 同步创建入口（`spawn`）与后台准备共用同一批纯函数（`scene::build_entity_specs`、
//! `batching::plan/build`、`mesh::build_mesh_quality`、`mesh::effective_quality`），因此两条路径
//! 的几何、部件范围与局部变换等价；差异只在于宿主线程何时登记资源、何时建实体。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use bevy::platform::time::Instant;
use bevy::prelude::*;

use crate::protocol::ModelSnapshot;

use super::super::animation::TransformAnimationKind;
use super::super::batch_cache::BatchSource;
use super::super::batch_strategy::BatchStrategy;
use super::super::batching::{self, BuiltBatch};
use super::super::mesh;
use super::super::quality::Quality;
use super::super::scene::{self, ModelGeometry};

/// 单个非批次部件的 CPU 产物。
pub(super) struct PreparedPart {
    pub(super) id: String,
    pub(super) parent: Option<String>,
    pub(super) transform: Transform,
    pub(super) material_key: String,
    /// 共享 geometry（缓存冲突时用精确相等校验）。
    pub(super) geometry: Option<Arc<ModelGeometry>>,
    /// 稳定的 mesh base key；后台算好，宿主不再展开或哈希全几何。
    pub(super) base: String,
    /// 该几何的**有效**档位（`mesh::effective_quality`）。
    pub(super) effective: Quality,
    /// 组部件（无几何）为 `None`；其余为构建好的 CPU 网格（宿主首次登记时移入 `Assets`）。
    pub(super) mesh: Option<Mesh>,
    pub(super) bytes: usize,
    /// 挂在该部件上的动画（发布时才写组件）。
    pub(super) animation: Option<TransformAnimationKind>,
}

/// 一条合批计划（沿用既有分桶算法）及其 CPU 网格。
pub(super) struct PreparedBatch {
    pub(super) material_key: String,
    pub(super) parent: Option<String>,
    /// 既有 `BatchCache` 的精确身份（含完整几何文本哈希，后台构建一次）。
    pub(super) source: Arc<BatchSource>,
    /// 该批次的有效请求档位（`plan` 内每几何有效档位的最小值）。
    pub(super) quality: Quality,
    /// 已构建的 CPU 批次；同一产物可能被多个实例登记，因此按需取走一次
    /// （`Assets` 只登记一份，其余实例直接命中共享缓存）。
    built: Mutex<Option<BuiltBatch>>,
    pub(super) bytes: usize,
}

/// material 描述 + 共享 cache key（`material-v1:{Debug}`，后台算一次）。
pub(super) struct PreparedMaterial {
    pub(super) cache_key: String,
    pub(super) material: StandardMaterial,
}

/// 一个根的全部准备产物；**实例无关**，可被同内容多实例共享。
pub(super) struct PreparedModel {
    /// 不可变规范快照（发布后由 `ModelRoot` 保活）。
    pub(super) resource: Arc<ModelSnapshot>,
    pub(super) content_signature: String,
    pub(super) quality: Quality,
    pub(super) overview: bool,
    pub(super) batched: bool,
    pub(super) parts: Vec<PreparedPart>,
    pub(super) batches: Vec<PreparedBatch>,
    pub(super) materials: Vec<PreparedMaterial>,
    /// `material_key` → `materials` 下标（宿主 O(1) 取描述，不重新展开 specs）。
    pub(super) material_index: HashMap<String, usize>,
    /// 批次内被合并的部件总数（映射工作量与诊断用）。
    pub(super) batched_part_count: usize,
    /// 该产物当前保活的 CPU 缓冲字节（mesh + 批次源文本），用于工作额度记账。
    pub(super) bytes: usize,
    pub(super) parts_ms: f64,
    pub(super) batches_ms: f64,
}

impl PreparedBatch {
    /// 取走首次登记的 CPU 网格；已被登记过则返回 `None`（调用方改用共享缓存）。
    pub(super) fn take_built(&self) -> Option<BuiltBatch> {
        self.built.lock().ok().and_then(|mut slot| slot.take())
    }
}

/// 准备失败原因；返回明确状态，不回退宿主线程同步生成。
///
/// 目前只有一种可恢复失败：单次 primitive/mesh 构建返回非法几何。额度不足在调度阶段就
/// 明确拒绝（`rejected`），不会进入后台，也不会退回宿主线程同步创建。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(super) enum PrepareFailure {
    /// CPU 网格构建失败（几何非法或顶点预算超限）。
    Geometry,
}

impl PrepareFailure {
    /// 稳定诊断标签（不暴露内部结构）。
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Geometry => "geometry",
        }
    }
}

/// 输入规模估算：几何顶点/面与规格文本量级，用于启动前预留 CPU 工作额度。
pub(super) fn estimate(model: &ModelSnapshot) -> usize {
    let mut bytes = model.signature.len() + 4096;
    for op in &model.ops {
        bytes += match op {
            crate::protocol::ModelOp::Mesh { vertices, faces, normals, uvs, colors, .. } => {
                vertices.len() * 12
                    + faces.len() * 12
                    + normals.as_ref().map_or(0, |values| values.len() * 12)
                    + uvs.as_ref().map_or(0, |values| values.len() * 8)
                    + colors.as_ref().map_or(0, |values| values.len() * 16)
                    + 64
            }
            _ => 96,
        };
    }
    bytes
}

/// 纯准备：部件展开、既有合批规划、CPU 网格与 bounds、material 描述。
///
/// `quality` 是根目标档位；每几何有效档位仍经 `mesh::effective_quality` 统一解析，
/// 片场的 Box / 自定义 Mesh 保持原始几何（不新增简化任务）。
pub(super) fn prepare(
    model: &Arc<ModelSnapshot>,
    quality: Quality,
    batched: bool,
    strategy: BatchStrategy,
    overview: bool,
) -> Result<PreparedModel, PrepareFailure> {
    let mut specs = scene::build_entity_specs(model);
    let material_specs = scene::collect_materials(model);
    let opaque: HashSet<String> = specs
        .iter()
        .filter(|spec| {
            scene::standard_material_for(&spec.material_key, &material_specs).alpha_mode
                == bevy::material::AlphaMode::Opaque
        })
        .map(|spec| spec.material_key.clone())
        .collect();

    let parts_started = Instant::now();
    // 1) 既有合批规划：与同步创建同一算法、同一输入。
    // 总览片场把只做平移的父级分组平铺到根空间，按材质合并批次（draw call 优化）。
    let plans = if batched && strategy == BatchStrategy::Spatial {
        let planned = batching::plan(
            &specs,
            &opaque,
            &Default::default(),
            overview,
            &std::collections::HashSet::new(),
        );
        batching::apply_flatten(&mut specs, &planned.flatten);
        planned.plans
    } else {
        Vec::new()
    };
    let mut batches = Vec::with_capacity(plans.len());
    let mut batched_parts = HashSet::new();
    let mut batch_bytes = 0usize;
    let batches_started = Instant::now();
    for plan in plans {
        let source = Arc::new(BatchSource::new(
            plan.parts
                .iter()
                .map(|&index| specs[index].clone())
                .collect(),
        ));
        // 纯盒批次各档几何相同：以有效档位下限请求，复用同一表示
        // （change: 2026-10-15-add-film-set-overview-lod，design D3）。
        let batch_quality = plan
            .parts
            .iter()
            .filter_map(|&index| specs[index].geometry.as_ref())
            .map(|geometry| mesh::effective_quality(geometry, quality, overview))
            .min()
            .unwrap_or(quality);
        let Some(built) = batching::build(
            &batching::BatchPlan {
                parent: None,
                material: String::new(),
                parts: (0..source.specs.len()).collect(),
            },
            &source.specs,
            batch_quality,
        ) else {
            // 与同步创建一致：构建失败只跳过该批次，其余表示照常发布；
            // 单批次失败的诊断由调用方按 `skipped` 计数。
            continue;
        };
        let bytes = built.mesh.get_vertex_buffer_size()
            + built.mesh.indices().map_or(0, |indices| indices.len() * 4);
        batch_bytes += bytes + source.identity_bytes();
        batched_parts.extend(plan.parts.iter().copied());
        batches.push(PreparedBatch {
            material_key: plan.material,
            parent: plan.parent,
            source,
            quality: batch_quality,
            built: Mutex::new(Some(built)),
            bytes,
        });
    }
    let batches_ms = batches_started.elapsed().as_secs_f64() * 1000.0;

    // 2) 未合批部件：与同步创建相同的 base key / 有效档位 / 网格构建。
    let mut parts = Vec::with_capacity(specs.len());
    let mut part_bytes = 0usize;
    for (spec_index, spec) in specs.iter().enumerate() {
        if batched_parts.contains(&spec_index) {
            continue;
        }
        let base = model
            .geometry_keys
            .as_ref()
            .and_then(|keys| keys.get(spec_index))
            .and_then(Option::as_ref)
            .cloned()
            .unwrap_or_else(|| {
                spec.geometry
                    .as_ref()
                    .map(mesh::mesh_key)
                    .unwrap_or_default()
            });
        // 每几何有效档位：总览根的自定义 Mesh 保持 High，不新增简化任务
        // （change: 2026-10-15-add-film-set-overview-lod，design D3）。
        let effective = spec
            .geometry
            .as_ref()
            .map(|geometry| mesh::effective_quality(geometry, quality, overview))
            .unwrap_or(quality);
        // 自定义 Mesh 的非 High 档位沿用既有别名：底层仍是 High 缓冲，简化任务在宿主
        // 登记时排队（`SharedResources::adopt_mesh`），这里只构建一次 High 网格。
        let build_quality = match &spec.geometry {
            Some(ModelGeometry::Mesh { .. }) if effective != Quality::High => Quality::High,
            _ => effective,
        };
        let (mesh, bytes) = match &spec.geometry {
            None => (None, 0),
            Some(geometry) => {
                let Some(mesh) = mesh::build_mesh_quality(geometry, build_quality) else {
                    // 与同步创建一致：非法几何跳过该部件。
                    continue;
                };
                let bytes = mesh.get_vertex_buffer_size()
                    + mesh.indices().map_or(0, |indices| indices.len() * 4);
                part_bytes += bytes;
                (Some(mesh), bytes)
            }
        };
        parts.push(PreparedPart {
            id: spec.id.clone(),
            parent: spec.parent.clone(),
            transform: Transform {
                translation: Vec3::from_array(spec.position),
                rotation: scene::quat_from_xyz_radians(spec.rotation_radians),
                scale: Vec3::from_array(spec.scale),
            },
            material_key: spec.material_key.clone(),
            geometry: spec.geometry.clone().map(Arc::new),
            base,
            effective,
            mesh,
            bytes,
            animation: spec.animation.as_ref().map(animation_kind),
        });
    }
    let parts_ms = parts_started.elapsed().as_secs_f64() * 1000.0;

    // 3) material 描述：只保留实际被引用的 key，cache key 也在后台算好。
    let mut material_keys: Vec<String> = parts
        .iter()
        .map(|part| part.material_key.clone())
        .chain(batches.iter().map(|batch| batch.material_key.clone()))
        .collect();
    material_keys.sort();
    material_keys.dedup();
    let mut materials = Vec::with_capacity(material_keys.len());
    let mut material_index = HashMap::new();
    for key in material_keys {
        let material = scene::standard_material_for(&key, &material_specs);
        material_index.insert(key, materials.len());
        materials.push(PreparedMaterial {
            cache_key: super::super::resources::material_cache_key(&material),
            material,
        });
    }

    Ok(PreparedModel {
        resource: model.clone(),
        content_signature: model.signature.clone(),
        quality,
        overview,
        batched,
        parts,
        batches,
        materials,
        material_index,
        batched_part_count: batched_parts.len(),
        bytes: part_bytes + batch_bytes,
        parts_ms,
        batches_ms,
    })
}

/// 规范动画描述 → 通用动画种类（与 `spawn::animation_kind_for` 同一映射）。
fn animation_kind(spec: &scene::ModelAnimationSpec) -> TransformAnimationKind {
    use scene::ModelAnimationSpec as Spec;
    match spec {
        Spec::Rotate { axis, speed } => TransformAnimationKind::Rotate {
            axis: *axis,
            speed: *speed,
        },
        Spec::Move { axis, speed, range } => TransformAnimationKind::LoopMove {
            axis: *axis,
            speed: *speed,
            range: *range,
        },
        Spec::Oscillate {
            axis,
            speed,
            mode,
            amplitude,
            phase,
        } => TransformAnimationKind::Oscillate {
            axis: *axis,
            speed: *speed,
            mode: super::super::animation::oscillate_mode(mode),
            amplitude: *amplitude,
            phase: *phase,
        },
    }
}

/// 诊断：产物结构性摘要（不遍历顶点）。
pub(super) fn summary(prepared: &PreparedModel) -> serde_json::Value {
    serde_json::json!({
        "quality": format!("{:?}", prepared.quality),
        "batched": prepared.batched,
        "parts": prepared.parts.len(),
        "batches": prepared.batches.len(),
        "batchedParts": prepared.batched_part_count,
        "materials": prepared.materials.len(),
        "bytes": prepared.bytes,
        "partsMs": prepared.parts_ms,
        "batchesMs": prepared.batches_ms
    })
}
