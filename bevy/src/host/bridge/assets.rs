//! 模型资源表：轻量 descriptor 注册与重型 payload 驻留分离
//! （change: optimize-model-scene-snapshot-hot-path；2026-09-29-move-canvas-hot-paths-to-rust-wasm；
//!  change: 2026-10-23-scale-canvas-media-residency，design D5）。
//!
//! 两张表、两种语义：
//! - **descriptor registry**：内容身份 + signature/sceneVersion/extent/AABB，极轻。场景引用只保护
//!   这些身份，因此 1000 个离屏模型只常驻轻量声明，不阻止重型 IR 淘汰。
//! - **payload cache**：完整 Scene IR（ops）与派生 mesh/bounds。只由**当前需求 lease** 保护；
//!   没有 lease 的条目在计数/字节预算内按 LRU 淘汰，之后按需重新准备。
//!
//! 注册与声明都是内容寻址、幂等的：同 key 同内容复用，同 key 不同内容冲突并保留旧值。
//! 已声明但 payload 未驻留的 key 是**合法 cold** 引用（场景接受、显示 preparing），未声明的
//! key 仍是未知资源，场景稳定拒绝。

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use crate::protocol::{ModelAabbDto, ModelDescriptor, ModelDescriptorDto, ModelSnapshot, Scene};

/// 重型 payload 条目上限（超出时按未被 lease 的 LRU 淘汰）。
///
/// 该预算是**冷缓存**上限：被当前需求 lease 的 payload 不受它限制，因此场景接受点
/// 只需要完整引用集合来保护 descriptor，不会因条目数把正在显示的模型淘汰。
pub(crate) const MODEL_ASSET_MAX_ENTRIES: usize = 32;
/// 重型 payload 字节预算（估算）；与条目上限共同约束大型 mesh 驻留。
pub(crate) const MODEL_ASSET_MAX_BYTES: usize = 64 * 1024 * 1024;
/// 轻量 descriptor 条目上限。descriptor 只有身份与 bounds，不含 ops/mesh，因此上限远高于
/// payload；仍设上界，避免无限增长的文档让注册表无界常驻。
pub(crate) const MODEL_DESCRIPTOR_MAX_ENTRIES: usize = 16_384;

thread_local! {
    /// 已声明的轻量 descriptor（按 resourceKey）。
    static MODEL_DESCRIPTORS: RefCell<HashMap<String, Arc<ModelDescriptor>>> = RefCell::new(HashMap::new());
    /// descriptor LRU 访问顺序（最旧在前）。
    static MODEL_DESCRIPTOR_ORDER: RefCell<VecDeque<String>> = const { RefCell::new(VecDeque::new()) };
    /// 最近一次已排队场景引用的 descriptor key；淘汰时必须保留。
    static SCENE_DESCRIPTOR_KEYS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    /// 已驻留的重型 payload（按 resourceKey）。
    static MODEL_PAYLOADS: RefCell<HashMap<String, Arc<ModelSnapshot>>> = RefCell::new(HashMap::new());
    /// payload LRU 访问顺序（最旧在前）。
    static MODEL_PAYLOAD_ORDER: RefCell<VecDeque<String>> = const { RefCell::new(VecDeque::new()) };
    /// 当前渲染/编辑/捕获需求持有的 payload lease key。只有 lease 能阻止淘汰。
    static MODEL_PAYLOAD_LEASES: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    /// payload 被预算淘汰的累计次数（诊断）。
    static PAYLOAD_EVICTIONS: RefCell<u64> = const { RefCell::new(0) };
}

/// 资源声明/注册结果：幂等成功 / 内容冲突。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AssetRegistration {
    /// 新条目已登记，或同 key 同内容已存在（幂等）。
    Ok,
    /// 同 key 携带不同内容（Scene IR / 版本 / 签名不一致）。
    Conflict,
}

/// 声明一份轻量 descriptor；同 key 同内容幂等，同 key 不同内容冲突。
///
/// 声明**不**表示 payload 已驻留，也不表示模型已可渲染（design D5）。
pub(crate) fn declare_model_descriptor(descriptor: ModelDescriptor) -> AssetRegistration {
    let key = descriptor.resource_key.clone();
    MODEL_DESCRIPTORS.with(|registry| {
        let mut table = registry.borrow_mut();
        if let Some(existing) = table.get(&key) {
            if !existing.same_identity(&descriptor) {
                return AssetRegistration::Conflict;
            }
            touch_descriptor(&key);
            return AssetRegistration::Ok;
        }
        table.insert(key.clone(), Arc::new(descriptor));
        touch_descriptor(&key);
        evict_descriptors(&mut table);
        AssetRegistration::Ok
    })
}

/// 由 wire DTO 声明 descriptor。
pub(crate) fn declare_model_descriptor_dto(
    dto: ModelDescriptorDto,
) -> Result<ModelDescriptor, &'static str> {
    let descriptor = dto.validate()?;
    match declare_model_descriptor(descriptor.clone()) {
        AssetRegistration::Ok => Ok(descriptor),
        AssetRegistration::Conflict => Err("Model resource key conflict"),
    }
}

/// 注册一份已构造好的重型 payload（prepared-and-register 边界复用）。
///
/// 调用方必须先声明 descriptor；payload 注册后立即取得一次 lease（本次需求），
/// 具体存活由 `set_model_payload_leases` 的后续帧需求决定。
pub(crate) fn queue_model_snapshot(
    key: String,
    signature: String,
    scene_version: Option<String>,
    snapshot: Arc<ModelSnapshot>,
) -> AssetRegistration {
    MODEL_PAYLOADS.with(|cache| {
        let mut table = cache.borrow_mut();
        if let Some(existing) = table.get(&key) {
            let same = existing.signature == signature && existing.scene_version == scene_version;
            if !same {
                return AssetRegistration::Conflict;
            }
            touch_payload(&key);
            return AssetRegistration::Ok;
        }
        // 新 payload 先腾出**未被 lease** 的旧条目；lease 内的条目永不因新到者被淘汰。
        evict_payloads(&mut table, Some(&key));
        table.insert(key.clone(), snapshot);
        touch_payload(&key);
        touch_lease(&key);
        evict_payloads(&mut table, None);
        AssetRegistration::Ok
    })
}

/// 注册一份测试用 payload 资源（自动声明 descriptor）。
#[cfg(test)]
pub(crate) fn queue_model_asset(
    descriptor: crate::protocol::ModelAssetDescriptor,
) -> AssetRegistration {
    let key = descriptor.resource_key.clone();
    let signature = descriptor.signature.clone();
    let scene_version = descriptor.scene_version.clone();
    let extent = descriptor.extent;
    let aabb = descriptor.aabb;
    let snapshot = Arc::new(descriptor.into_snapshot());
    let declared = declare_model_descriptor(ModelDescriptor {
        resource_version: crate::protocol::MODEL_DESCRIPTOR_VERSION.to_owned(),
        resource_key: key.clone(),
        scene_version: scene_version.clone(),
        signature: signature.clone(),
        extent,
        aabb,
    });
    if declared == AssetRegistration::Conflict {
        return AssetRegistration::Conflict;
    }
    queue_model_snapshot(key, signature, scene_version, snapshot)
}

/// 记录一次 descriptor 访问（移到 LRU 队尾）。
fn touch_descriptor(key: &str) {
    MODEL_DESCRIPTOR_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        if let Some(index) = order.iter().position(|entry| entry == key) {
            order.remove(index);
        }
        order.push_back(key.to_owned());
    });
}

/// 记录一次 payload 访问（移到 LRU 队尾），并视为本帧需求。
fn touch_payload(key: &str) {
    MODEL_PAYLOAD_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        if let Some(index) = order.iter().position(|entry| entry == key) {
            order.remove(index);
        }
        order.push_back(key.to_owned());
    });
}

fn touch_lease(key: &str) {
    MODEL_PAYLOAD_LEASES.with(|leases| {
        leases.borrow_mut().insert(key.to_owned());
    });
}

/// descriptor 超上限时淘汰**未被最近场景引用**的最旧条目。
fn evict_descriptors(table: &mut HashMap<String, Arc<ModelDescriptor>>) {
    if table.len() <= MODEL_DESCRIPTOR_MAX_ENTRIES {
        return;
    }
    let protected = SCENE_DESCRIPTOR_KEYS.with(|keys| keys.borrow().clone());
    MODEL_DESCRIPTOR_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        while table.len() > MODEL_DESCRIPTOR_MAX_ENTRIES {
            let Some(index) = order
                .iter()
                .position(|key| table.contains_key(key) && !protected.contains(key))
            else {
                break;
            };
            let key = order.remove(index).expect("index in range");
            table.remove(&key);
        }
    });
}

/// payload 超出计数/字节预算时淘汰**未被 lease** 的最旧条目。
fn evict_payloads(
    table: &mut HashMap<String, Arc<ModelSnapshot>>,
    incoming: Option<&str>,
) -> Vec<String> {
    let leased = MODEL_PAYLOAD_LEASES.with(|leases| leases.borrow().clone());
    let mut total: usize = table.values().map(|snapshot| approx_bytes(snapshot)).sum();
    let mut evicted: Vec<String> = Vec::new();
    MODEL_PAYLOAD_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        while table.len() > MODEL_ASSET_MAX_ENTRIES || total > MODEL_ASSET_MAX_BYTES {
            let Some(index) = order.iter().position(|key| {
                table.contains_key(key) && !leased.contains(key) && incoming != Some(key.as_str())
            }) else {
                break;
            };
            let key = order.remove(index).expect("index in range");
            if let Some(removed) = table.remove(&key) {
                total = total.saturating_sub(approx_bytes(&removed));
                evicted.push(key);
            }
        }
    });
    if !evicted.is_empty() {
        let count = evicted.len() as u64;
        PAYLOAD_EVICTIONS.with(|total| *total.borrow_mut() += count);
    }
    evicted
}

/// 估算 payload 驻留字节（mesh 顶点/面与 op 数量的线性近似）。
fn approx_bytes(snapshot: &ModelSnapshot) -> usize {
    use crate::protocol::ModelOp;
    let mut total = 256;
    for op in &snapshot.ops {
        total += 64;
        match op {
            ModelOp::Mesh {
                vertices, faces, skin, ..
            } => {
                total += vertices.len() * 12 + faces.len() * 12;
                if let Some(skin)=skin {total += skin.indices.len()*8*std::mem::size_of::<usize>()+skin.weights.len()*32+skin.inverse_bind_matrices.len()*64+skin.joint_ids.iter().map(String::len).sum::<usize>();}
            }
            ModelOp::Material {
                id,
                base_color,
                emissive,
                ..
            } => {
                total += id.len() + base_color.len() + emissive.len();
            }
            _ => {}
        }
    }
    total
}

/// 是否已声明某 descriptor（无论 payload 是否驻留）。
pub(crate) fn model_descriptor_declared(key: &str) -> bool {
    MODEL_DESCRIPTORS.with(|registry| registry.borrow().contains_key(key))
}

/// 是否已驻留某 payload。
#[cfg(test)]
pub(crate) fn model_asset_registered(key: &str) -> bool {
    MODEL_PAYLOADS.with(|cache| cache.borrow().contains_key(key))
}

/// 读取已驻留的 payload（pick/预览/布局派生用）。`None` 表示 cold/preparing。
pub(crate) fn lookup_model_asset(key: &str) -> Option<Arc<ModelSnapshot>> {
    MODEL_PAYLOADS.with(|cache| cache.borrow().get(key).cloned())
}

/// 读取已声明 descriptor 的内容 metadata（幂等复用，避免重复 AABB 遍历）。
pub(crate) fn existing_model_metadata(
    key: &str,
) -> Option<(String, Option<String>, f32, Option<ModelAabbDto>)> {
    MODEL_DESCRIPTORS.with(|registry| {
        registry.borrow().get(key).map(|descriptor| {
            (
                descriptor.signature.clone(),
                descriptor.scene_version.clone(),
                descriptor.extent,
                descriptor.aabb,
            )
        })
    })
}

/// 浅拷贝当前 payload 表（`Arc` 指针复制，成本与 mesh 大小无关）。
pub(crate) fn model_assets_snapshot() -> HashMap<String, Arc<ModelSnapshot>> {
    MODEL_PAYLOADS.with(|cache| cache.borrow().clone())
}

/// 当前驻留的 payload key 列表（条目上限内，按 key 排序）。
///
/// 诊断与前端账本同步用：payload 可能被**其它**注册调用顺带淘汰，因此调用方不能只凭
/// 「我注册过」判断驻留（design D5）。
pub(crate) fn resident_payload_keys() -> Vec<String> {
    MODEL_PAYLOADS.with(|cache| {
        let mut keys: Vec<String> = cache.borrow().keys().cloned().collect();
        keys.sort();
        keys
    })
}

/// 设置当前需求持有的 payload lease 集合，并立即按预算收敛。
///
/// 返回 `(retained, evicted_keys)`：本帧仍驻留的条目数与本次真正淘汰的 key。
/// lease 是**唯一**阻止 payload 淘汰的依据；场景引用只保护 descriptor（design D5）。
pub(crate) fn set_model_payload_leases(keys: HashSet<String>) -> (usize, Vec<String>) {
    for key in &keys {
        touch_payload(key);
    }
    MODEL_PAYLOAD_LEASES.with(|leases| *leases.borrow_mut() = keys);
    let evicted = MODEL_PAYLOADS.with(|cache| {
        let mut table = cache.borrow_mut();
        evict_payloads(&mut table, None)
    });
    let retained = MODEL_PAYLOADS.with(|cache| cache.borrow().len());
    (retained, evicted)
}

/// 清空两张表与计数（测试 / 运行时代际重建前）。
#[cfg(test)]
pub(crate) fn clear_model_assets() {
    MODEL_DESCRIPTORS.with(|registry| registry.borrow_mut().clear());
    MODEL_DESCRIPTOR_ORDER.with(|order| order.borrow_mut().clear());
    SCENE_DESCRIPTOR_KEYS.with(|keys| keys.borrow_mut().clear());
    MODEL_PAYLOADS.with(|cache| cache.borrow_mut().clear());
    MODEL_PAYLOAD_ORDER.with(|order| order.borrow_mut().clear());
    MODEL_PAYLOAD_LEASES.with(|leases| leases.borrow_mut().clear());
    PAYLOAD_EVICTIONS.with(|count| *count.borrow_mut() = 0);
}

/// 场景引用的 descriptor 是否全部已声明；缺失返回缺的 key。
///
/// 已声明但 payload 未驻留的 key **不是**缺失：那是合法 cold 引用。
pub(crate) fn missing_model_descriptor(scene: &Scene) -> Option<String> {
    MODEL_DESCRIPTORS.with(|registry| {
        let table = registry.borrow();
        for node in &scene.nodes {
            if let Some(reference) = &node.model
                && !table.contains_key(&reference.resource_key)
            {
                return Some(reference.resource_key.clone());
            }
        }
        None
    })
}

/// 记录当前待渲染场景引用的 descriptor key（descriptor 淘汰保护）。
///
/// 注册发生在 `set_scene` 之前，因此注册路径不主动淘汰（否则 >32 个模型的批次会在场景
/// 保护它的 key 之前把自己丢掉）。场景接受点持有**完整**引用集合，是回收空闲 payload 的
/// 唯一安全时机：这里只淘汰未被需求 lease 的条目（design D5）。
pub(crate) fn set_scene_descriptor_keys(keys: HashSet<String>) {
    SCENE_DESCRIPTOR_KEYS.with(|slot| *slot.borrow_mut() = keys);
    MODEL_PAYLOADS.with(|cache| {
        evict_payloads(&mut cache.borrow_mut(), None);
    });
}

/// descriptor / payload 计数快照（诊断；不含内容）。
pub(crate) fn asset_registry_stats() -> AssetRegistryStats {
    let descriptors = MODEL_DESCRIPTORS.with(|registry| registry.borrow().len());
    let (payloads, bytes) = MODEL_PAYLOADS.with(|cache| {
        let table = cache.borrow();
        (
            table.len(),
            table
                .values()
                .map(|snapshot| approx_bytes(snapshot))
                .sum::<usize>(),
        )
    });
    let leased = MODEL_PAYLOAD_LEASES.with(|leases| leases.borrow().len());
    let evictions = PAYLOAD_EVICTIONS.with(|count| *count.borrow());
    AssetRegistryStats {
        descriptors,
        payloads,
        payload_bytes: bytes,
        leased,
        cold: descriptors.saturating_sub(payloads),
        payload_evictions: evictions,
    }
}

/// 资源表统计（诊断）。
pub(crate) struct AssetRegistryStats {
    pub(crate) descriptors: usize,
    pub(crate) payloads: usize,
    pub(crate) payload_bytes: usize,
    pub(crate) leased: usize,
    pub(crate) cold: usize,
    pub(crate) payload_evictions: u64,
}
