//! 标签实体生命周期：owner/role/slot 组件 + 逐帧请求收件箱
//! （change: 2026-10-28-migrate-canvas-rendering-to-bevy-ecs，design D4 / 任务 4.1、4.5）。
//!
//! 标签不再存进共享 overlay cache 的 `HashMap<String, Vec<Entity>>`。每个标签实体带
//! [`CanvasLabel`]（role + slot）并通过 `ChildOf` 归属节点/边批次实体：
//!
//! - 生产者只收集本帧「这个 owner 应该显示哪些文字」，写入 [`LabelRequests`]；
//! - [`sync_canvas_labels`] 一次性按 owner+role 复用、补建、回收实体；
//! - owner 删除时子实体随父回收，不再依赖 Resource 里的 stale `Entity` 句柄。
//!
//! 生命周期仍必须闭合支持 `0 → 1 → 0 → 1`：集合为空时回收全部槽位，下一次非空重新补建。

use bevy::{
    prelude::*,
    sprite::Anchor,
    text::{LineBreak, TextBounds},
};

use std::collections::{HashMap, HashSet};

use crate::canvas_ecs::components::{CanvasLabel, CanvasLabelRole};
use crate::canvas2d::CanvasOverlayCache;
use crate::canvas2d::text_presentation::{LogicalText, TextScaleMode};

/// 标签文案包：`(文案, 位置, 字号, 颜色 0xRRGGBB)`。
///
/// 「字号」是**逻辑字号**（世界单位）：实际 `TextFont` 由
/// [`super::text_presentation`] 按相机缩放与 DPR 派生，绘制侧不直接写栅格字号
/// （change: 2026-10-22-improve-canvas-text-clarity，design D1）。
pub(crate) type Label = (String, Vec2, f32, u32);

/// 标签逻辑 bounds（世界单位）。截断由调用方按逻辑宽度决定，栅格 bounds 按同一比例换算。
const LABEL_BOUNDS: Vec2 = Vec2::new(600.0, 48.0);

/// 标签排版风格。角色固定，复用实体时不需要切换排版组件。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LabelStyle {
    /// 普通卡片/group/片场标题：左上锚点、单行、逻辑 bounds。
    Node,
    /// 拖动粘连操作条：左上锚点、无 bounds。
    Attach,
    /// 运行百分比：居中锚点、无 bounds。
    Running,
    /// 节点顶部操作横条：固定屏幕字号、左上锚点。
    NodeAction,
    /// 连线标签：居中锚点、世界字号。
    Edge,
}

impl LabelStyle {
    fn anchor(self) -> Anchor {
        match self {
            LabelStyle::Attach | LabelStyle::Node | LabelStyle::NodeAction => Anchor::TOP_LEFT,
            LabelStyle::Running | LabelStyle::Edge => Anchor::CENTER,
        }
    }

    fn layout(self) -> TextLayout {
        match self {
            LabelStyle::Running => TextLayout::new(Justify::Center, LineBreak::NoWrap),
            _ => TextLayout::new(Justify::Left, LineBreak::NoWrap),
        }
    }

    fn bounds(self) -> Option<Vec2> {
        match self {
            LabelStyle::Node => Some(LABEL_BOUNDS),
            _ => None,
        }
    }

    fn meta(self, size: f32) -> LogicalText {
        match self {
            LabelStyle::Node => LogicalText::world(size, Some(LABEL_BOUNDS)),
            LabelStyle::Attach | LabelStyle::Running | LabelStyle::Edge => {
                LogicalText::world(size, None)
            }
            LabelStyle::NodeAction => LogicalText::screen(size),
        }
    }

    fn bounds_component(self) -> Option<TextBounds> {
        self.bounds().map(|bounds| TextBounds {
            width: Some(bounds.x),
            height: Some(bounds.y),
        })
    }

    fn scale_mode(self) -> TextScaleMode {
        match self {
            LabelStyle::NodeAction => TextScaleMode::Screen,
            _ => TextScaleMode::World,
        }
    }
}

/// 一个 owner 在一帧内期望的标签集合。
#[derive(Clone, PartialEq)]
pub(crate) struct LabelRequest {
    pub(crate) owner: Entity,
    pub(crate) labels: Vec<Label>,
    pub(crate) z: f32,
    pub(crate) style: LabelStyle,
}

/// 标签生产者到同步系统的逐帧收件箱。
///
/// 按 role 存：每个生产者在本系统运行前 `begin(role)` 清空自己的角色，再 push 本帧请求。
/// 未运行的（被 `FrameFlags` 门禁的）生产者保留上一帧请求，标签不会闪失。
#[derive(Resource, Default)]
pub(crate) struct LabelRequests {
    roles: HashMap<CanvasLabelRole, HashMap<Entity, LabelRequest>>,
    pending_removals: HashMap<CanvasLabelRole, HashSet<Entity>>,
    dirty: HashSet<(Entity, CanvasLabelRole)>,
}

impl LabelRequests {
    /// 开始收集某个角色的本帧请求（替换上一帧）。
    pub(crate) fn begin(&mut self, role: CanvasLabelRole) {
        self.pending_removals.insert(
            role,
            self.roles
                .get(&role)
                .map(|owners| owners.keys().copied().collect())
                .unwrap_or_default(),
        );
    }

    /// 追加一个 owner 的标签集合；空集合等价于「本帧不显示该 owner 的该角色标签」。
    pub(crate) fn push(
        &mut self,
        role: CanvasLabelRole,
        owner: Entity,
        labels: Vec<Label>,
        z: f32,
        style: LabelStyle,
    ) {
        if labels.is_empty() {
            self.remove(role, owner);
            return;
        }
        self.push_request(
            role,
            LabelRequest {
                owner,
                labels,
                z,
                style,
            },
        );
    }

    /// 复用缓存块上一帧的请求（块命中时仍要重新提交本帧收件箱）。
    pub(crate) fn extend(&mut self, role: CanvasLabelRole, cached: &[LabelRequest]) {
        for request in cached {
            self.push_request(role, request.clone());
        }
    }

    /// 直接提交一个构造好的请求（缓存块复用时保持同一形状）。
    pub(crate) fn push_request(&mut self, role: CanvasLabelRole, request: LabelRequest) {
        if let Some(pending) = self.pending_removals.get_mut(&role) {
            pending.remove(&request.owner);
        }
        let owners = self.roles.entry(role).or_default();
        if owners.get(&request.owner) != Some(&request) {
            self.dirty.insert((request.owner, role));
            owners.insert(request.owner, request);
        }
    }

    /// Remove one owner's role without clearing unrelated blocks.
    pub(crate) fn remove(&mut self, role: CanvasLabelRole, owner: Entity) {
        if let Some(pending) = self.pending_removals.get_mut(&role) {
            pending.remove(&owner);
        }
        if self
            .roles
            .get_mut(&role)
            .and_then(|owners| owners.remove(&owner))
            .is_some()
        {
            self.dirty.insert((owner, role));
        }
    }

    /// 清空全部角色（测试/帧边界用）。
    #[cfg(test)]
    pub(crate) fn clear(&mut self) {
        self.dirty.extend(
            self.roles
                .iter()
                .flat_map(|(role, owners)| owners.keys().map(move |owner| (*owner, *role))),
        );
        self.roles.clear();
        self.pending_removals.clear();
    }

    fn iter(&self) -> impl Iterator<Item = (&CanvasLabelRole, &LabelRequest)> {
        self.roles
            .iter()
            .flat_map(|(role, requests)| requests.values().map(move |request| (role, request)))
    }
}

/// Entity handles are only an index of CanvasLabel + ChildOf, scoped to this renderer.
#[derive(Default)]
pub(crate) struct LabelIndex {
    slots: HashMap<(Entity, CanvasLabelRole), HashMap<u16, Entity>>,
    reverse: HashMap<Entity, ((Entity, CanvasLabelRole), u16)>,
    initialized: bool,
}

/// Maintain the slot index from component additions/removals; reconcile changed requests only.
pub(crate) fn sync_canvas_labels(
    mut commands: Commands,
    mut requests: ResMut<LabelRequests>,
    visuals: Res<CanvasOverlayCache>,
    changed: Query<(Entity, &CanvasLabel, &ChildOf), Or<(Changed<CanvasLabel>, Changed<ChildOf>)>>,
    mut removed: RemovedComponents<CanvasLabel>,
    mut index: Local<LabelIndex>,
    mut text: Query<(
        &mut Text2d,
        &mut Transform,
        &mut TextColor,
        &mut LogicalText,
    )>,
) {
    if index.initialized
        && requests.pending_removals.is_empty()
        && requests.dirty.is_empty()
        && changed.is_empty()
        && removed.is_empty()
    {
        return;
    }
    for (role, pending) in std::mem::take(&mut requests.pending_removals) {
        for owner in pending {
            requests.remove(role, owner);
        }
    }
    let mut dirty = std::mem::take(&mut requests.dirty);
    if !index.initialized {
        dirty.extend(
            requests
                .iter()
                .map(|(role, request)| (request.owner, *role)),
        );
        index.initialized = true;
    }
    for entity in removed.read() {
        if let Some((key, slot)) = index.reverse.remove(&entity) {
            if let Some(slots) = index.slots.get_mut(&key) {
                slots.remove(&slot);
            }
            dirty.insert(key);
        }
    }
    for (entity, label, child) in &changed {
        let key = (child.parent(), label.role);
        let entry = (key, label.slot);
        if index.reverse.get(&entity) == Some(&entry) {
            continue;
        }
        if let Some((old, slot)) = index.reverse.insert(entity, entry) {
            if let Some(slots) = index.slots.get_mut(&old) {
                slots.remove(&slot);
            }
            dirty.insert(old);
        }
        index
            .slots
            .entry(key)
            .or_default()
            .insert(label.slot, entity);
        dirty.insert(key);
    }
    for (owner, role) in dirty {
        let key = (owner, role);
        let mut slots = index.slots.remove(&key).unwrap_or_default();
        let owner_alive = commands.get_entity(owner).is_ok();
        let request = owner_alive
            .then(|| requests.roles.get(&role)?.get(&owner))
            .flatten();
        let Some(request) = request else {
            for entity in slots.into_values() {
                index.reverse.remove(&entity);
                if let Ok(mut entity) = commands.get_entity(entity) {
                    entity.despawn();
                }
            }
            if !owner_alive {
                if let Some(owners) = requests.roles.get_mut(&role) {
                    owners.remove(&owner);
                }
            }
            continue;
        };
        slots.retain(|slot, entity| {
            if (*slot as usize) < request.labels.len() {
                return true;
            }
            index.reverse.remove(entity);
            if let Ok(mut entity) = commands.get_entity(*entity) {
                entity.despawn();
            }
            false
        });
        for (i, (label, position, size, color)) in request.labels.iter().enumerate() {
            let slot = i as u16;
            let mut reuse = false;
            if let Some(entity) = slots.get(&slot) {
                if let Ok((mut text, mut transform, mut text_color, mut meta)) =
                    text.get_mut(*entity)
                {
                    reuse = true;
                    if text.0 != *label {
                        text.0 = label.clone();
                    }
                    let translation = Vec3::new(position.x, -position.y, request.z);
                    if transform.translation != translation {
                        transform.translation = translation;
                    }
                    let color = Color::LinearRgba(super::layout::hex(*color).to_linear());
                    if text_color.0 != color {
                        text_color.0 = color;
                    }
                    if !meta.matches(*size, request.style.bounds(), request.style.scale_mode()) {
                        meta.set(*size, request.style.bounds(), request.style.scale_mode());
                    }
                }
            }
            if !reuse {
                if let Some(old) = slots.remove(&slot) {
                    index.reverse.remove(&old);
                    if let Ok(mut entity) = commands.get_entity(old) {
                        entity.despawn();
                    }
                }
                let entity = commands
                    .spawn(label_bundle(
                        &visuals,
                        label.clone(),
                        *position,
                        *size,
                        *color,
                        request.z,
                        role,
                        slot,
                        request.style,
                        owner,
                    ))
                    .id();
                slots.insert(slot, entity);
                index.reverse.insert(entity, (key, slot));
            }
        }
        index.slots.insert(key, slots);
    }
}

#[allow(clippy::too_many_arguments)]
fn label_bundle(
    visuals: &CanvasOverlayCache,
    label: String,
    position: Vec2,
    size: f32,
    color: u32,
    z: f32,
    role: CanvasLabelRole,
    slot: u16,
    style: LabelStyle,
    owner: Entity,
) -> impl Bundle {
    let bounds = style.bounds();
    (
        Text2d::new(label),
        TextFont {
            font: visuals.font().into(),
            font_size: FontSize::Px(size),
            ..default()
        },
        TextColor(Color::LinearRgba(super::layout::hex(color).to_linear())),
        style.layout(),
        TextBounds {
            width: bounds.map(|bounds| bounds.x),
            height: bounds.map(|bounds| bounds.y),
        },
        style.anchor(),
        Transform::from_xyz(position.x, -position.y, z),
        style.meta(size),
        CanvasLabel { role, slot },
        ChildOf(owner),
    )
}

#[cfg(test)]
mod tests;
