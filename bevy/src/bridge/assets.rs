//! 不可变模型资源表：注册、LRU 淘汰与 metadata 读取
//! （change: optimize-model-scene-snapshot-hot-path；2026-09-29-move-canvas-hot-paths-to-rust-wasm）。
//!
//! 注册是内容寻址、幂等的；同 key 同内容复用，同 key 不同内容冲突并保留旧值。资源表保留
//! 已派生的 local AABB，使布局/聚焦/picking 不重复遍历 mesh。

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use crate::protocol::{ModelAabbDto, ModelSnapshot, Scene};

/// 不可变模型资源表容量上限（条目数）。超出时按未引用 LRU 淘汰。
pub(crate) const MODEL_ASSET_MAX_ENTRIES: usize = 32;
/// 资源字节预算（估算）；与条目上限共同约束大型 mesh 驻留。
pub(crate) const MODEL_ASSET_MAX_BYTES: usize = 64 * 1024 * 1024;

thread_local! {
    /// 已注册的不可变模型资源（按 resourceKey）。注册是内容寻址、幂等的。
    static MODEL_ASSETS: RefCell<HashMap<String, Arc<ModelSnapshot>>> = RefCell::new(HashMap::new());
    /// 资源 LRU 访问顺序（最旧在前）。
    static MODEL_ASSET_ORDER: RefCell<VecDeque<String>> = const { RefCell::new(VecDeque::new()) };
    /// 最近一次已排队场景引用的 resource key；淘汰时必须保留（否则该帧会缺模型）。
    static SCENE_ASSET_KEYS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// 模型资源注册结果：幂等成功 / 内容冲突。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AssetRegistration {
    /// 新资源已登记，或同 key 同内容已存在（幂等）。
    Ok,
    /// 同 key 携带不同内容（Scene IR / 版本 / 签名不一致）。
    Conflict,
}

/// 注册一份不可变模型资源；同 key 同内容幂等，同 key 不同内容冲突。
///
/// 生产路径走 `queue_model_snapshot`（prepared-and-register 边界）；本入口供单元测试构造。
#[cfg(test)]
pub(crate) fn queue_model_asset(
    descriptor: crate::protocol::ModelAssetDescriptor,
) -> AssetRegistration {
    let key = descriptor.resource_key.clone();
    let signature = descriptor.signature.clone();
    let scene_version = descriptor.scene_version.clone();
    let snapshot = Arc::new(descriptor.into_snapshot());
    insert(key, signature, scene_version, snapshot)
}

/// 注册一份已构造好的快照（prepared-and-register 边界复用）。
pub(crate) fn queue_model_snapshot(
    key: String,
    signature: String,
    scene_version: Option<String>,
    snapshot: Arc<ModelSnapshot>,
) -> AssetRegistration {
    insert(key, signature, scene_version, snapshot)
}

fn insert(
    key: String,
    signature: String,
    scene_version: Option<String>,
    snapshot: Arc<ModelSnapshot>,
) -> AssetRegistration {
    MODEL_ASSETS.with(|resources| {
        let mut table = resources.borrow_mut();
        if let Some(existing) = table.get(&key) {
            let same = existing.signature == signature && existing.scene_version == scene_version;
            if !same {
                return AssetRegistration::Conflict;
            }
            touch_asset(&key);
            return AssetRegistration::Ok;
        }
        table.insert(key.clone(), snapshot);
        touch_asset(&key);
        evict_assets(&mut table);
        AssetRegistration::Ok
    })
}

/// 记录一次资源访问（移到 LRU 队尾）。
fn touch_asset(key: &str) {
    MODEL_ASSET_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        if let Some(index) = order.iter().position(|entry| entry == key) {
            order.remove(index);
        }
        order.push_back(key.to_owned());
    });
}

/// 超出计数/字节预算时淘汰**未被最近场景引用**的最旧资源。
fn evict_assets(table: &mut HashMap<String, Arc<ModelSnapshot>>) {
    let protected = SCENE_ASSET_KEYS.with(|keys| keys.borrow().clone());
    let mut total: usize = table.values().map(|snapshot| approx_bytes(snapshot)).sum();
    MODEL_ASSET_ORDER.with(|order| {
        let mut order = order.borrow_mut();
        while table.len() > MODEL_ASSET_MAX_ENTRIES || total > MODEL_ASSET_MAX_BYTES {
            let Some(index) = order
                .iter()
                .position(|key| table.contains_key(key) && !protected.contains(key))
            else {
                break;
            };
            let key = order.remove(index).expect("index in range");
            if let Some(removed) = table.remove(&key) {
                total = total.saturating_sub(approx_bytes(&removed));
            }
        }
    });
}

/// 估算资源驻留字节（mesh 顶点/面与 op 数量的线性近似）。
fn approx_bytes(snapshot: &ModelSnapshot) -> usize {
    use crate::protocol::ModelOp;
    let mut total = 256;
    for op in &snapshot.ops {
        total += 64;
        match op {
            ModelOp::Mesh {
                vertices, faces, ..
            } => {
                total += vertices.len() * 12 + faces.len() * 12;
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

/// 是否已注册某 resource key。
#[cfg(test)]
pub(crate) fn model_asset_registered(key: &str) -> bool {
    MODEL_ASSETS.with(|resources| resources.borrow().contains_key(key))
}

/// 读取已注册模型资源的 `Arc`（pick 候选派生用）。
pub(crate) fn lookup_model_asset(key: &str) -> Option<Arc<ModelSnapshot>> {
    MODEL_ASSETS.with(|resources| resources.borrow().get(key).cloned())
}

/// 读取已注册资源的内容 metadata（用于同 identity 复用，避免重复 AABB 遍历）。
pub(crate) fn existing_model_metadata(
    key: &str,
) -> Option<(String, Option<String>, f32, Option<ModelAabbDto>)> {
    MODEL_ASSETS.with(|resources| {
        resources.borrow().get(key).map(|snapshot| {
            (
                snapshot.signature.clone(),
                snapshot.scene_version.clone(),
                snapshot.extent,
                snapshot.aabb,
            )
        })
    })
}

/// 浅拷贝当前资源表（`Arc` 指针复制，成本与 mesh 大小无关）。
pub(crate) fn model_assets_snapshot() -> HashMap<String, Arc<ModelSnapshot>> {
    MODEL_ASSETS.with(|resources| resources.borrow().clone())
}

/// 清空资源表（测试 / 运行时代际重放前）。
#[cfg(test)]
pub(crate) fn clear_model_assets() {
    MODEL_ASSETS.with(|resources| resources.borrow_mut().clear());
    MODEL_ASSET_ORDER.with(|order| order.borrow_mut().clear());
    SCENE_ASSET_KEYS.with(|keys| keys.borrow_mut().clear());
}

/// 场景引用的模型资源是否全部已注册；缺失返回缺的 key。
pub(crate) fn missing_model_asset(scene: &Scene) -> Option<String> {
    MODEL_ASSETS.with(|resources| {
        let table = resources.borrow();
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

/// 记录当前待渲染场景引用的 resource key（淘汰保护）。
pub(crate) fn set_scene_asset_keys(keys: HashSet<String>) {
    SCENE_ASSET_KEYS.with(|slot| *slot.borrow_mut() = keys);
    MODEL_ASSETS.with(|resources| evict_assets(&mut resources.borrow_mut()));
}

/// Protect the incoming scene before its resources are registered. Keep the accepted
/// scene protected until replacement succeeds, and report cache entries lost to LRU.
pub(crate) fn prepare_scene_resources(keys: HashSet<String>) -> Vec<String> {
    SCENE_ASSET_KEYS.with(|slot| slot.borrow_mut().extend(keys.iter().cloned()));
    MODEL_ASSETS.with(|resources| {
        let table = resources.borrow();
        keys.into_iter().filter(|key| !table.contains_key(key)).collect()
    })
}
