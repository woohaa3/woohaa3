//! 2D 节点纹理的**内容身份**共享与逐层引用计数
//! （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.4）。
//!
//! 只做 JS 侧去重（同一 URL 只解码一次）仍会把同一份像素按节点重复上传、重复建 GPU 纹理：
//! 1000 张引用同一资产的卡片就是 1000 份 `Image`。本模块让 Rust 侧也按**内容身份**共享：
//! 同 `sourceKey` + 同尺寸只保留一个 `Handle<Image>`，`nodeId` 只是绑定实例。
//!
//! 共享身份包含**尺寸**：同一资产的不同缩略图档位是不同纹理，不能互相覆盖。
//!
//! 释放在引用结束时逐层下降：
//! - 删除一个节点只减少引用，不释放仍被其他节点使用的纹理；
//! - 最后一个引用结束才把 handle 交给调用方从 `Assets<Image>` 移除；
//! - 归档/换源/尺寸变化按「先解绑、后绑定」处理，避免留下既无引用也未被移除的 GPU 副本。
//!
//! 纯数据结构（只用 Bevy 的 `Handle`/`Vec2`），不访问 ECS、Assets 或 bridge，可直接单测。

use bevy::prelude::*;
use std::collections::HashMap;

/// 共享键：内容身份 + 尺寸。尺寸必须参与，否则不同档位会把彼此的 handle 覆盖掉。
fn shared_key(content: &str, size: Vec2) -> String {
    format!("{content}\u{0}{}x{}", size.x, size.y)
}

/// 一份被共享的内容纹理。
#[derive(Debug)]
struct Content {
    handle: Handle<Image>,
    refs: usize,
}

/// 一个节点到内容的绑定。
#[derive(Debug, Clone)]
struct Binding {
    /// 共享键；`None` 表示该节点使用独占纹理（没有稳定内容 key，例如本地幽灵预览）。
    shared: Option<String>,
    handle: Handle<Image>,
    size: Vec2,
}

/// 一次上传应当如何处理。
#[derive(Debug)]
pub(crate) enum TextureAction {
    /// 复用已有内容纹理（节点只是新绑定），不需要再上传像素。
    Reused(Handle<Image>),
    /// 需要新建/覆盖该节点自己的纹理。
    Fresh,
}

/// 节点纹理的内容共享表。
#[derive(Resource, Debug, Default)]
pub(crate) struct TextureStore {
    contents: HashMap<String, Content>,
    nodes: HashMap<String, Binding>,
}

impl TextureStore {
    /// 同内容同尺寸的共享 handle（可直接复用，不必重新上传像素）。
    pub(crate) fn shared(&self, content: &str, size: Vec2) -> Option<Handle<Image>> {
        self.contents
            .get(&shared_key(content, size))
            .map(|entry| entry.handle.clone())
    }

    /// 节点的当前绑定（handle 与尺寸）。
    pub(crate) fn binding(&self, node_id: &str) -> Option<(Handle<Image>, Vec2)> {
        self.nodes
            .get(node_id)
            .map(|binding| (binding.handle.clone(), binding.size))
    }

    /// 判定一次上传应当复用共享纹理还是写入新纹理。
    ///
    /// 只要同内容 + 同尺寸已有共享 handle 就复用（包括节点首次绑到已共享内容）；否则必须新建，
    /// 不能把别的尺寸/别的内容的旧像素当成本次内容。
    pub(crate) fn resolve(&self, content: Option<&str>, size: Vec2) -> TextureAction {
        match content.and_then(|content| self.shared(content, size)) {
            Some(shared) => TextureAction::Reused(shared),
            None => TextureAction::Fresh,
        }
    }

    /// 绑定节点到（可选的）内容身份；返回因换绑而失去最后引用、需要移除的旧 handle。
    pub(crate) fn bind(
        &mut self,
        node_id: &str,
        content: Option<&str>,
        size: Vec2,
        handle: Handle<Image>,
    ) -> Vec<Handle<Image>> {
        let key = content.map(|content| shared_key(content, size));
        // 幂等：已绑在同一共享键的同一 handle 上，且共享表条目存在时无需改动。
        if let Some(previous) = self.nodes.get(node_id)
            && previous.handle == handle
            && previous.shared == key
            && previous.size == size
            && key
                .as_ref()
                .is_none_or(|key| self.contents.contains_key(key))
        {
            return Vec::new();
        }
        let mut released = self.release(node_id);
        if let Some(key) = &key {
            let entry = self.contents.entry(key.clone()).or_insert(Content {
                handle: handle.clone(),
                refs: 0,
            });
            // 共享键已含尺寸，唯一可能的不一致是「同键但 handle 已被重建」。
            if entry.handle != handle {
                let stale = std::mem::replace(&mut entry.handle, handle.clone());
                if !released.contains(&stale) {
                    released.push(stale);
                }
            }
            entry.refs += 1;
        }
        self.nodes.insert(
            node_id.to_owned(),
            Binding {
                shared: key,
                handle,
                size,
            },
        );
        released
    }

    /// 解绑节点；返回需要从 `Assets<Image>` 移除的 handle（仅当最后一个引用结束）。
    pub(crate) fn release(&mut self, node_id: &str) -> Vec<Handle<Image>> {
        let Some(binding) = self.nodes.remove(node_id) else {
            return Vec::new();
        };
        let Some(key) = binding.shared else {
            // 独占纹理：节点消失即可释放。
            return vec![binding.handle];
        };
        let Some(entry) = self.contents.get_mut(&key) else {
            return vec![binding.handle];
        };
        if entry.refs > 1 {
            entry.refs -= 1;
            return Vec::new();
        }
        let handle = entry.handle.clone();
        self.contents.remove(&key);
        if handle == binding.handle {
            vec![handle]
        } else {
            vec![handle, binding.handle]
        }
    }

    /// 清空全部绑定（切画布/运行代际重建）；返回所有待移除的 handle。
    #[allow(dead_code)]
    pub(crate) fn clear(&mut self) -> Vec<Handle<Image>> {
        let mut handles: Vec<Handle<Image>> = self
            .contents
            .drain()
            .map(|(_, content)| content.handle)
            .collect();
        for (_, binding) in self.nodes.drain() {
            if !handles.contains(&binding.handle) {
                handles.push(binding.handle);
            }
        }
        handles
    }

    /// 仍然可达的内容纹理数（诊断/测试）。
    #[allow(dead_code)]
    pub(crate) fn content_count(&self) -> usize {
        self.contents.len()
    }

    /// 引用总数（诊断/测试）：等于绑定节点数。
    #[allow(dead_code)]
    pub(crate) fn binding_count(&self) -> usize {
        self.nodes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(id: u128) -> Handle<Image> {
        Handle::Uuid(
            bevy::asset::uuid::Uuid::from_u128(id),
            std::marker::PhantomData,
        )
    }

    const SIZE: Vec2 = Vec2::new(64.0, 32.0);

    #[test]
    fn thousand_nodes_share_one_content_handle() {
        let mut store = TextureStore::default();
        let shared = handle(1);
        for index in 0..1000 {
            let node = format!("n{index}");
            if index == 0 {
                assert!(matches!(
                    store.resolve(Some("content"), SIZE),
                    TextureAction::Fresh
                ));
            } else {
                // 后续节点直接复用同一 handle：不再上传像素、不再建 GPU 纹理。
                assert!(matches!(
                    store.resolve(Some("content"), SIZE),
                    TextureAction::Reused(_)
                ));
            }
            assert!(
                store
                    .bind(&node, Some("content"), SIZE, shared.clone())
                    .is_empty()
            );
            assert_eq!(store.shared("content", SIZE), Some(shared.clone()));
        }
        assert_eq!(store.content_count(), 1);
        assert_eq!(store.binding_count(), 1000);
    }

    #[test]
    fn removing_one_node_keeps_shared_texture_until_last_reference() {
        let mut store = TextureStore::default();
        let shared = handle(2);
        for node in ["a", "b"] {
            store.bind(node, Some("content"), SIZE, shared.clone());
        }
        assert!(store.release("a").is_empty(), "仍有引用者时不释放 GPU 纹理");
        assert_eq!(store.shared("content", SIZE), Some(shared.clone()));
        assert_eq!(store.release("b"), vec![shared]);
        assert_eq!(store.content_count(), 0);
        assert!(store.shared("content", SIZE).is_none());
    }

    #[test]
    fn rebinding_to_another_content_releases_only_unreferenced_handles() {
        let mut store = TextureStore::default();
        let first = handle(3);
        let second = handle(4);
        store.bind("a", Some("one"), SIZE, first.clone());
        store.bind("b", Some("one"), SIZE, first.clone());
        // a 换到另一份内容：one 仍被 b 使用，不能释放。
        let released = store.bind("a", Some("two"), SIZE, second.clone());
        assert!(released.is_empty());
        assert_eq!(store.shared("one", SIZE), Some(first));
        assert_eq!(store.shared("two", SIZE), Some(second.clone()));
        // b 也换走后 one 才可释放。
        let released = store.bind("b", Some("two"), SIZE, second.clone());
        assert_eq!(released, vec![handle(3)]);
    }

    #[test]
    fn size_change_forces_fresh_upload_and_keeps_no_stale_handle() {
        let mut store = TextureStore::default();
        store.bind("a", Some("content"), SIZE, handle(5));
        // 档位变化：不能把旧尺寸的像素当新档位复用。
        assert!(matches!(
            store.resolve(Some("content"), Vec2::new(128.0, 64.0)),
            TextureAction::Fresh
        ));
        assert!(matches!(
            store.resolve(Some("content"), SIZE),
            TextureAction::Reused(_)
        ));
    }

    #[test]
    fn different_tiers_of_same_asset_never_overwrite_each_other() {
        let mut store = TextureStore::default();
        let small = handle(10);
        let large = handle(11);
        store.bind("a", Some("asset"), Vec2::new(64.0, 32.0), small.clone());
        store.bind("b", Some("asset"), Vec2::new(256.0, 128.0), large.clone());
        assert_eq!(store.shared("asset", Vec2::new(64.0, 32.0)), Some(small));
        assert_eq!(store.shared("asset", Vec2::new(256.0, 128.0)), Some(large));
        // 释放小档不影响大档。
        assert_eq!(store.release("a"), vec![handle(10)]);
        assert_eq!(
            store.shared("asset", Vec2::new(256.0, 128.0)),
            Some(handle(11))
        );
    }

    #[test]
    fn node_without_content_key_owns_its_texture_and_releases_on_removal() {
        let mut store = TextureStore::default();
        let own = handle(6);
        assert!(matches!(store.resolve(None, SIZE), TextureAction::Fresh));
        store.bind("ghost", None, SIZE, own.clone());
        assert_eq!(store.content_count(), 0);
        assert_eq!(store.release("ghost"), vec![own]);
        assert!(store.release("ghost").is_empty(), "重复解绑必须幂等");
    }

    #[test]
    fn clear_returns_every_distinct_handle_once() {
        let mut store = TextureStore::default();
        store.bind("a", Some("shared"), SIZE, handle(7));
        store.bind("b", Some("shared"), SIZE, handle(7));
        store.bind("c", None, SIZE, handle(8));
        let mut handles = store.clear();
        handles.sort();
        assert_eq!(handles, vec![handle(7), handle(8)]);
        assert_eq!(store.binding_count(), 0);
    }
}
