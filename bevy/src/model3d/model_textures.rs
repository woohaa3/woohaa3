//! GLB 文件模型的纹理表（change: 2026-10-28-support-glb-model-nodes）。
//!
//! 纹理由浏览器从原始 GLB 解码为 RGBA 后，经既有模型媒体纹理通道
//! （`set_model_media_texture`）上传；本模块按 **内容寻址 id** 创建并共享 `Image`，材质在构建
//! 时按 id 解析句柄。
//!
//! 与画布卡片/片场媒体贴图一样，纹理 id 是稳定内容身份：同一张纹理在多次准备、多个节点之间
//! 只占一份 GPU 资源。资源按 FIFO 上限回收，避免长会话内无界增长。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use bevy::{
    asset::RenderAssetUsages,
    prelude::*,
    render::render_resource::{Extent3d, TextureDimension, TextureFormat},
};

#[cfg(feature = "canvas-core")]
use crate::app::ModelTextureBatch;

/// 模型纹理 id 前缀（前端上传时加在内容 id 前，避免与片场媒体平面 id 冲突）。
pub(crate) const MODEL_TEXTURE_ID_PREFIX: &str = "modeltex:";
/// 同时驻留的模型纹理数量上限。
const MAX_MODEL_TEXTURES: usize = 32;
/// 同时驻留的模型纹理总字节上限（RGBA 解码后）。
const MAX_MODEL_TEXTURE_BYTES: usize = 128 * 1024 * 1024;

struct TextureEntry {
    handle: Handle<Image>,
    bytes: usize,
    order: u64,
}

#[derive(Default)]
struct TextureStore {
    entries: HashMap<String, TextureEntry>,
    order: u64,
    bytes: usize,
    revision: u64,
}

static STORE: OnceLock<Mutex<TextureStore>> = OnceLock::new();

fn store() -> &'static Mutex<TextureStore> {
    STORE.get_or_init(|| Mutex::new(TextureStore::default()))
}

/// 路由前缀只用于把模型纹理与片场媒体平面分开；纹理表按**去掉前缀的内容 id** 存取，
/// 与材质 op 的 `baseColorTexture` 值一致。
fn store_key(id: &str) -> Option<&str> {
    id.strip_prefix(MODEL_TEXTURE_ID_PREFIX).filter(|key| !key.is_empty())
}

/// 按内容 id 取纹理句柄；缺失时材质保持纯色。
pub(crate) fn handle(id: &str) -> Option<Handle<Image>> {
    store()
        .lock()
        .ok()
        .and_then(|store| store.entries.get(id).map(|entry| entry.handle.clone()))
}

/// 纹理表修改计数：模型根据此判断是否需要重建材质绑定（纹理晚到/回收时都不留旧句柄）。
pub(crate) fn revision() -> u64 {
    store().lock().map(|store| store.revision).unwrap_or(0)
}

/// 消费本帧模型纹理批次，创建/复用 `Image` 并回收超限资源。
#[cfg(feature = "canvas-core")]
pub(crate) fn sync_model_textures(
    mut images: ResMut<Assets<Image>>,
    mut batch: ResMut<ModelTextureBatch>,
) {
    let ids: Vec<String> = batch
        .0
        .keys()
        .filter(|id| id.starts_with(MODEL_TEXTURE_ID_PREFIX))
        .cloned()
        .collect();
    if ids.is_empty() {
        return;
    }
    let Ok(mut store) = store().lock() else {
        return;
    };
    let mut evicted: Vec<Handle<Image>> = Vec::new();
    for id in ids {
        let Some((width, height, rgba)) = batch.0.remove(&id) else {
            continue;
        };
        let Some(key) = store_key(&id).map(str::to_owned) else {
            continue;
        };
        // 内容寻址：同一 id 已驻留即视为同一张纹理（前端可能重试上传）。
        if store.entries.contains_key(&key) {
            continue;
        }
        let bytes = rgba.len();
        if bytes > MAX_MODEL_TEXTURE_BYTES {
            continue;
        }
        let mut image = Image::new(
            Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            TextureDimension::D2,
            rgba,
            TextureFormat::Rgba8UnormSrgb,
            RenderAssetUsages::default(),
        );
        // glTF 默认 wrap 为 REPEAT；UV 超出 [0,1] 时不应被钳制（会改变外观）。
        image.sampler = bevy::image::ImageSampler::Descriptor(bevy::image::ImageSamplerDescriptor {
            address_mode_u: bevy::image::ImageAddressMode::Repeat,
            address_mode_v: bevy::image::ImageAddressMode::Repeat,
            address_mode_w: bevy::image::ImageAddressMode::Repeat,
            mag_filter: bevy::image::ImageFilterMode::Linear,
            min_filter: bevy::image::ImageFilterMode::Linear,
            mipmap_filter: bevy::image::ImageFilterMode::Linear,
            ..Default::default()
        });
        let handle = images.add(image);
        store.order += 1;
        let order = store.order;
        store.bytes += bytes;
        store.entries.insert(
            key,
            TextureEntry {
                handle: handle.clone(),
                bytes,
                order,
            },
        );
        store.revision += 1;
        // FIFO 回收：优先释放最早驻留的纹理。
        while store.entries.len() > MAX_MODEL_TEXTURES || store.bytes > MAX_MODEL_TEXTURE_BYTES {
            let Some(oldest) = store
                .entries
                .values()
                .min_by_key(|entry| entry.order)
                .map(|entry| entry.handle.id())
            else {
                break;
            };
            let key = store
                .entries
                .iter()
                .find(|(_, entry)| entry.handle.id() == oldest)
                .map(|(key, _)| key.clone());
            let Some(key) = key else { break };
            if let Some(entry) = store.entries.remove(&key) {
                store.bytes = store.bytes.saturating_sub(entry.bytes);
                evicted.push(entry.handle);
            }
        }
    }
    drop(store);
    for handle in evicted {
        images.remove(handle.id());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_is_stable_and_material_lookup_is_best_effort() {
        assert_eq!(MODEL_TEXTURE_ID_PREFIX, "modeltex:");
        // 路由前缀不进入材质查找键：材质 op 使用的是去前缀的内容 id。
        assert_eq!(store_key("modeltex:glbtex:0123456789abcdef"), Some("glbtex:0123456789abcdef"));
        assert_eq!(store_key("plane-7"), None);
        assert_eq!(store_key("modeltex:"), None);
        assert!(handle("glbtex:missing").is_none());
    }
}
