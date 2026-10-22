//! 节点/group/片场标签实体的生命周期（change: refactor-bevy-rust-file-size 后续拆分）。
//!
//! 普通卡片、group 容器与片场标题共用同一 `Visuals.labels` 实体池：按节点 id keyed，长度可变。
//! 从 `render.rs` 抽出以保持在文件体积上限内（`tests/file_size.rs` 守卫）。
//!
//! 生命周期必须闭合支持 `0 → 1 → 0 → 1`（change:
//! 2026-10-10-improve-film-set-editing-and-inspector，design D2）：片场标题只在
//! hover/选中时出现，反复显隐不能丢失文字或残留实体。因此这里按位置更新已有实体、
//! 补建不足数量、回收多余数量，并在集合为空时删除池条目。只 zip 已存在实体会让
//! 「先隐藏再显示」丢失文字，是本次修复的根因。

use bevy::{prelude::*, sprite::Anchor, text::{LineBreak, TextBounds}};

use super::Visuals;
use super::layout::{hex, label_pool_plan};

/// 标签文案包：`(文案, 位置, 字号, 颜色 0xRRGGBB)`。
pub(crate) type Label = (String, Vec2, f32, u32);

/// 更新/新增/回收某个节点的标签实体（普通卡片、group 容器与片场标题共用）。
///
/// 标签集合长度可变：group/片场只有 1 条标题标签，普通卡片有分类 + 多行正文。
/// 更新已有部分、补建新增部分、回收多余部分；集合为空时**移除池条目**，使下一次
/// 非空集合可以重新补建。内存中残留的旧实体（例如旧版本渲染留下的状态槽）必须回收，
/// 否则已废弃的文案会继续留在卡片上。
pub(crate) fn sync_labels(
    commands: &mut Commands,
    visuals: &mut Visuals,
    text_query: &mut Query<(&mut Text2d, &mut Transform, &mut TextColor), Without<Sprite>>,
    node_id: &str,
    labels: Vec<Label>,
    z: f32,
) {
    // 取出现有实体，避免在补建时同时持有池与 visuals 的可变借用。
    let mut entities = visuals.labels.remove(node_id).unwrap_or_default();
    let (_, _, despawn, retain) = label_pool_plan(entities.len(), labels.len());
    // 回收多余额度。
    for _ in 0..despawn {
        if let Some(entity) = entities.pop() {
            commands.entity(entity).despawn();
        }
    }
    for (index, (label, position, size, color)) in labels.into_iter().enumerate() {
        if let Some(entity) = entities.get(index).copied() {
            if let Ok((mut text, mut transform, mut text_color)) = text_query.get_mut(entity) {
                if text.0 != label {
                    text.0 = label;
                }
                transform.translation = Vec3::new(position.x, -position.y, z);
                text_color.0 = hex(color);
            }
            continue;
        }
        entities.push(spawn_label(
            commands, visuals, label, position, size, color, z,
        ));
    }
    // 空集合不保留占位槽：下次非空调用走 `unwrap_or_default` 重新补建，
    // 这正是「先隐藏再显示」能恢复文字的关键。
    if retain {
        visuals.labels.insert(node_id.to_owned(), entities);
    }
}

/// 生成一条标签文字实体；由调用方决定何时进入/退出实体池。
fn spawn_label(
    commands: &mut Commands,
    visuals: &Visuals,
    label: String,
    position: Vec2,
    size: f32,
    color: u32,
    z: f32,
) -> Entity {
    commands
        .spawn((
            Text2d::new(label),
            TextFont {
                font: visuals.font.clone().into(),
                font_size: FontSize::Px(size),
                ..default()
            },
            TextColor(hex(color)),
            TextLayout::new(Justify::Left, LineBreak::NoWrap),
            TextBounds {
                width: Some(600.),
                height: Some(48.),
            },
            Anchor::TOP_LEFT,
            Transform::from_xyz(position.x, -position.y, z),
        ))
        .id()
}
