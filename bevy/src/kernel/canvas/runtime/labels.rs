//! keyed 期望集与 writer 操作。不含实体。
//!
//! 键是 `(writer, role, owner, slot)`。替换和绑定只走 writer/role/owner 槽位索引，
//! 不扫描 `committed`。同步只读脏键和 `(role, owner) → slots`。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

use bevy::math::Vec2;

use super::dirty::{DirtyQueue, LabelConsumer, LabelWork};
use super::epoch::RendererEpoch;

/// 生产者身份。同一 [`LabelRole`] 可以有多个 writer。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum LabelWriter {
    Card,
    Edge,
    Running,
    Attach,
    NodeAction,
}

/// 标签角色。呈现组件由 `canvas2d` 映射，这里不是 Bevy Component。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum LabelRole {
    Card,
    Container,
    Edge,
    Attach,
    Running,
    NodeAction,
}

/// 稳定 owner。节点复用和边块重建都不换键。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum LabelOwner {
    Node(String),
    /// 边块文档槽起点（`block_index * BLOCK_SIZE`）。
    Block(u32),
}

/// 标签排版风格。角色固定，复用实体时不需要切换排版组件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LabelStyle {
    Node,
    Attach,
    Running,
    NodeAction,
    Edge,
}

/// 一个槽位的呈现描述。不含实体。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LabelSpec {
    pub(crate) text: String,
    pub(crate) position: Vec2,
    pub(crate) size: f32,
    pub(crate) color: u32,
    pub(crate) z: f32,
    pub(crate) style: LabelStyle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LabelConflict {
    pub(crate) role: LabelRole,
    pub(crate) owner: LabelOwner,
    pub(crate) slot: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct LabelKey {
    pub(crate) writer: LabelWriter,
    pub(crate) role: LabelRole,
    pub(crate) owner: LabelOwner,
    pub(crate) slot: u16,
}

#[derive(Clone)]
pub(crate) struct LabelDirty {
    pub(crate) role: LabelRole,
    pub(crate) owner: LabelOwner,
    pub(crate) slot: u16,
    pub(crate) tombstone: bool,
    pub(crate) spec: Option<LabelSpec>,
}

pub(crate) struct CommitOutcome {
    /// 这次提交后不再有 live 键的 owner。消费侧据此摘掉绑定。
    pub(crate) emptied: Vec<LabelOwner>,
}

pub(crate) enum Op {
    ReplaceRole {
        role: LabelRole,
        keys: Vec<(LabelOwner, u16, LabelSpec)>,
    },
    ReplaceOwner {
        role: LabelRole,
        owner: LabelOwner,
        slots: Vec<(u16, LabelSpec)>,
    },
    Upsert {
        role: LabelRole,
        owner: LabelOwner,
        slot: u16,
        spec: LabelSpec,
    },
    Remove {
        role: LabelRole,
        owner: LabelOwner,
        slot: u16,
    },
}

/// 唯一保留期望集。实体映射不在这里。
#[derive(Default)]
pub(crate) struct LabelSet {
    committed: HashMap<LabelKey, LabelSpec>,
    occupied: HashMap<(LabelRole, LabelOwner, u16), LabelWriter>,
    /// 同步用的 `(role, owner) → slots`。不按 writer 拆。
    slots: HashMap<(LabelRole, LabelOwner), BTreeMap<u16, LabelWriter>>,
    /// `(writer, role, owner) → slots`。`ReplaceOwner` 只读这一张。
    writer_owner: HashMap<(LabelWriter, LabelRole, LabelOwner), BTreeMap<u16, ()>>,
    /// `(writer, role) → owners`。`ReplaceRole` 只读这一张。
    writer_role: HashMap<(LabelWriter, LabelRole), HashSet<LabelOwner>>,
    /// `owner → keys`。绑定重入队只读这一张。
    by_owner: HashMap<LabelOwner, Vec<LabelKey>>,
    dirty: DirtyQueue,
    epoch: RendererEpoch,
    commits: u64,
    /// 从期望集取出 `LabelSpec` 的次数。`work` / `spec_at` 是 `&self`，用原子量记账。
    spec_clones: AtomicU64,
    /// 遍历 `committed` 全表的次数。替换、绑定和同步必须保持为 0。
    full_scans: u64,
    /// 经槽位索引访问的键数。规模测试用它证明不是 O(全表)。
    index_visits: u64,
}

impl LabelSet {
    pub(crate) fn commit(
        &mut self,
        writer: LabelWriter,
        ops: Vec<Op>,
    ) -> Result<CommitOutcome, LabelConflict> {
        if let Some(conflict) = self.conflict(writer, &ops) {
            return Err(conflict);
        }
        let mut changed = false;
        let mut touched = Vec::new();
        for op in ops {
            let (did, owners) = self.apply(writer, op);
            changed |= did;
            touched.extend(owners);
        }
        if changed {
            self.commits = self.commits.saturating_add(1);
        }
        touched.sort_by(|left, right| owner_ord(left, right));
        touched.dedup();
        let emptied = touched
            .into_iter()
            .filter(|owner| !self.by_owner.contains_key(owner))
            .collect();
        Ok(CommitOutcome { emptied })
    }

    pub(crate) fn enqueue_owner(&mut self, owner: &LabelOwner) {
        let Some(keys) = self.by_owner.get(owner).cloned() else {
            return;
        };
        self.index_visits = self.index_visits.saturating_add(keys.len() as u64);
        for key in keys {
            self.dirty.enqueue(key, false);
        }
    }

    pub(crate) fn work(
        &self,
        consumer: LabelConsumer,
        applied_missing: impl FnOnce() -> Vec<LabelDirty>,
    ) -> LabelWork<LabelDirty> {
        let snapshot = self.dirty.snapshot(consumer);
        let dirty = if snapshot.barrier {
            let mut dirty: Vec<LabelDirty> = self
                .committed
                .iter()
                .map(|(key, _)| LabelDirty {
                    role: key.role,
                    owner: key.owner.clone(),
                    slot: key.slot,
                    tombstone: false,
                    spec: self.cloned_spec(key),
                })
                .collect();
            dirty.extend(applied_missing());
            dirty
        } else {
            snapshot
                .keys
                .iter()
                .map(|(key, tombstone)| self.dirty_view(key, *tombstone))
                .collect()
        };
        LabelWork {
            barrier: snapshot.barrier,
            through: snapshot.through,
            epoch: snapshot.epoch,
            dirty,
        }
    }

    pub(crate) fn high_water(&self) -> u64 {
        self.dirty.high_water()
    }

    pub(crate) fn needs_resync(&self, consumer: LabelConsumer) -> bool {
        self.dirty.needs_resync(consumer)
    }

    pub(crate) fn writer_roles(&self) -> Vec<(LabelWriter, LabelRole)> {
        self.writer_role.keys().copied().collect()
    }

    /// 该 writer 的这个角色是否还有 live 键。空闲帧用它跳过空 `ReplaceRole`。
    pub(crate) fn writer_role_occupied(&self, writer: LabelWriter, role: LabelRole) -> bool {
        self.writer_role.contains_key(&(writer, role))
    }

    /// 身份缺失（空 canvas id）不换 epoch。第一次见到身份只记录，不丢弃空队列。
    pub(crate) fn observe_canvas(&mut self, canvas_id: &str) -> bool {
        if canvas_id.is_empty() {
            return false;
        }
        self.observe(RendererEpoch::current(canvas_id))
    }

    pub(crate) fn observe(&mut self, next: RendererEpoch) -> bool {
        if self.epoch.canvas_id.is_empty() && self.epoch.instance == 0 {
            self.epoch = next;
            return false;
        }
        if self.epoch == next {
            return false;
        }
        self.discard_epoch(next);
        true
    }

    pub(crate) fn ack(&mut self, consumer: LabelConsumer, through: u64, issued: u64) -> bool {
        self.dirty.ack(consumer, through, issued)
    }

    pub(crate) fn queue_epoch(&self) -> u64 {
        self.dirty.epoch()
    }

    pub(crate) fn spec_at(
        &self,
        role: LabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> Option<LabelSpec> {
        let writer = self
            .slots
            .get(&(role, owner.clone()))?
            .get(&slot)
            .copied()?;
        self.cloned_spec(&LabelKey {
            writer,
            role,
            owner: owner.clone(),
            slot,
        })
    }

    pub(crate) fn spec_clones(&self) -> u64 {
        self.spec_clones.load(Ordering::Relaxed)
    }

    /// 只判断槽位是否仍有规格。不克隆，也不计入 `spec_clones`。
    pub(crate) fn has_spec(&self, role: LabelRole, owner: &LabelOwner, slot: u16) -> bool {
        self.slots
            .get(&(role, owner.clone()))
            .is_some_and(|slots| slots.contains_key(&slot))
    }

    pub(crate) fn contains(
        &self,
        writer: LabelWriter,
        role: LabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> bool {
        self.committed.contains_key(&LabelKey {
            writer,
            role,
            owner: owner.clone(),
            slot,
        })
    }

    pub(crate) fn spec_text(
        &self,
        writer: LabelWriter,
        role: LabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> Option<&str> {
        self.committed
            .get(&LabelKey {
                writer,
                role,
                owner: owner.clone(),
                slot,
            })
            .map(|spec| spec.text.as_str())
    }

    pub(crate) fn tombstone(
        &self,
        writer: LabelWriter,
        role: LabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> bool {
        self.dirty.tombstone(&LabelKey {
            writer,
            role,
            owner: owner.clone(),
            slot,
        })
    }

    pub(crate) fn pending_len(&self) -> usize {
        self.dirty.pending_len()
    }

    pub(crate) fn barrier(&self) -> bool {
        self.dirty.barrier()
    }

    pub(crate) fn commits(&self) -> u64 {
        self.commits
    }

    pub(crate) fn full_scans(&self) -> u64 {
        self.full_scans
    }

    pub(crate) fn index_visits(&self) -> u64 {
        self.index_visits
    }

    fn discard_epoch(&mut self, next: RendererEpoch) {
        self.committed.clear();
        self.occupied.clear();
        self.slots.clear();
        self.writer_owner.clear();
        self.writer_role.clear();
        self.by_owner.clear();
        self.dirty.discard();
        self.commits = 0;
        self.epoch = next;
    }

    fn conflict(&self, writer: LabelWriter, ops: &[Op]) -> Option<LabelConflict> {
        for op in ops {
            for (role, owner, slot) in op_inserts(op) {
                if self
                    .occupied
                    .get(&(role, owner.clone(), slot))
                    .is_some_and(|current| *current != writer)
                {
                    return Some(LabelConflict { role, owner, slot });
                }
            }
        }
        None
    }

    fn apply(&mut self, writer: LabelWriter, op: Op) -> (bool, Vec<LabelOwner>) {
        match op {
            Op::ReplaceRole { role, keys } => self.apply_replace_role(writer, role, keys),
            Op::ReplaceOwner { role, owner, slots } => {
                self.apply_replace_owner(writer, role, owner, slots)
            }
            Op::Upsert {
                role,
                owner,
                slot,
                spec,
            } => {
                let changed = self.upsert_key(writer, role, owner.clone(), slot, spec);
                (changed, vec![owner])
            }
            Op::Remove { role, owner, slot } => {
                let changed = self.remove_key(writer, role, owner.clone(), slot);
                (changed, vec![owner])
            }
        }
    }

    fn apply_replace_role(
        &mut self,
        writer: LabelWriter,
        role: LabelRole,
        keys: Vec<(LabelOwner, u16, LabelSpec)>,
    ) -> (bool, Vec<LabelOwner>) {
        let incoming: HashMap<(LabelOwner, u16), LabelSpec> = keys
            .into_iter()
            .map(|(owner, slot, spec)| ((owner, slot), spec))
            .collect();
        let owners: Vec<LabelOwner> = self
            .writer_role
            .get(&(writer, role))
            .map(|owners| owners.iter().cloned().collect())
            .unwrap_or_default();
        let mut stale = Vec::new();
        for owner in &owners {
            let slots: Vec<u16> = self
                .writer_owner
                .get(&(writer, role, owner.clone()))
                .map(|slots| slots.keys().copied().collect())
                .unwrap_or_default();
            self.index_visits = self.index_visits.saturating_add(slots.len() as u64);
            for slot in slots {
                if !incoming.contains_key(&(owner.clone(), slot)) {
                    stale.push((owner.clone(), slot));
                }
            }
        }
        let mut changed = false;
        let mut touched = owners;
        for (owner, slot) in stale {
            changed |= self.remove_key(writer, role, owner.clone(), slot);
            touched.push(owner);
        }
        for ((owner, slot), spec) in incoming {
            changed |= self.upsert_key(writer, role, owner.clone(), slot, spec);
            touched.push(owner);
        }
        (changed, touched)
    }

    fn apply_replace_owner(
        &mut self,
        writer: LabelWriter,
        role: LabelRole,
        owner: LabelOwner,
        slots: Vec<(u16, LabelSpec)>,
    ) -> (bool, Vec<LabelOwner>) {
        let incoming: HashMap<u16, LabelSpec> = slots.into_iter().collect();
        let existing: Vec<u16> = self
            .writer_owner
            .get(&(writer, role, owner.clone()))
            .map(|slots| slots.keys().copied().collect())
            .unwrap_or_default();
        self.index_visits = self.index_visits.saturating_add(existing.len() as u64);
        let stale: Vec<u16> = existing
            .into_iter()
            .filter(|slot| !incoming.contains_key(slot))
            .collect();
        let mut changed = false;
        for slot in stale {
            changed |= self.remove_key(writer, role, owner.clone(), slot);
        }
        for (slot, spec) in incoming {
            changed |= self.upsert_key(writer, role, owner.clone(), slot, spec);
        }
        (changed, vec![owner])
    }

    fn upsert_key(
        &mut self,
        writer: LabelWriter,
        role: LabelRole,
        owner: LabelOwner,
        slot: u16,
        spec: LabelSpec,
    ) -> bool {
        let key = LabelKey {
            writer,
            role,
            owner: owner.clone(),
            slot,
        };
        if self
            .committed
            .get(&key)
            .is_some_and(|current| current == &spec)
        {
            return false;
        }
        self.occupied.insert((role, owner.clone(), slot), writer);
        self.slots
            .entry((role, owner.clone()))
            .or_default()
            .insert(slot, writer);
        self.writer_owner
            .entry((writer, role, owner.clone()))
            .or_default()
            .insert(slot, ());
        self.writer_role
            .entry((writer, role))
            .or_default()
            .insert(owner.clone());
        let keys = self.by_owner.entry(owner).or_default();
        if !keys.iter().any(|existing| existing == &key) {
            keys.push(key.clone());
        }
        self.committed.insert(key.clone(), spec);
        self.dirty.enqueue(key, false);
        true
    }

    fn remove_key(
        &mut self,
        writer: LabelWriter,
        role: LabelRole,
        owner: LabelOwner,
        slot: u16,
    ) -> bool {
        let key = LabelKey {
            writer,
            role,
            owner: owner.clone(),
            slot,
        };
        if self.committed.remove(&key).is_none() {
            return false;
        }
        self.occupied.remove(&(role, owner.clone(), slot));
        if let Some(slots) = self.slots.get_mut(&(role, owner.clone())) {
            slots.remove(&slot);
            if slots.is_empty() {
                self.slots.remove(&(role, owner.clone()));
            }
        }
        if let Some(slots) = self.writer_owner.get_mut(&(writer, role, owner.clone())) {
            slots.remove(&slot);
            if slots.is_empty() {
                self.writer_owner.remove(&(writer, role, owner.clone()));
                if let Some(owners) = self.writer_role.get_mut(&(writer, role)) {
                    owners.remove(&owner);
                    if owners.is_empty() {
                        self.writer_role.remove(&(writer, role));
                    }
                }
            }
        }
        if let Some(keys) = self.by_owner.get_mut(&owner) {
            keys.retain(|existing| existing != &key);
            if keys.is_empty() {
                self.by_owner.remove(&owner);
            }
        }
        self.dirty.enqueue(key, true);
        true
    }

    fn dirty_view(&self, key: &LabelKey, tombstone: bool) -> LabelDirty {
        LabelDirty {
            role: key.role,
            owner: key.owner.clone(),
            slot: key.slot,
            tombstone,
            spec: if tombstone {
                None
            } else {
                self.cloned_spec(key)
            },
        }
    }

    fn cloned_spec(&self, key: &LabelKey) -> Option<LabelSpec> {
        let spec = self.committed.get(key).cloned()?;
        self.spec_clones.fetch_add(1, Ordering::Relaxed);
        Some(spec)
    }
}

fn op_inserts(op: &Op) -> Vec<(LabelRole, LabelOwner, u16)> {
    match op {
        Op::ReplaceRole { role, keys } => keys
            .iter()
            .map(|(owner, slot, _)| (*role, owner.clone(), *slot))
            .collect(),
        Op::ReplaceOwner { role, owner, slots } => slots
            .iter()
            .map(|(slot, _)| (*role, owner.clone(), *slot))
            .collect(),
        Op::Upsert {
            role, owner, slot, ..
        } => vec![(*role, owner.clone(), *slot)],
        Op::Remove { .. } => Vec::new(),
    }
}

fn owner_ord(left: &LabelOwner, right: &LabelOwner) -> std::cmp::Ordering {
    match (left, right) {
        (LabelOwner::Node(left), LabelOwner::Node(right)) => left.cmp(right),
        (LabelOwner::Block(left), LabelOwner::Block(right)) => left.cmp(right),
        (LabelOwner::Node(_), LabelOwner::Block(_)) => std::cmp::Ordering::Less,
        (LabelOwner::Block(_), LabelOwner::Node(_)) => std::cmp::Ordering::Greater,
    }
}
