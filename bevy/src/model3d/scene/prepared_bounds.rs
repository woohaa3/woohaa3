//! Immutable per-part bounds. Runtime placement queries never copy or scan mesh arrays.
//!
//! 片场的镜头预览与相机标记会查询同一棵模型的子树包围盒。父子关系在准备期解析成下标，
//! 覆盖项按部件下标排序后二分，求值不再逐部件做字符串哈希。未变的查询共享缓存结果，
//! 避免静止帧仍重建层级哈希表、遍历整场部件。
use super::{ModelAabb, ModelEntitySpec, aabb::geometry_half_extents_and_center};
use crate::protocol::{ModelOp, ModelPlacement, ModelSkin, ModelSnapshot};
use bevy::prelude::*;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug)]
struct Part {
    id: String,
    /// 父部件在 `parts` 里的下标；构造期解析一次，求值期零哈希。
    parent: Option<u32>,
    /// 完整仿射局部矩阵（不重建 TRS，避免丢剪切）。
    local: Mat4,
    geometry: Option<ModelAabb>,
    /// 蒙皮变形数据：绑定 AABB 不是实际形状，必须按 FK/LBS 求值。
    skin: Option<SkinPart>,
    /// 姿势场景的精确形状：稀疏 mesh 只取引用顶点，解析体按 TS 同一公式求包围。
    accurate: Option<AccurateShape>,
}

#[derive(Clone, Debug)]
enum AccurateShape {
    /// 被面引用的顶点（重复的姿势场景求值只变换这些点，不套 AABB 角）。
    Points(Vec<[f32; 3]>),
    Sphere { radius: f32 },
    Cylinder { radius: f32, half_y: f32 },
    Capsule { radius: f32, half_y: f32 },
}

impl AccurateShape {
    fn bounds(&self, matrix: &Mat4) -> ModelAabb {
        let rows = [
            Vec3::new(matrix.x_axis.x, matrix.y_axis.x, matrix.z_axis.x),
            Vec3::new(matrix.x_axis.y, matrix.y_axis.y, matrix.z_axis.y),
            Vec3::new(matrix.x_axis.z, matrix.y_axis.z, matrix.z_axis.z),
        ];
        let center = matrix.transform_point3(Vec3::ZERO);
        let (min, max) = match self {
            Self::Points(points) => {
                let mut min = Vec3::splat(f32::INFINITY);
                let mut max = Vec3::splat(f32::NEG_INFINITY);
                for point in points {
                    let world = matrix.transform_point3(Vec3::from_array(*point));
                    min = min.min(world);
                    max = max.max(world);
                }
                (min, max)
            }
            Self::Sphere { radius } => {
                let extent = Vec3::new(
                    radius * rows[0].length(),
                    radius * rows[1].length(),
                    radius * rows[2].length(),
                );
                (center - extent, center + extent)
            }
            Self::Cylinder { radius, half_y } => {
                // 与 TS 同一公式：轴向半径 + 高度半长沿局部 Y。
                let extent = Vec3::new(
                    radius * rows[0].xz().length() + half_y * rows[0].y.abs(),
                    radius * rows[1].xz().length() + half_y * rows[1].y.abs(),
                    radius * rows[2].xz().length() + half_y * rows[2].y.abs(),
                );
                (center - extent, center + extent)
            }
            Self::Capsule { radius, half_y } => {
                let cylinder = (half_y - radius).max(0.0);
                let extent = Vec3::new(
                    radius * rows[0].length() + cylinder * rows[0].y.abs(),
                    radius * rows[1].length() + cylinder * rows[1].y.abs(),
                    radius * rows[2].length() + cylinder * rows[2].y.abs(),
                );
                (center - extent, center + extent)
            }
        };
        ModelAabb::new(min.to_array(), max.to_array())
    }
}

#[derive(Clone, Debug)]
struct SkinPart {
    vertices: Vec<[f32; 3]>,
    /// 只统计被面引用的顶点；未使用顶点不参与实际形状。
    referenced: Vec<usize>,
    /// joint id 已解析为 `parts` 下标。
    joints: Vec<u32>,
    inverse_bind_matrices: Vec<[f32; 16]>,
    indices: Vec<Vec<usize>>,
    weights: Vec<Vec<f32>>,
}

impl SkinPart {
    fn bounds(&self, worlds: &[Option<Mat4>]) -> Option<ModelAabb> {
        let matrices: Option<Vec<Mat4>> = self
            .joints
            .iter()
            .enumerate()
            .map(|(index, joint)| {
                let world = worlds.get(*joint as usize).copied().flatten()?;
                let inverse = self.inverse_bind_matrices.get(index)?;
                Some(world * Mat4::from_cols_array(inverse))
            })
            .collect();
        let matrices = matrices?;
        let (min, max) = super::super::pose_math::deformed_bounds_indices(
            &self.vertices,
            &self.referenced,
            &self.indices,
            &self.weights,
            &matrices,
        )?;
        Some(ModelAabb::new(min, max))
    }
}

/// 单槽记忆：`(输入指纹, 结果)`。片场每帧会被多个消费者（归属线、镜头适配、拍摄镜头标记）
/// 各求一次整棵子树的包围盒，输入却常常完全没变。结果随不可变模型资源一起回收，
/// 不积累历次摆放或根集合的缓存。
#[derive(Debug, Default)]
struct Memo<T> {
    slot: Mutex<Option<(u64, T)>>,
}

impl<T: Copy> Memo<T> {
    fn read(&self, key: u64) -> Option<T> {
        let slot = self.slot.lock().ok()?;
        match slot.as_ref() {
            Some((stored, value)) if *stored == key => Some(*value),
            _ => None,
        }
    }
}

impl<T> Memo<T> {
    fn write(&self, key: u64, value: T) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some((key, value));
        }
    }
}

impl<T: Clone> Memo<T> {
    fn read_cloned(&self, key: u64) -> Option<T> {
        let slot = self.slot.lock().ok()?;
        match slot.as_ref() {
            Some((stored, value)) if *stored == key => Some(value.clone()),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(crate) struct PreparedBounds {
    parts: Vec<Part>,
    /// 模型是否声明了 group.pose；无姿势时保留原快速路径。
    posed: bool,
    /// `id → 下标`。只用于构造期解析父链，以及每次求值时定位少量根/覆盖项，
    /// 不参与逐部件循环。省下的 `parent: Option<String>` 正好抵消这份映射。
    index: HashMap<String, u32>,
    pub(crate) local: Option<ModelAabb>,
    /// 带 placement 覆盖的整模型局部包围盒；键是覆盖项指纹（见 `placement_key`）。
    placed_local_memo: Memo<Option<ModelAabb>>,
    /// 按目标根聚合的子树包围盒；键是（覆盖项指纹, 根集合指纹）。
    subtree_memo: Memo<Vec<(String, ModelAabb)>>,
}

impl PreparedBounds {
    pub(super) fn new(specs: &[ModelEntitySpec], model: &ModelSnapshot) -> Self {
        let posed = model
            .ops
            .iter()
            .any(|op| matches!(op, ModelOp::Group { pose: Some(_), .. }));
        // 蒙皮网格按 `id` 取回绑定数据：绑定 AABB 不是静态姿势下的实际形状。
        let skins: HashMap<&str, &ModelSkin> = model
            .ops
            .iter()
            .filter_map(|op| match op {
                ModelOp::Mesh {
                    id,
                    skin: Some(skin),
                    ..
                } => Some((id.as_str(), skin)),
                _ => None,
            })
            .collect();
        let mut parts: Vec<Part> = specs
            .iter()
            .map(|spec| {
                let geometry = spec.geometry.as_ref().map(|geometry| {
                    let (half, center) = geometry_half_extents_and_center(geometry);
                    ModelAabb::new(
                        std::array::from_fn(|axis| center[axis] - half[axis]),
                        std::array::from_fn(|axis| center[axis] + half[axis]),
                    )
                });
                Part {
                    id: spec.id.clone(),
                    parent: None,
                    local: spec.static_transform().to_matrix(),
                    geometry,
                    skin: None,
                    accurate: None,
                }
            })
            .collect();
        // 重复 id 保持"先出现者为准"：与旧实现按处理顺序写入 `worlds` 的语义一致。
        let mut index: HashMap<String, u32> = HashMap::with_capacity(parts.len());
        for (offset, part) in parts.iter().enumerate() {
            index.entry(part.id.clone()).or_insert(offset as u32);
        }
        for (part, spec) in parts.iter_mut().zip(specs) {
            part.parent = spec.parent.as_deref().and_then(|id| index.get(id).copied());
            if posed {
                part.accurate = accurate_shape(spec);
            }
            let Some(skin) = skins.get(spec.id.as_str()) else { continue };
            // 绑定/无姿势路径保留原行为：蒙皮网格用几何顶点 AABB，不做 LBS。
            if !posed {
                continue;
            }
            let Some((vertices, referenced)) =
                spec.geometry.as_ref().and_then(|geometry| match geometry {
                    super::ModelGeometry::Mesh {
                        vertices, faces, ..
                    } => {
                        let mut referenced: Vec<usize> = faces
                            .iter()
                            .flatten()
                            .filter_map(|index| {
                                ((*index as usize) < vertices.len()).then_some(*index as usize)
                            })
                            .collect();
                        referenced.sort_unstable();
                        referenced.dedup();
                        if referenced.is_empty() {
                            referenced.extend(0..vertices.len());
                        }
                        Some((vertices.clone(), referenced))
                    }
                    _ => None,
                })
            else {
                continue;
            };
            let joints: Option<Vec<u32>> = skin
                .joint_ids
                .iter()
                .map(|id| index.get(id.as_str()).copied())
                .collect();
            let Some(joints) = joints else { continue };
            part.skin = Some(SkinPart {
                vertices,
                referenced,
                joints,
                inverse_bind_matrices: skin.inverse_bind_matrices.clone(),
                indices: skin.indices.clone(),
                weights: skin.weights.clone(),
            });
        }
        let local = union_of(evaluate(&parts, &[], posed));
        Self {
            parts,
            posed,
            index,
            local,
            placed_local_memo: Memo::default(),
            subtree_memo: Memo::default(),
        }
    }

    pub(crate) fn for_model(model: &ModelSnapshot) -> Arc<Self> {
        model
            .prepared_bounds
            .clone()
            .unwrap_or_else(|| {
                Arc::new(Self::new(&super::build_entity_specs(model), model))
            })
    }

    pub(crate) fn placed_local(&self, bases: &HashMap<String, Transform>) -> Option<ModelAabb> {
        if bases.is_empty() {
            return self.local;
        }
        union_of(evaluate(
            &self.parts,
            &self.base_overrides(bases),
            self.posed,
        ))
    }

    pub(crate) fn bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.parts.capacity() * std::mem::size_of::<Part>()
            + self
                .parts
                .iter()
                .map(|part| {
                    let points = match &part.accurate {
                        Some(AccurateShape::Points(points)) => points.capacity() * std::mem::size_of::<[f32; 3]>(),
                        _ => 0,
                    };
                    let skin = part.skin.as_ref().map_or(0, |skin| {
                        skin.vertices.capacity() * std::mem::size_of::<[f32; 3]>()
                            + skin.referenced.capacity() * std::mem::size_of::<usize>()
                            + skin.joints.capacity() * std::mem::size_of::<u32>()
                            + skin.inverse_bind_matrices.capacity() * std::mem::size_of::<[f32; 16]>()
                            + skin.indices.capacity() * std::mem::size_of::<Vec<usize>>()
                            + skin.indices.iter().map(|row| row.capacity() * std::mem::size_of::<usize>()).sum::<usize>()
                            + skin.weights.capacity() * std::mem::size_of::<Vec<f32>>()
                            + skin.weights.iter().map(|row| row.capacity() * std::mem::size_of::<f32>()).sum::<usize>()
                    });
                    part.id.capacity() + points + skin
                })
                .sum::<usize>()
            + self
                .index
                .keys()
                .map(|id| id.capacity() + std::mem::size_of::<u32>())
                .sum::<usize>()
    }

    /// 协议 placement 覆盖项（只对无几何的分组节点生效，由 `evaluate` 判断）。
    fn protocol_overrides(
        &self,
        placements: Option<&HashMap<String, ModelPlacement>>,
    ) -> Overrides {
        let Some(placements) = placements else {
            return Overrides::new();
        };
        let mut slots: Overrides = placements
            .iter()
            .filter_map(|(id, placement)| {
                let slot = *self.index.get(id.as_str())?;
                Some((
                    slot,
                    Transform {
                        translation: Vec3::new(
                            placement.offset.x,
                            placement.offset.y,
                            placement.offset.z,
                        ),
                        rotation: Quat::from_rotation_y(placement.yaw.to_radians()),
                        scale: Vec3::splat(placement.scale),
                    },
                ))
            })
            .collect();
        slots.sort_unstable_by_key(|(slot, _)| *slot);
        slots
    }

    fn base_overrides(&self, bases: &HashMap<String, Transform>) -> Overrides {
        let mut slots: Overrides = bases
            .iter()
            .filter_map(|(id, transform)| Some((*self.index.get(id.as_str())?, *transform)))
            .collect();
        slots.sort_unstable_by_key(|(slot, _)| *slot);
        slots
    }
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn fnv_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

fn fnv_f32(hash: u64, value: f32) -> u64 {
    fnv_bytes(hash, &value.to_bits().to_le_bytes())
}

/// 覆盖项指纹：与 map 迭代顺序无关（逐项哈希后求和），因此每帧重建的 `HashMap` 迭代顺序
/// 不会造成假失效。条目只有个位数到几十项，成本远低于一次整树求值。
fn placement_key(placements: Option<&HashMap<String, ModelPlacement>>) -> u64 {
    let Some(placements) = placements else {
        return FNV_OFFSET;
    };
    let mut accumulator = 0u64;
    for (id, placement) in placements {
        let mut entry = fnv_bytes(FNV_OFFSET, id.as_bytes());
        entry = fnv_f32(entry, placement.offset.x);
        entry = fnv_f32(entry, placement.offset.y);
        entry = fnv_f32(entry, placement.offset.z);
        entry = fnv_f32(entry, placement.yaw);
        entry = fnv_f32(entry, placement.scale);
        accumulator = accumulator.wrapping_add(entry);
    }
    fnv_bytes(FNV_OFFSET, &(placements.len() as u64).to_le_bytes()) ^ accumulator
}

/// 目标根集合指纹：同样与顺序无关（根是集合，重复项不影响结果）。
fn roots_key(roots: &[String]) -> u64 {
    let mut accumulator = 0u64;
    for root in roots {
        accumulator = accumulator.wrapping_add(fnv_bytes(FNV_OFFSET, root.as_bytes()));
    }
    fnv_bytes(FNV_OFFSET, &(roots.len() as u64).to_le_bytes()) ^ accumulator
}

/// 覆盖项：`(部件下标, 覆盖 transform)`，按下标升序。协议与基座覆盖都只涉及少量分组节点，
/// 因此不构造与部件数等长的稠密数组。
type Overrides = Vec<(u32, Transform)>;

fn override_at(overrides: &[(u32, Transform)], offset: usize) -> Option<Transform> {
    overrides
        .binary_search_by_key(&(offset as u32), |(slot, _)| *slot)
        .ok()
        .map(|at| overrides[at].1)
}

/// 解析后的部件拓扑：按 `parts` 顺序推进世界变换，返回 `(部件下标, 世界包围盒)`。
fn evaluate(parts: &[Part], overrides: &[(u32, Transform)], posed: bool) -> Vec<(usize, ModelAabb)> {
    let mut worlds: Vec<Option<Mat4>> = Vec::with_capacity(parts.len());
    for (offset, part) in parts.iter().enumerate() {
        // The original placement adapter only overrides group operations.
        let local = override_at(overrides, offset)
            .filter(|_| part.geometry.is_none())
            .map(|transform| transform.to_matrix())
            .unwrap_or(part.local);
        let world = part
            .parent
            .and_then(|parent| worlds.get(parent as usize).copied().flatten())
            .map_or(local, |parent| parent * local);
        worlds.push(Some(world));
    }
    // 第二遍：蒙皮部件按 FK/LBS 求真实形状（绑定 AABB 只是绑定姿态下的近似）。
    let mut bounds = Vec::new();
    for (offset, part) in parts.iter().enumerate() {
        let Some(world) = worlds.get(offset).copied().flatten() else {
            continue;
        };
        if posed {
            if let Some(bounds_) = part.skin.as_ref().and_then(|skin| skin.bounds(&worlds)) {
                bounds.push((offset, bounds_));
                continue;
            }
            if let Some(accurate) = &part.accurate {
                bounds.push((offset, accurate.bounds(&world)));
                continue;
            }
        }
        if let Some(geometry) = part.geometry {
            bounds.push((offset, geometry.transformed_matrix(&world)));
        }
    }
    bounds
}

/// 姿势场景的精确形状声明；与 TS `evaluateModelPoseGeometry` 使用同一分类。
fn accurate_shape(spec: &ModelEntitySpec) -> Option<AccurateShape> {
    match spec.geometry.as_ref()? {
        super::ModelGeometry::Mesh { vertices, faces, .. } => {
            let mut referenced: Vec<usize> = faces
                .iter()
                .flatten()
                .filter_map(|index| ((*index as usize) < vertices.len()).then_some(*index as usize))
                .collect();
            referenced.sort_unstable();
            referenced.dedup();
            if referenced.is_empty() {
                referenced.extend(0..vertices.len());
            }
            Some(AccurateShape::Points(
                referenced.into_iter().map(|index| vertices[index]).collect(),
            ))
        }
        super::ModelGeometry::Sphere { radius } => Some(AccurateShape::Sphere {
            radius: radius.abs(),
        }),
        super::ModelGeometry::Cylinder { radius, height } => Some(AccurateShape::Cylinder {
            radius: radius.abs(),
            half_y: height.abs() * 0.5,
        }),
        super::ModelGeometry::Capsule { radius, height } => Some(AccurateShape::Capsule {
            radius: radius.abs(),
            half_y: height.abs() * 0.5,
        }),
        super::ModelGeometry::Box { .. } => None,
    }
}

fn union_of(bounds: Vec<(usize, ModelAabb)>) -> Option<ModelAabb> {
    bounds
        .into_iter()
        .map(|(_, bounds)| bounds)
        .reduce(ModelAabb::union)
}

fn prepared(model: &ModelSnapshot) -> Arc<PreparedBounds> {
    // `Arc` 借用：`model.prepared_bounds` 已就绪时不复制，缺失时才按实体规格临时构造，
    // 与旧实现 `parts(model)` 的借用/临时语义一致。
    PreparedBounds::for_model(model)
}

pub(crate) fn placed_local_aabb(
    model: &ModelSnapshot,
    placements: Option<&HashMap<String, ModelPlacement>>,
) -> Option<ModelAabb> {
    let prepared = prepared(model);
    if placements.is_none_or(HashMap::is_empty) {
        return prepared.local;
    }
    let key = placement_key(placements);
    if let Some(cached) = prepared.placed_local_memo.read(key) {
        return cached;
    }
    let value = union_of(evaluate(
        &prepared.parts,
        &prepared.protocol_overrides(placements),
        prepared.posed,
    ));
    prepared.placed_local_memo.write(key, value);
    value
}

pub(crate) fn placed_subtree_aabbs(
    model: &ModelSnapshot,
    roots: &[String],
    placements: Option<&HashMap<String, ModelPlacement>>,
) -> Vec<(String, ModelAabb)> {
    placed_subtree_aabbs_counted(model, roots, placements).0
}

/// Same derivation as [`placed_subtree_aabbs`], additionally reporting how many part bounds the
/// evaluation actually visited (`evaluate` output length).
///
/// change: 2026-10-14-scope-film-set-object-picking-to-focus，任务 3.1 —— 只供内部对象候选的
/// 诊断边界消费；计数取自真实求值结果，不额外遍历、不引入第二次 `evaluate`。
pub(crate) fn placed_subtree_aabbs_counted(
    model: &ModelSnapshot,
    roots: &[String],
    placements: Option<&HashMap<String, ModelPlacement>>,
) -> (Vec<(String, ModelAabb)>, usize) {
    if roots.is_empty() {
        return (Vec::new(), 0);
    }
    let prepared = prepared(model);
    let parts = &prepared.parts;
    let memo_key = placement_key(placements) ^ roots_key(roots).rotate_left(17);
    if let Some(cached) = prepared.subtree_memo.read_cloned(memo_key) {
        // 复用的是结果，不是上次求值的工作量：命中时没有遍历部件。
        return (cached, 0);
    }
    // 目标根 → 下标（去重）：之后逐部件判断与归属解析全走下标，不再比较/取哈希字符串。
    let mut is_root = vec![false; parts.len()];
    for root in roots {
        if let Some(slot) = prepared.index.get(root.as_str()) {
            is_root[*slot as usize] = true;
        }
    }
    // 归属解析：`owner` 只对已解析的部件有效（`resolved` 同时记录"已确定无归属"）。
    let mut owner: Vec<Option<u32>> = vec![None; parts.len()];
    let mut resolved = vec![false; parts.len()];
    for offset in 0..parts.len() {
        if resolved[offset] {
            continue;
        }
        let mut chain: Vec<u32> = Vec::new();
        let mut cursor = Some(offset as u32);
        let owner_root = loop {
            let Some(slot) = cursor else {
                break None;
            };
            let at = slot as usize;
            if is_root[at] {
                break Some(slot);
            }
            if resolved[at] {
                break owner[at];
            }
            // Valid prepared hierarchies are acyclic; raw native/test inputs stay bounded.
            if chain.len() >= parts.len() {
                break None;
            }
            chain.push(slot);
            cursor = parts[at].parent;
        };
        for slot in chain {
            resolved[slot as usize] = true;
            owner[slot as usize] = owner_root;
        }
        resolved[offset] = true;
        owner[offset] = owner_root;
    }
    // 计数只在真实求值结果上累加：无几何根不会制造"额外求值"，清空目标不进入本函数。
    let evaluated = evaluate(
        parts,
        &prepared.protocol_overrides(placements),
        prepared.posed,
    );
    let evaluated_parts = evaluated.len();
    let mut aggregated: Vec<(u32, ModelAabb)> = Vec::new();
    for (offset, bounds) in evaluated {
        let Some(root) = owner[offset] else {
            continue;
        };
        match aggregated.iter_mut().find(|(slot, _)| *slot == root) {
            Some((_, value)) => *value = value.union(bounds),
            None => aggregated.push((root, bounds)),
        }
    }
    let mut result = Vec::with_capacity(aggregated.len());
    for (slot, bounds) in aggregated {
        result.push((parts[slot as usize].id.clone(), bounds));
    }
    prepared.subtree_memo.write(memo_key, result.clone());
    (result, evaluated_parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_preview_consumers_do_not_reevaluate_prepared_parts() {
        let mut ops = vec![
            serde_json::json!({"t":"group","id":"left"}),
            serde_json::json!({"t":"group","id":"right","position":[10,0,0]}),
        ];
        for part in 0..2048 {
            ops.push(serde_json::json!({
                "t":"box", "id":format!("part-{part}"),
                "parent":if part % 2 == 0 { "left" } else { "right" },
                "size":[1,2,3]
            }));
        }
        let raw: ModelSnapshot = serde_json::from_value(serde_json::json!({
            "sceneVersion":"woohaa-model-scene-ir-v2", "signature":"preview-reuse",
            "extent":2, "ops":ops
        }))
        .unwrap();
        let model = super::super::prepare_snapshot(raw);
        let roots = vec!["left".to_owned(), "right".to_owned()];
        let (expected, evaluated) = placed_subtree_aabbs_counted(&model, &roots, None);
        assert_eq!(evaluated, 2048);
        assert_eq!(expected.len(), 2);

        // 预览与相机标记共享不可变资源。跨帧、跨消费者复用结果，不把冷求值次数重报为热帧工作。
        let other_consumer = model.clone();
        let reversed = roots.iter().cloned().rev().collect::<Vec<_>>();
        for frame in 0..120 {
            let requested = if frame % 2 == 0 { &roots } else { &reversed };
            let (actual, evaluated) =
                placed_subtree_aabbs_counted(&other_consumer, requested, None);
            assert_eq!(actual, expected);
            assert_eq!(evaluated, 0, "静止帧不得重新遍历整场部件");
        }

        // 根集合变化必须重新聚合；清空目标不触发任何部件求值。
        let (left, evaluated) = placed_subtree_aabbs_counted(&model, &roots[..1], None);
        assert_eq!(evaluated, 2048);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].0, "left");
        assert_eq!(placed_subtree_aabbs_counted(&model, &[], None), (vec![], 0));
    }

    #[test]
    fn replacement_model_does_not_reuse_previous_resource_bounds() {
        let make_model = |size| {
            let raw: ModelSnapshot = serde_json::from_value(serde_json::json!({
                "sceneVersion":"woohaa-model-scene-ir-v2", "signature":format!("size-{size}"),
                "extent":2, "ops":[
                    {"t":"group","id":"root"},
                    {"t":"box","id":"body","parent":"root","size":[size,size,size]}
                ]
            }))
            .unwrap();
            super::super::prepare_snapshot(raw)
        };
        let roots = vec!["root".to_owned()];
        let first = make_model(1);
        let (before, _) = placed_subtree_aabbs_counted(&first, &roots, None);
        assert_eq!(placed_subtree_aabbs_counted(&first, &roots, None).1, 0);

        let replacement = make_model(4);
        let (after, evaluated) = placed_subtree_aabbs_counted(&replacement, &roots, None);
        assert_eq!(evaluated, 1);
        assert_ne!(before, after);
        assert_eq!(
            placed_subtree_aabbs_counted(&replacement, &roots, None),
            (after, 0)
        );
        assert_eq!(
            placed_subtree_aabbs_counted(&first, &roots, None),
            (before, 0)
        );
    }
}
