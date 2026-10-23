//! 运行中节点的进度动画与媒体加载提示
//! （change: add-node-running-progress，design D2）。
//!
//! 运行态节点在内容区显示进度环 + 整数百分比；进度由「本节点加入运行态的经过时间」按
//! 节点种类估算，并与规范上报的 `progress` 取较大者。动画只存在于可丢弃渲染状态：
//! 不修改 revision、规范画布或提交命令。媒体解码/缓冲只显示转圈与「加载中」，不估算百分比。

use std::collections::HashMap;

use bevy::{prelude::*, camera::visibility::NoFrustumCulling, sprite::Anchor, text::LineBreak};

use crate::app::CurrentScene;
use crate::generation_progress::{display_percent, estimate_percent};

use super::Visuals;
use super::geometry::Geometry;
use super::layout::{generation_ring_rect, shows_generation_ring};
use super::text_presentation::{LogicalText, TextScaleMode};

/// 运行状态/加载提示的逻辑字号（世界单位）。
const RUNNING_LABEL_FONT: f32 = 13.0;

/// 每个运行节点的动画起点（秒，`Time::elapsed_secs`）。
///
/// 条目只在节点首次进入 `busy` 时写入；同一 run 内的 scene 刷新不重置起点，
/// 节点离开 `busy` 时移除。
#[derive(Resource, Default)]
pub(crate) struct GenerationClock {
    pub(crate) started: HashMap<String, f32>,
}

/// 每帧消费运行节点：推进 `GenerationClock` 起点并重建覆盖层（内容面 + 进度环 + 百分比）。
///
/// 不受 `FrameFlags.changed` 门禁：进度动画必须逐帧更新。空闲（无 `busy` 节点）时
/// 不产生任何几何；从「有运行节点」变为「无」时清空一次。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_generation(
    mut commands: Commands,
    time: Res<Time>,
    scene: Res<CurrentScene>,
    theme: Res<crate::theme::ThemeResource>,
    mut visuals: ResMut<Visuals>,
    mut clock: ResMut<GenerationClock>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut text_query: Query<(&mut Text2d, &mut Transform, &mut TextColor, &mut LogicalText), Without<Sprite>>,
) {
    // 图片/视频聚焦期间隐藏所有普通节点覆盖层
    // （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.2；
    //  change: 2026-10-10-add-video-node-focus-workspace 扩展为视频聚焦）。
    if super::image_focus::has_presented_media_focus(&scene.0) {
        clear_overlay(&mut commands, &mut visuals, &mut meshes);
        return;
    }
    let now = time.elapsed_secs();
    let running: Vec<&crate::protocol::GraphNode> = scene
        .0
        .nodes
        .iter()
        .filter(|node| {
            // 进度/加载覆盖层只作用于普通内容节点：
            // - 生成任务：`shows_generation_ring` 覆盖紧凑与纯模型节点
            //   （change: 2026-10-12-unify-generation-history-strip）；
            // - 媒体解码/缓冲：`media_loading`（change: 2026-10-12-unify-node-editors-and-focus-transitions）。
            // 聚合节点（复合资产）用运行遮罩、group 用容器呈现，都不走此覆盖层。
            let plain = node.group.is_none() && node.composite_asset.is_none();
            plain && (shows_generation_ring(node) || (node.media_loading && !node.busy))
        })
        .collect();

    // 清理已离开运行态的起点；为新运行节点写入稳定起点。
    clock
        .started
        .retain(|id, _| running.iter().any(|node| node.busy && &node.id == id));
    for node in &running {
        if node.busy {
            clock.started.entry(node.id.clone()).or_insert(now);
        }
    }

    if running.is_empty() {
        clear_overlay(&mut commands, &mut visuals, &mut meshes);
        return;
    }

    let mut geometry = Geometry::default();
    let mut active: Vec<String> = Vec::with_capacity(running.len());
    for node in &running {
        active.push(node.id.clone());
        // 该节点在文档中的 z 带（与卡片外壳同一公式）。进度覆盖层必须落在自身 z 带内，
        // 才能被上层卡片正确遮挡（change: 2026-10-09-fix-model-preview-layering-and-projection）。
        let index = scene
            .0
            .nodes
            .iter()
            .position(|candidate| candidate.id == node.id)
            .unwrap_or(0);
        let top_z = 10.0 + index as f32 * 0.1 + 0.01;
        let (accent, _, _) = theme.node_palette(&node.kind);
        let (cx, cy, cw, ch) = generation_ring_rect(node);
        // 内容面：与卡片内容区同形，作为进度环承载面（等价于预览区被替换）。
        geometry.rounded_rect(
            cx,
            cy,
            cw,
            ch,
            3.,
            top_z,
            theme.token_u32("canvasNodeContent"),
        );
        let center = Vec2::new(cx + cw / 2.0, cy + ch / 2.0);
        let radius = (cw.min(ch) * 0.18).clamp(12.0, 28.0);
        let (label, position) = if node.media_loading && !node.busy {
            geometry.loading_ring(
                center - Vec2::Y * 8.,
                radius,
                now * 3.,
                accent,
                theme.token_u32("canvasProgressTrack"),
                top_z + 0.001,
            );
            ("加载中…".to_owned(), center + Vec2::Y * (radius + 8.))
        } else {
            let estimated = estimate_percent(now - clock.started[&node.id], &node.kind);
            let percent = display_percent(estimated, node.progress);
            geometry.progress_ring(
                center,
                radius,
                percent,
                accent,
                theme.token_u32("canvasProgressTrack"),
                top_z + 0.001,
            );
            (format!("{}%", percent.round() as i32), center)
        };
        update_label(
            &mut commands,
            &mut visuals,
            &mut text_query,
            &node.id,
            label,
            position,
            top_z + 0.01,
            accent,
        );
    }

    // 移除已不运行的百分比标签。
    let stale: Vec<String> = visuals
        .running_labels
        .keys()
        .filter(|id| !active.contains(id))
        .cloned()
        .collect();
    for id in stale {
        if let Some(entity) = visuals.running_labels.remove(&id) {
            commands.entity(entity).despawn();
        }
    }

    replace_overlay_mesh(&mut commands, &mut visuals, &mut meshes, geometry.build());
    visuals.running_active = true;
}

/// 更新或新建一个运行节点的百分比标签。
#[allow(clippy::too_many_arguments)]
fn update_label(
    commands: &mut Commands,
    visuals: &mut Visuals,
    text_query: &mut Query<(&mut Text2d, &mut Transform, &mut TextColor, &mut LogicalText), Without<Sprite>>,
    id: &str,
    label: String,
    position: Vec2,
    z: f32,
    color: u32,
) {
    if let Some(entity) = visuals.running_labels.get(id).copied() {
        if let Ok((mut text, mut transform, mut text_color, mut meta)) = text_query.get_mut(entity) {
            if text.0 != label {
                text.0 = label;
            }
            transform.translation = Vec3::new(position.x, -position.y, z);
            text_color.0 = super::layout::hex(color);
            if !meta.matches(RUNNING_LABEL_FONT, None, TextScaleMode::World) {
                meta.set(RUNNING_LABEL_FONT, None, TextScaleMode::World);
            }
            return;
        }
    }
    let entity = commands
        .spawn((
            Text2d::new(label),
            TextFont {
                font: visuals.font.clone().into(),
                font_size: FontSize::Px(RUNNING_LABEL_FONT),
                ..default()
            },
            TextColor(super::layout::hex(color)),
            TextLayout::new(Justify::Center, LineBreak::NoWrap),
            Anchor::CENTER,
            Transform::from_xyz(position.x, -position.y, z),
            LogicalText::world(RUNNING_LABEL_FONT, None),
        ))
        .id();
    visuals.running_labels.insert(id.to_owned(), entity);
}

/// 清空运行覆盖层（无运行节点时调用一次）。
fn clear_overlay(commands: &mut Commands, visuals: &mut Visuals, meshes: &mut Assets<Mesh>) {
    for (_, entity) in visuals.running_labels.drain() {
        commands.entity(entity).despawn();
    }
    if visuals.running_active {
        // 从「有运行节点」变为「无」：用不可见兜底几何替换旧覆盖层，然后释放实体句柄。
        if let Some(entity) = visuals.running_mesh_entity {
            let handle = meshes.add(Geometry::default().build());
            let old = std::mem::replace(&mut visuals.running_mesh, handle.clone());
            meshes.remove(&old);
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(handle));
            }
        }
        visuals.running_active = false;
    }
}

/// 替换运行覆盖层共享 mesh（首个运行节点出现时创建实体）。
fn replace_overlay_mesh(
    commands: &mut Commands,
    visuals: &mut Visuals,
    meshes: &mut Assets<Mesh>,
    built: Mesh,
) {
    let handle = meshes.add(built);
    match visuals.running_mesh_entity {
        Some(entity) => {
            let old = std::mem::replace(&mut visuals.running_mesh, handle.clone());
            meshes.remove(&old);
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(handle));
            }
        }
        None => {
            visuals.running_mesh = handle.clone();
            let entity = commands
                .spawn((
                    Mesh2d(handle),
                    MeshMaterial2d(visuals.blend_material.clone()),
                    NoFrustumCulling,
                ))
                .id();
            visuals.running_mesh_entity = Some(entity);
        }
    }
}
