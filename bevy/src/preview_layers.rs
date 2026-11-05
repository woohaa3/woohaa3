//! 预览渲染层/槽的统一分配与回收
//! （change: 2026-10-23-scale-canvas-media-residency，design D6 / 任务 6.3）。
//!
//! 普通模型卡片与拍摄镜头卡片原本各自分配渲染层：模型卡片用 `(32..).find(unused)`（无上界），
//! 镜头卡片用 `40 + index % 16`。两套假设互不相交只在节点数很少时成立——普通模型分到 40 以后
//! 就会撞进镜头卡片的层区间，卡片相机互相看见对方的模型，表现为「串画面」。
//!
//! 本模块是**唯一**分配预览层的地方：
//! - 保留层（世界 `0`、编辑器/gizmo `1`、片场相机 `2`、运行特效 `3`、空场占位 `4`、截取 `7`）永不出租；
//! - 可出租槽数量有界（`CAPACITY`），超出时调用方必须排队/占位，不能无界增长层号；
//! - 同一个层在旧视图**停止并完成隔离**后才回到空闲表；每次出租推进 `generation`，让迟到的
//!   GPU 完成按 owner+generation 丢弃，不能发布到新使用者；
//! - 分配是确定性的（最小空闲槽优先），便于诊断复现。
//!
//! 纯逻辑不依赖 Bevy，可在任何 feature 下单测；ECS 侧只持有 [`PreviewLayerPool`] 资源。

use std::collections::BTreeMap;

/// 保留层：世界、编辑器/gizmo（1）、片场相机（2）、运行特效（3）、空场占位（4）、截取（7），
/// 以及「已注册但没有卡片视图」的模型根停放层 31。
///
/// `1` 同时是 transform gizmo 与 shot gizmo；`2` 是片场小相机；`7` 是 capture。
pub const RESERVED_LAYERS: [usize; 8] = [0, 1, 2, 3, 4, 7, 8, PARKED_LAYER];

/// 没有卡片视图的模型根停放在此层：任何预览/主相机都不看它，但仍保留合法渲染层身份。
pub const PARKED_LAYER: usize = 31;

/// 可出租层区间起点：高于全部保留层。
pub const SLOT_BASE: usize = 32;

/// 可出租槽数量（设计 D3「每页预览渲染槽最多 16 个」）。
pub const CAPACITY: usize = 16;

/// 一次层租约：owner 身份 + 代数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayerSlot {
    /// 实际渲染层号。
    pub layer: usize,
    /// 该层被出租给此 owner 时的代数；迟到的旧代完成必须丢弃。
    pub generation: u64,
}

#[derive(Debug, Default)]
struct SlotState {
    /// 当前持有者；`None` 表示空闲。
    owner: Option<String>,
    /// 最近一次出租的代数（只增不减）。
    generation: u64,
}

/// 预览层池（纯逻辑）。
#[derive(Debug)]
pub struct PreviewLayers {
    slots: Vec<SlotState>,
    /// 全局代数计数：每次出租推进，跨 owner 也单调。
    next_generation: u64,
    /// 因池满而失败的取得次数（诊断）。
    exhausted: u64,
    /// 成功复用（此前出租过、已归还）的次数（诊断）。
    reused: u64,
    /// 分配总次数（诊断）。
    acquired: u64,
}

impl Default for PreviewLayers {
    fn default() -> Self {
        Self {
            slots: (0..CAPACITY).map(|_| SlotState::default()).collect(),
            next_generation: 0,
            exhausted: 0,
            reused: 0,
            acquired: 0,
        }
    }
}

impl PreviewLayers {
    /// 层号（不是槽序号）。
    pub fn layer_of(index: usize) -> usize {
        SLOT_BASE + index
    }

    /// 当前持有者的租约；未持有返回 `None`。
    pub fn slot_of(&self, owner: &str) -> Option<LayerSlot> {
        self.slots.iter().enumerate().find_map(|(index, slot)| {
            (slot.owner.as_deref() == Some(owner)).then_some(LayerSlot {
                layer: Self::layer_of(index),
                generation: slot.generation,
            })
        })
    }

    /// 取得（或保持）owner 的层。
    ///
    /// 已持有则原样返回（幂等）；否则取最小空闲槽。池满返回 `None`，调用方必须排队/占位。
    pub fn acquire(&mut self, owner: &str) -> Option<LayerSlot> {
        if let Some(existing) = self.slot_of(owner) {
            return Some(existing);
        }
        let index = self.slots.iter().position(|slot| slot.owner.is_none())?;
        self.next_generation = self.next_generation.wrapping_add(1);
        let slot = &mut self.slots[index];
        if slot.generation > 0 {
            self.reused += 1;
        }
        slot.owner = Some(owner.to_owned());
        slot.generation = self.next_generation;
        self.acquired += 1;
        Some(LayerSlot {
            layer: Self::layer_of(index),
            generation: self.next_generation,
        })
    }

    /// 记录一次池满（调用方在 `acquire` 返回 `None` 时调用，便于诊断）。
    pub fn note_exhausted(&mut self) {
        self.exhausted += 1;
    }

    /// 归还 owner 的层。
    ///
    /// 只在旧视图已停止且完成反馈已隔离后调用；返回被归还的层号。代数保持，保证同一层下一次
    /// 出租一定是更大的 generation。
    pub fn release(&mut self, owner: &str) -> Option<usize> {
        let (index, slot) = self
            .slots
            .iter_mut()
            .enumerate()
            .find(|(_, slot)| slot.owner.as_deref() == Some(owner))?;
        slot.owner = None;
        Some(Self::layer_of(index))
    }

    /// 当前持有者 → 层号（诊断用；按层号排序）。
    pub fn leases(&self) -> BTreeMap<String, usize> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| {
                slot.owner
                    .as_ref()
                    .map(|owner| (owner.clone(), Self::layer_of(index)))
            })
            .collect()
    }

    pub fn active(&self) -> usize {
        self.slots
            .iter()
            .filter(|slot| slot.owner.is_some())
            .count()
    }

    pub fn available(&self) -> usize {
        CAPACITY - self.active()
    }

    /// `(取得, 复用, 池满, 当前占用)` 诊断计数。
    pub fn stats(&self) -> [u64; 4] {
        [
            self.acquired,
            self.reused,
            self.exhausted,
            self.active() as u64,
        ]
    }

    /// 层号是否属于保留集合（诊断与测试共用）。
    pub fn is_reserved(layer: usize) -> bool {
        RESERVED_LAYERS.contains(&layer) || !(SLOT_BASE..SLOT_BASE + CAPACITY).contains(&layer)
    }

    /// 归还全部租约（运行代际重建/测试重置）。
    pub fn clear(&mut self) {
        for slot in &mut self.slots {
            slot.owner = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_layers_are_never_rented() {
        let mut pool = PreviewLayers::default();
        let mut rented = Vec::new();
        for index in 0..CAPACITY {
            let slot = pool.acquire(&format!("card-{index}")).unwrap();
            assert!(!PreviewLayers::is_reserved(slot.layer));
            assert!(slot.layer >= SLOT_BASE);
            rented.push(slot.layer);
        }
        rented.sort_unstable();
        assert_eq!(
            rented,
            (SLOT_BASE..SLOT_BASE + CAPACITY).collect::<Vec<_>>()
        );
        for layer in RESERVED_LAYERS {
            assert!(!rented.contains(&layer), "保留层 {layer} 不得出租");
        }
    }

    #[test]
    fn capacity_is_bounded_and_reports_exhaustion() {
        let mut pool = PreviewLayers::default();
        for index in 0..CAPACITY {
            assert!(pool.acquire(&format!("a{index}")).is_some());
        }
        assert_eq!(pool.acquire("overflow"), None);
        pool.note_exhausted();
        assert_eq!(pool.active(), CAPACITY);
        assert_eq!(pool.available(), 0);
        assert_eq!(pool.stats(), [CAPACITY as u64, 0, 1, CAPACITY as u64]);
    }

    #[test]
    fn acquire_is_idempotent_per_owner() {
        let mut pool = PreviewLayers::default();
        let first = pool.acquire("card").unwrap();
        let second = pool.acquire("card").unwrap();
        assert_eq!(first, second);
        assert_eq!(pool.active(), 1);
        assert_eq!(pool.stats()[0], 1);
    }

    #[test]
    fn release_frees_the_smallest_slot_and_bumps_generation() {
        let mut pool = PreviewLayers::default();
        let a = pool.acquire("a").unwrap();
        let b = pool.acquire("b").unwrap();
        assert_ne!(a.layer, b.layer);
        assert_eq!(pool.release("a"), Some(a.layer));
        assert_eq!(pool.release("a"), None, "重复归还是幂等的");
        let c = pool.acquire("c").unwrap();
        assert_eq!(c.layer, a.layer, "最小空闲槽优先");
        assert!(c.generation > a.generation, "同一层的新租约代数必须更大");
        assert_eq!(pool.active(), 2);
        assert_eq!(pool.stats()[1], 1, "复用过一次");
    }

    #[test]
    fn independent_owners_never_share_a_layer() {
        let mut pool = PreviewLayers::default();
        let layers: Vec<usize> = (0..CAPACITY)
            .map(|index| pool.acquire(&format!("o{index}")).unwrap().layer)
            .collect();
        let unique: std::collections::HashSet<_> = layers.iter().copied().collect();
        assert_eq!(unique.len(), layers.len());
    }
}

/// Editor-only camera and scene-area helpers; excluded from final camera captures.
pub(crate) const WORLD_CAMERA_GIZMO_LAYER: usize = 8;
