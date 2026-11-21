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

const ATLAS_PAGE_SIZE: u32 = 4096;
const ATLAS_SLOT_SIZE: u32 = 512;
const ATLAS_SLOTS_PER_SIDE: u32 = ATLAS_PAGE_SIZE / ATLAS_SLOT_SIZE;
const ATLAS_SLOT_COUNT: usize = (ATLAS_SLOTS_PER_SIDE * ATLAS_SLOTS_PER_SIDE) as usize;
const ATLAS_PADDING: u32 = 1;

/// A source rectangle inside a shared thumbnail atlas page.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AtlasPlacement {
    pub(crate) page: usize,
    pub(crate) slot: usize,
    pub(crate) offset: UVec2,
}

impl AtlasPlacement {
    pub(crate) fn rect(self, size: Vec2) -> Rect {
        let pad_x = if size.x + ATLAS_PADDING as f32 * 2.0 <= ATLAS_SLOT_SIZE as f32 {
            ATLAS_PADDING
        } else {
            0
        };
        let pad_y = if size.y + ATLAS_PADDING as f32 * 2.0 <= ATLAS_SLOT_SIZE as f32 {
            ATLAS_PADDING
        } else {
            0
        };
        let x = self.offset.x + pad_x;
        let y = self.offset.y + pad_y;
        Rect::new(x as f32, y as f32, x as f32 + size.x, y as f32 + size.y)
    }
}

/// 共享键：内容身份 + 尺寸。尺寸必须参与，否则不同档位会把彼此的 handle 覆盖掉。
fn shared_key(content: &str, size: Vec2) -> String {
    format!("{content}\u{0}{}x{}", size.x, size.y)
}

/// 一份被共享的内容纹理。
#[derive(Debug)]
struct Content {
    handle: Handle<Image>,
    refs: usize,
    atlas: Option<AtlasPlacement>,
}

/// 一个节点到内容的绑定。
#[derive(Debug, Clone)]
struct Binding {
    /// 共享键；`None` 表示该节点使用独占纹理（没有稳定内容 key，例如本地幽灵预览）。
    shared: Option<String>,
    handle: Handle<Image>,
    size: Vec2,
    atlas: Option<AtlasPlacement>,
}

#[derive(Debug)]
struct AtlasPage {
    handle: Option<Handle<Image>>,
    used: [bool; ATLAS_SLOT_COUNT],
}

impl Default for AtlasPage {
    fn default() -> Self {
        Self {
            handle: None,
            used: [false; ATLAS_SLOT_COUNT],
        }
    }
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
    atlas_pages: Vec<AtlasPage>,
    /// A slot reserved for a new content key before the first page Image exists.
    pending_atlas: HashMap<String, AtlasPlacement>,
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

    pub(crate) fn atlas_eligible(content: Option<&str>, size: Vec2) -> bool {
        content.is_some_and(|content| !content.is_empty())
            && size.x.is_finite()
            && size.y.is_finite()
            && size.x > 0.0
            && size.y > 0.0
            && size.x <= ATLAS_SLOT_SIZE as f32
            && size.y <= ATLAS_SLOT_SIZE as f32
    }

    /// Reserve or retrieve the atlas slot for an eligible content key.
    ///
    /// The page handle is installed by `textures.rs` when the page Image is first created;
    /// keeping allocation here makes slot reuse and reference release independent of ECS.
    pub(crate) fn ensure_atlas_slot(
        &mut self,
        content: &str,
        size: Vec2,
    ) -> Option<AtlasPlacement> {
        if !Self::atlas_eligible(Some(content), size) {
            return None;
        }
        let key = shared_key(content, size);
        if let Some(entry) = self.contents.get(&key) {
            return entry.atlas;
        }
        if let Some(slot) = self.pending_atlas.get(&key) {
            return Some(*slot);
        }
        for (page_index, page) in self.atlas_pages.iter_mut().enumerate() {
            if let Some(slot) = page.used.iter().position(|used| !*used) {
                page.used[slot] = true;
                let placement = AtlasPlacement {
                    page: page_index,
                    slot,
                    offset: UVec2::new(
                        (slot as u32 % ATLAS_SLOTS_PER_SIDE) * ATLAS_SLOT_SIZE,
                        (slot as u32 / ATLAS_SLOTS_PER_SIDE) * ATLAS_SLOT_SIZE,
                    ),
                };
                self.pending_atlas.insert(key, placement);
                return Some(placement);
            }
        }
        let page_index = self.atlas_pages.len();
        let mut page = AtlasPage::default();
        page.used[0] = true;
        self.atlas_pages.push(page);
        let placement = AtlasPlacement {
            page: page_index,
            slot: 0,
            offset: UVec2::ZERO,
        };
        self.pending_atlas.insert(key, placement);
        Some(placement)
    }

    pub(crate) fn atlas_page_handle(&self, placement: AtlasPlacement) -> Option<Handle<Image>> {
        self.atlas_pages
            .get(placement.page)
            .and_then(|page| page.handle.clone())
    }

    pub(crate) fn set_atlas_page_handle(
        &mut self,
        placement: AtlasPlacement,
        handle: Handle<Image>,
    ) {
        if let Some(page) = self.atlas_pages.get_mut(placement.page) {
            page.handle = Some(handle);
        }
    }

    pub(crate) fn atlas_page_size() -> u32 {
        ATLAS_PAGE_SIZE
    }

    pub(crate) fn atlas_slot_size() -> u32 {
        ATLAS_SLOT_SIZE
    }

    pub(crate) fn atlas_padding() -> u32 {
        ATLAS_PADDING
    }

    pub(crate) fn rect(&self, node_id: &str) -> Option<Rect> {
        self.nodes
            .get(node_id)
            .and_then(|binding| binding.atlas.map(|atlas| atlas.rect(binding.size)))
    }

    /// 节点当前是否绑在共享内容上（独占上传不得原地覆盖共享纹理）。
    pub(crate) fn is_shared(&self, node_id: &str) -> bool {
        self.nodes
            .get(node_id)
            .is_some_and(|binding| binding.shared.is_some())
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
            let atlas = self.pending_atlas.remove(key);
            let entry = self.contents.entry(key.clone()).or_insert(Content {
                handle: handle.clone(),
                refs: 0,
                atlas,
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
                atlas: content
                    .and_then(|content| self.contents.get(&shared_key(content, size)))
                    .and_then(|entry| entry.atlas),
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
        let atlas = entry.atlas;
        if let Some(atlas) = atlas {
            if let Some(page) = self.atlas_pages.get_mut(atlas.page) {
                page.used[atlas.slot] = false;
            }
        }
        self.contents.remove(&key);
        // Atlas pages stay resident so a later thumbnail can reuse the freed slot. The page
        // handle is released together with the whole store in `clear`.
        if atlas.is_some() {
            return Vec::new();
        }
        if handle == binding.handle {
            vec![handle]
        } else {
            vec![handle, binding.handle]
        }
    }

    /// 清空全部绑定（切画布/运行代际重建）；返回所有待移除的 handle。
    #[allow(dead_code)]
    pub(crate) fn clear(&mut self) -> Vec<Handle<Image>> {
        let mut seen = std::collections::HashSet::new();
        let mut handles = Vec::new();
        for page in self.atlas_pages.drain(..) {
            if let Some(handle) = page.handle {
                if seen.insert(handle.id()) {
                    handles.push(handle);
                }
            }
        }
        self.pending_atlas.clear();
        for (_, content) in self.contents.drain() {
            if seen.insert(content.handle.id()) {
                handles.push(content.handle);
            }
        }
        for (_, binding) in self.nodes.drain() {
            if seen.insert(binding.handle.id()) {
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

    #[test]
    fn eligible_content_uses_reusable_atlas_slots() {
        let mut store = TextureStore::default();
        assert!(TextureStore::atlas_eligible(
            Some("asset"),
            Vec2::new(512.0, 512.0)
        ));
        assert!(!TextureStore::atlas_eligible(
            Some("asset"),
            Vec2::new(513.0, 512.0)
        ));
        let first = store.ensure_atlas_slot("one", SIZE).unwrap();
        let second = store.ensure_atlas_slot("two", SIZE).unwrap();
        assert_ne!(first.slot, second.slot);
        let page = handle(100);
        store.set_atlas_page_handle(first, page.clone());
        store.bind("a", Some("one"), SIZE, page.clone());
        assert!(store.rect("a").is_some());
        assert!(store.release("a").is_empty(), "释放缩略图只归还槽位");
        let reused = store.ensure_atlas_slot("three", SIZE).unwrap();
        assert_eq!(reused.slot, first.slot);
    }
}
