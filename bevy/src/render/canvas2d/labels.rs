//! 标签实体生命周期：稳定 owner 期望集 + 脏键同步。
//!
//! 期望集在 [`store`]。同步只处理 Labels 还没 ack 的脏键，以及本帧被拆掉或改挂的
//! 标签实体。无脏键时不扫描文字。比较后才写 `Text2d` / `Transform` / `TextColor`。

use bevy::{
    prelude::*,
    sprite::Anchor,
    text::{LineBreak, TextBounds},
};

use crate::canvas_ecs::components::{CanvasLabel, CanvasLabelRole};
use crate::canvas2d::CanvasOverlayCache;
use crate::canvas2d::text_presentation::{LogicalText, TextScaleMode};

mod store;

pub(crate) use store::{
    LabelConsumer, LabelOwner, LabelRequests, LabelSpec, LabelStyle, LabelWriter,
};

/// 标签文案包：`(文案, 位置, 字号, 颜色 0xRRGGBB)`。
///
/// 「字号」是**逻辑字号**（世界单位）：实际 `TextFont` 由
/// [`super::text_presentation`] 按相机缩放与 DPR 派生，绘制侧不直接写栅格字号
/// （change: 2026-10-22-improve-canvas-text-clarity，design D1）。
pub(crate) type Label = (String, Vec2, f32, u32);

/// 标签逻辑 bounds（世界单位）。截断由调用方按逻辑宽度决定，栅格 bounds 按同一比例换算。
const LABEL_BOUNDS: Vec2 = Vec2::new(600.0, 48.0);

impl LabelSpec {
    pub(crate) fn from_label(label: Label, z: f32, style: LabelStyle) -> Self {
        let (text, position, size, color) = label;
        Self {
            text,
            position,
            size,
            color,
            z,
            style,
        }
    }
}

impl LabelStyle {
    pub(super) fn anchor(self) -> Anchor {
        match self {
            LabelStyle::Attach | LabelStyle::Node | LabelStyle::NodeAction => Anchor::TOP_LEFT,
            LabelStyle::Running | LabelStyle::Edge => Anchor::CENTER,
        }
    }

    pub(super) fn layout(self) -> TextLayout {
        match self {
            LabelStyle::Running => TextLayout::new(Justify::Center, LineBreak::NoWrap),
            _ => TextLayout::new(Justify::Left, LineBreak::NoWrap),
        }
    }

    pub(super) fn bounds(self) -> Option<Vec2> {
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

    pub(super) fn scale_mode(self) -> TextScaleMode {
        match self {
            LabelStyle::NodeAction => TextScaleMode::Screen,
            _ => TextScaleMode::World,
        }
    }
}

/// 父实体锚点。删除事件只报告拆掉这个组件的实体，稳定帧不扫描绑定表。
#[derive(Component)]
pub(crate) struct LabelAnchor;

/// 换画布时丢掉旧脏队列，拆掉旧标签，并让几何缓存命中后仍重提标签。
/// 空 canvas id 不换，和投影的身份缺失语义一致。
pub(crate) fn observe_label_epoch(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    mut requests: ResMut<LabelRequests>,
    mut cards: ResMut<super::CardBlockCache>,
    mut edges: ResMut<super::EdgeBlockCache>,
) {
    let Some(stale) = requests.observe_canvas(&scene.0.canvas_id) else {
        return;
    };
    for entity in stale {
        commands.entity(entity).despawn();
    }
    cards.invalidate_labels();
    edges.invalidate_labels();
}

/// 只同步未 ack 的脏键。外部拆掉或改挂的实体在同一帧补回绑定父级。
pub(crate) fn sync_canvas_labels(
    mut commands: Commands,
    mut requests: ResMut<LabelRequests>,
    visuals: Res<CanvasOverlayCache>,
    mut removed: RemovedComponents<CanvasLabel>,
    mut removed_anchors: RemovedComponents<LabelAnchor>,
    moved: Query<(Entity, &ChildOf), (With<CanvasLabel>, Changed<ChildOf>)>,
    parents: Query<&ChildOf>,
    mut text: Query<(
        &mut Text2d,
        &mut Transform,
        &mut TextColor,
        &mut LogicalText,
    )>,
) {
    let work = requests.label_work();
    requests.note_request_clones(work.spec_clones);
    // 先摘掉本帧消失的父锚点，再修子标签。否则子标签删除会先清掉 owner 槽位，
    // 访问量少算，并且会为已经不存在的父级克隆规格。
    for entity in requests.take_pending_anchors() {
        if let Ok(mut entity_commands) = commands.get_entity(entity) {
            entity_commands.insert(LabelAnchor);
        } else {
            requests.reap_removed_bindings([entity]);
        }
    }
    let removed_parents: Vec<Entity> = removed_anchors.read().collect();
    requests.reap_removed_bindings(removed_parents);
    for item in work.dirty {
        apply_dirty(
            &mut commands,
            &mut requests,
            &visuals,
            &parents,
            &mut text,
            &item,
        );
    }
    let removed: Vec<Entity> = removed.read().collect();
    for entity in removed {
        repair_removed(&mut commands, &mut requests, &visuals, entity);
    }
    let moved: Vec<(Entity, Entity)> = moved
        .iter()
        .map(|(entity, child)| (entity, child.parent()))
        .collect();
    for (entity, parent) in moved {
        repair_moved(&mut commands, &mut requests, &visuals, entity, parent);
    }
    requests.ack(LabelConsumer::Labels, work.through, work.epoch);
}

fn apply_dirty(
    commands: &mut Commands,
    requests: &mut LabelRequests,
    visuals: &CanvasOverlayCache,
    parents: &Query<&ChildOf>,
    text: &mut Query<(
        &mut Text2d,
        &mut Transform,
        &mut TextColor,
        &mut LogicalText,
    )>,
    item: &store::LabelDirty,
) {
    let applied = requests.applied(item.role, &item.owner, item.slot);
    let Some(spec) = item.spec.as_ref().filter(|_| !item.tombstone).cloned() else {
        despawn_applied(commands, requests, applied);
        return;
    };
    requests.note_request_clones(1);
    let Some(parent) = requests.binding(&item.owner) else {
        despawn_applied(commands, requests, applied);
        return;
    };
    if commands.get_entity(parent).is_err() {
        requests.unbind_owner(&item.owner);
        despawn_applied(commands, requests, applied);
        return;
    }
    if let Some(entity) = applied {
        if parents
            .get(entity)
            .is_ok_and(|child| child.parent() != parent)
        {
            despawn_applied(commands, requests, Some(entity));
            spawn_label(commands, requests, visuals, item, &spec, parent);
            return;
        }
        if let Ok((mut text, mut transform, mut text_color, mut meta)) = text.get_mut(entity) {
            let writes =
                write_if_changed(&mut text, &mut transform, &mut text_color, &mut meta, &spec);
            requests.note_component_writes(writes);
            return;
        }
        requests.forget_entity(entity);
    }
    spawn_label(commands, requests, visuals, item, &spec, parent);
}

fn write_if_changed(
    text: &mut Mut<Text2d>,
    transform: &mut Mut<Transform>,
    text_color: &mut Mut<TextColor>,
    meta: &mut Mut<LogicalText>,
    spec: &LabelSpec,
) -> u64 {
    let mut writes = 0;
    if text.0 != spec.text {
        text.0.clone_from(&spec.text);
        writes += 1;
    }
    let translation = Vec3::new(spec.position.x, -spec.position.y, spec.z);
    if transform.translation != translation {
        transform.translation = translation;
        writes += 1;
    }
    let next_color = label_color(spec.color);
    if text_color.0 != next_color {
        text_color.0 = next_color;
        writes += 1;
    }
    if !meta.matches(spec.size, spec.style.bounds(), spec.style.scale_mode()) {
        meta.set(spec.size, spec.style.bounds(), spec.style.scale_mode());
        writes += 1;
    }
    writes
}

fn repair_removed(
    commands: &mut Commands,
    requests: &mut LabelRequests,
    visuals: &CanvasOverlayCache,
    entity: Entity,
) {
    let Some((role, owner, slot)) = requests.forget_entity(entity) else {
        return;
    };
    if requests.applied(role, &owner, slot).is_some() {
        return;
    }
    let Some(spec) = requests.spec_at(role, &owner, slot) else {
        return;
    };
    let Some(parent) = requests.binding(&owner) else {
        return;
    };
    if commands.get_entity(parent).is_err() {
        requests.unbind_owner(&owner);
        return;
    }
    let item = store::LabelDirty {
        role,
        owner,
        slot,
        tombstone: false,
        spec: None,
    };
    spawn_label(commands, requests, visuals, &item, &spec, parent);
}

fn repair_moved(
    commands: &mut Commands,
    requests: &mut LabelRequests,
    visuals: &CanvasOverlayCache,
    entity: Entity,
    parent: Entity,
) {
    let Some((role, owner, slot)) = requests.applied_key(entity) else {
        return;
    };
    if requests.binding(&owner) == Some(parent) {
        return;
    }
    let spec = requests.spec_at(role, &owner, slot);
    let bound = requests.binding(&owner);
    despawn_applied(commands, requests, Some(entity));
    let (Some(spec), Some(bound)) = (spec, bound) else {
        return;
    };
    if commands.get_entity(bound).is_err() {
        return;
    }
    let item = store::LabelDirty {
        role,
        owner,
        slot,
        tombstone: false,
        spec: None,
    };
    spawn_label(commands, requests, visuals, &item, &spec, bound);
}

fn despawn_applied(commands: &mut Commands, requests: &mut LabelRequests, entity: Option<Entity>) {
    let Some(entity) = entity else {
        return;
    };
    requests.forget_entity(entity);
    commands.entity(entity).despawn();
}

fn spawn_label(
    commands: &mut Commands,
    requests: &mut LabelRequests,
    visuals: &CanvasOverlayCache,
    item: &store::LabelDirty,
    spec: &LabelSpec,
    parent: Entity,
) {
    let entity = commands
        .spawn(label_bundle(
            visuals,
            spec.text.clone(),
            spec.position,
            spec.size,
            spec.color,
            spec.z,
            item.role,
            item.slot,
            spec.style,
            parent,
        ))
        .id();
    // 创建写入文字、变换、颜色和排版元数据。静止帧不再走这条路径。
    requests.note_component_writes(4);
    requests.note_applied(item.role, item.owner.clone(), item.slot, entity);
}

/// 主题色是 sRGB。创建和复用都存等价的 `LinearRgba`，比较与文字提取走同一线性值。
fn label_color(color: u32) -> Color {
    Color::LinearRgba(super::layout::hex(color).to_linear())
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
        TextColor(label_color(color)),
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
mod access_tests;
#[cfg(test)]
mod expectation_tests;
#[cfg(test)]
mod tests;
