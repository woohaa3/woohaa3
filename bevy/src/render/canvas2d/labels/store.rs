//! 标签消费侧：实体绑定、已应用槽位，以及对本帧脏键的同步入口。
//!
//! 期望集和脏队列在 `canvas_runtime`。这里不保留第二份名单。owner 失去全部 live 键、
//! 父实体死亡、despawn 或换 epoch 时，绑定和已应用索引一起摘掉。

use std::collections::HashMap;

use bevy::prelude::*;

use crate::canvas_ecs::components::CanvasLabelRole;
use crate::canvas_runtime::{CommitOutcome, LabelConflict, LabelRole, LabelSet, Op};

pub(crate) use crate::canvas_runtime::{
    LabelConsumer, LabelOwner, LabelSpec, LabelStyle, LabelWriter, MAX_PENDING_DIRTY_KEYS,
};

#[derive(Clone)]
pub(crate) struct LabelDirty {
    pub(crate) role: CanvasLabelRole,
    pub(crate) owner: LabelOwner,
    pub(crate) slot: u16,
    pub(crate) tombstone: bool,
    pub(crate) spec: Option<LabelSpec>,
}

pub(crate) struct LabelWork {
    pub(crate) barrier: bool,
    pub(crate) through: u64,
    pub(crate) epoch: u64,
    pub(crate) dirty: Vec<LabelDirty>,
    /// `work` 从期望集取出规格的次数。调用方在可变路径上累进 `request_clones`。
    pub(crate) spec_clones: u64,
}

/// 打开后只攒操作。丢弃或校验失败都不碰已提交集合和脏队列。
pub(crate) struct LabelTxn<'a> {
    requests: &'a mut LabelRequests,
    writer: LabelWriter,
    ops: Vec<Op>,
}

impl LabelTxn<'_> {
    pub(crate) fn replace_role(
        &mut self,
        role: CanvasLabelRole,
        keys: Vec<(LabelOwner, u16, LabelSpec)>,
    ) {
        self.ops.push(Op::ReplaceRole {
            role: to_role(role),
            keys,
        });
    }

    /// 该 writer 在这个 owner 上的完整槽位名单。空名单删除这些键，不留空实体。
    pub(crate) fn replace_owner(
        &mut self,
        role: CanvasLabelRole,
        owner: LabelOwner,
        labels: Vec<super::Label>,
        z: f32,
        style: LabelStyle,
    ) {
        let slots = labels
            .into_iter()
            .enumerate()
            .map(|(slot, label)| (slot as u16, LabelSpec::from_label(label, z, style)))
            .collect();
        self.ops.push(Op::ReplaceOwner {
            role: to_role(role),
            owner,
            slots,
        });
    }

    pub(crate) fn upsert(
        &mut self,
        role: CanvasLabelRole,
        owner: LabelOwner,
        slot: u16,
        spec: LabelSpec,
    ) {
        self.ops.push(Op::Upsert {
            role: to_role(role),
            owner,
            slot,
            spec,
        });
    }

    pub(crate) fn remove(&mut self, role: CanvasLabelRole, owner: LabelOwner, slot: u16) {
        self.ops.push(Op::Remove {
            role: to_role(role),
            owner,
            slot,
        });
    }

    pub(crate) fn commit(self) -> Result<(), LabelConflict> {
        let LabelTxn {
            requests,
            writer,
            ops,
        } = self;
        let outcome = requests.set.commit(writer, ops)?;
        requests.drop_emptied(&outcome);
        Ok(())
    }
}

/// 消费侧资源。期望集在 [`LabelSet`]，这里只保存当前代数的实体索引。
#[derive(Resource, Default)]
pub(crate) struct LabelRequests {
    set: LabelSet,
    bindings: HashMap<LabelOwner, Entity>,
    /// 父实体 → owner。删除事件只查这一张，不扫 `bindings`。
    binding_by_entity: HashMap<Entity, LabelOwner>,
    applied: HashMap<(CanvasLabelRole, LabelOwner, u16), Entity>,
    /// owner → 已应用槽位。摘掉一个 owner 不扫全表。
    applied_by_owner: HashMap<LabelOwner, Vec<(CanvasLabelRole, u16)>>,
    by_entity: HashMap<Entity, (CanvasLabelRole, LabelOwner, u16)>,
    /// 本帧新绑定、还没打上锚点的父实体。同步只处理这份名单。
    pending_anchors: Vec<Entity>,
    pending_card_visibility: Vec<Entity>,
    /// 生产者把保留的 `Vec<Label>` 克隆进事务，或同步把脏规格再克隆一次的次数。
    /// 不含 owner/键克隆，也不含写进 `Text2d` 的字符串。
    request_clones: u64,
    /// 删除事件和按 owner 摘索引时访问的条目数。稳定帧必须保持不变。
    binding_visits: u64,
    /// 实际写入文字、变换、颜色或排版元数据的次数。比较后相同则不计。
    component_writes: u64,
}

impl LabelRequests {
    pub(crate) fn transaction(&mut self, writer: LabelWriter) -> LabelTxn<'_> {
        LabelTxn {
            requests: self,
            writer,
            ops: Vec::new(),
        }
    }

    /// 当前代数的实体映射。只重入队这个 owner 的键，不扫其他 owner。
    pub(crate) fn bind(&mut self, owner: LabelOwner, entity: Entity) {
        if self.bindings.get(&owner) == Some(&entity) {
            return;
        }
        if let Some(previous) = self.bindings.insert(owner.clone(), entity) {
            self.binding_by_entity.remove(&previous);
        }
        self.binding_by_entity.insert(entity, owner.clone());
        self.pending_anchors.push(entity);
        self.set.enqueue_owner(&owner);
    }

    pub(crate) fn take_pending_anchors(&mut self) -> Vec<Entity> {
        std::mem::take(&mut self.pending_anchors)
    }

    pub(crate) fn binding(&self, owner: &LabelOwner) -> Option<Entity> {
        self.bindings.get(owner).copied()
    }

    pub(crate) fn label_work(&self) -> LabelWork {
        let missing = if self.set.needs_resync(LabelConsumer::Labels) {
            self.applied_tombstones()
        } else {
            Vec::new()
        };
        let before = self.set.spec_clones();
        let work = self.set.work(LabelConsumer::Labels, move || missing);
        LabelWork {
            barrier: work.barrier,
            through: work.through,
            epoch: work.epoch,
            dirty: work.dirty.into_iter().map(from_dirty).collect(),
            spec_clones: self.set.spec_clones().saturating_sub(before),
        }
    }

    pub(crate) fn ack(&mut self, consumer: LabelConsumer, through: u64, issued: u64) {
        let _ = self.set.ack(consumer, through, issued);
    }

    /// Geometry 本阶段不消费标签实体。观察当前版本，让已读完的日志可以压缩。
    pub(crate) fn ack_geometry(&mut self) {
        let through = self.set.high_water();
        let issued = self.set.queue_epoch();
        self.ack(LabelConsumer::Geometry, through, issued);
    }

    /// 换画布或换渲染实例时丢掉旧队列和实体索引。
    /// `None` 表示身份没变。`Some` 里是要拆掉的标签实体，可以是空的。
    /// 空 canvas id 不换，第一次见到身份也不拆。
    pub(crate) fn observe_canvas(&mut self, canvas_id: &str) -> Option<Vec<Entity>> {
        if !self.set.observe_canvas(canvas_id) {
            return None;
        }
        let stale = self.by_entity.keys().copied().collect();
        self.bindings.clear();
        self.binding_by_entity.clear();
        self.applied.clear();
        self.applied_by_owner.clear();
        self.by_entity.clear();
        self.pending_anchors.clear();
        self.pending_card_visibility.clear();
        Some(stale)
    }

    pub(crate) fn note_applied(
        &mut self,
        role: CanvasLabelRole,
        owner: LabelOwner,
        slot: u16,
        entity: Entity,
    ) {
        if role == CanvasLabelRole::Card {
            self.pending_card_visibility.push(entity);
        }
        if let Some(previous) = self.applied.insert((role, owner.clone(), slot), entity) {
            if previous != entity {
                self.by_entity.remove(&previous);
            }
        }
        let slots = self.applied_by_owner.entry(owner.clone()).or_default();
        if !slots
            .iter()
            .any(|(applied_role, applied_slot)| *applied_role == role && *applied_slot == slot)
        {
            slots.push((role, slot));
        }
        self.by_entity.insert(entity, (role, owner, slot));
    }

    pub(crate) fn take_new_card_labels(&mut self) -> Vec<Entity> {
        std::mem::take(&mut self.pending_card_visibility)
    }

    pub(crate) fn applied(
        &self,
        role: CanvasLabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> Option<Entity> {
        self.applied.get(&(role, owner.clone(), slot)).copied()
    }

    pub(crate) fn applied_for_owner(
        &self,
        role: CanvasLabelRole,
        owner: &LabelOwner,
    ) -> Vec<Entity> {
        self.applied_by_owner
            .get(owner)
            .into_iter()
            .flatten()
            .filter_map(|(actual_role, slot)| {
                (*actual_role == role)
                    .then(|| self.applied(role, owner, *slot))
                    .flatten()
            })
            .collect()
    }

    pub(crate) fn applied_key(&self, entity: Entity) -> Option<(CanvasLabelRole, LabelOwner, u16)> {
        self.by_entity.get(&entity).cloned()
    }

    pub(crate) fn forget_entity(
        &mut self,
        entity: Entity,
    ) -> Option<(CanvasLabelRole, LabelOwner, u16)> {
        let key = self.by_entity.remove(&entity)?;
        self.applied.remove(&(key.0, key.1.clone(), key.2));
        self.forget_owner_slot(&key.1, key.0, key.2);
        Some(key)
    }

    /// 只处理本帧被拆掉或摘掉锚点的父实体。稳定帧没有事件，不读 `bindings`。
    pub(crate) fn reap_removed_bindings(&mut self, removed: impl IntoIterator<Item = Entity>) {
        for entity in removed {
            self.binding_visits = self.binding_visits.saturating_add(1);
            let Some(owner) = self.binding_by_entity.get(&entity).cloned() else {
                continue;
            };
            if self.bindings.get(&owner) == Some(&entity) {
                self.unbind_owner(&owner);
            }
        }
    }

    pub(crate) fn unbind_owner(&mut self, owner: &LabelOwner) {
        if let Some(entity) = self.bindings.remove(owner) {
            self.binding_by_entity.remove(&entity);
        }
        self.forget_owner_applied(owner);
    }

    pub(crate) fn spec_at(
        &mut self,
        role: CanvasLabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> Option<LabelSpec> {
        let before = self.set.spec_clones();
        let spec = self.set.spec_at(to_role(role), owner, slot);
        self.request_clones = self
            .request_clones
            .saturating_add(self.set.spec_clones().saturating_sub(before));
        spec
    }

    pub(crate) fn writer_role_occupied(&self, writer: LabelWriter, role: CanvasLabelRole) -> bool {
        self.set.writer_role_occupied(writer, to_role(role))
    }

    #[cfg(test)]
    pub(crate) fn contains(
        &self,
        writer: LabelWriter,
        role: CanvasLabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> bool {
        self.set.contains(writer, to_role(role), owner, slot)
    }

    #[cfg(test)]
    pub(crate) fn spec_text(
        &self,
        writer: LabelWriter,
        role: CanvasLabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> Option<&str> {
        self.set.spec_text(writer, to_role(role), owner, slot)
    }

    #[cfg(test)]
    pub(crate) fn pending_len(&self) -> usize {
        self.set.pending_len()
    }

    #[cfg(test)]
    pub(crate) fn tombstone(
        &self,
        writer: LabelWriter,
        role: CanvasLabelRole,
        owner: &LabelOwner,
        slot: u16,
    ) -> bool {
        self.set.tombstone(writer, to_role(role), owner, slot)
    }

    #[cfg(test)]
    pub(crate) fn barrier(&self) -> bool {
        self.set.barrier()
    }

    pub(crate) fn note_request_clones(&mut self, count: u64) {
        self.request_clones = self.request_clones.saturating_add(count);
    }

    pub(crate) fn note_component_writes(&mut self, count: u64) {
        self.component_writes = self.component_writes.saturating_add(count);
    }

    #[cfg(test)]
    pub(crate) fn request_clones(&self) -> u64 {
        self.request_clones
    }

    #[cfg(test)]
    pub(crate) fn component_writes(&self) -> u64 {
        self.component_writes
    }

    #[cfg(test)]
    pub(crate) fn commits(&self) -> u64 {
        self.set.commits()
    }

    #[cfg(test)]
    pub(crate) fn full_scans(&self) -> u64 {
        self.set.full_scans()
    }

    #[cfg(test)]
    pub(crate) fn index_visits(&self) -> u64 {
        self.set.index_visits()
    }

    #[cfg(test)]
    pub(crate) fn binding_visits(&self) -> u64 {
        self.binding_visits
    }

    #[cfg(test)]
    pub(crate) fn binding_len(&self) -> usize {
        self.bindings.len()
    }

    #[cfg(test)]
    pub(crate) fn applied_len(&self) -> usize {
        self.applied.len()
    }

    #[cfg(test)]
    pub(crate) fn entity_index_len(&self) -> usize {
        self.by_entity.len()
    }

    #[cfg(test)]
    pub(crate) fn queue_epoch(&self) -> u64 {
        self.set.queue_epoch()
    }

    #[cfg(test)]
    pub(crate) fn clear(&mut self) {
        let roles = self.set.writer_roles();
        let mut by_writer: HashMap<LabelWriter, Vec<LabelRole>> = HashMap::new();
        for (writer, role) in roles {
            by_writer.entry(writer).or_default().push(role);
        }
        for (writer, roles) in by_writer {
            let ops = roles
                .into_iter()
                .map(|role| Op::ReplaceRole {
                    role,
                    keys: Vec::new(),
                })
                .collect();
            if let Ok(outcome) = self.set.commit(writer, ops) {
                self.drop_emptied(&outcome);
            }
        }
    }

    fn drop_emptied(&mut self, outcome: &CommitOutcome) {
        for owner in &outcome.emptied {
            self.bindings.remove(owner);
        }
    }

    fn forget_owner_applied(&mut self, owner: &LabelOwner) {
        let Some(slots) = self.applied_by_owner.remove(owner) else {
            return;
        };
        self.binding_visits = self.binding_visits.saturating_add(slots.len() as u64);
        for (role, slot) in slots {
            let Some(entity) = self.applied.remove(&(role, owner.clone(), slot)) else {
                continue;
            };
            self.by_entity.remove(&entity);
        }
    }

    fn forget_owner_slot(&mut self, owner: &LabelOwner, role: CanvasLabelRole, slot: u16) {
        let Some(slots) = self.applied_by_owner.get_mut(owner) else {
            return;
        };
        slots.retain(|(applied_role, applied_slot)| *applied_role != role || *applied_slot != slot);
        if slots.is_empty() {
            self.applied_by_owner.remove(owner);
        }
    }

    fn applied_tombstones(&self) -> Vec<crate::canvas_runtime::LabelDirty> {
        self.applied
            .iter()
            .filter(|((role, owner, slot), _)| !self.set.has_spec(to_role(*role), owner, *slot))
            .map(
                |((role, owner, slot), _)| crate::canvas_runtime::LabelDirty {
                    role: to_role(*role),
                    owner: owner.clone(),
                    slot: *slot,
                    tombstone: true,
                    spec: None,
                },
            )
            .collect()
    }
}

fn from_dirty(item: crate::canvas_runtime::LabelDirty) -> LabelDirty {
    LabelDirty {
        role: from_role(item.role),
        owner: item.owner,
        slot: item.slot,
        tombstone: item.tombstone,
        spec: item.spec,
    }
}

fn to_role(role: CanvasLabelRole) -> LabelRole {
    match role {
        CanvasLabelRole::Card => LabelRole::Card,
        CanvasLabelRole::Container => LabelRole::Container,
        CanvasLabelRole::Edge => LabelRole::Edge,
        CanvasLabelRole::Attach => LabelRole::Attach,
        CanvasLabelRole::Running => LabelRole::Running,
        CanvasLabelRole::NodeAction => LabelRole::NodeAction,
    }
}

fn from_role(role: LabelRole) -> CanvasLabelRole {
    match role {
        LabelRole::Card => CanvasLabelRole::Card,
        LabelRole::Container => CanvasLabelRole::Container,
        LabelRole::Edge => CanvasLabelRole::Edge,
        LabelRole::Attach => CanvasLabelRole::Attach,
        LabelRole::Running => CanvasLabelRole::Running,
        LabelRole::NodeAction => CanvasLabelRole::NodeAction,
    }
}
