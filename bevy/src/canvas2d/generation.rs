//! 运行中节点的进度动画与媒体加载提示
//! （change: add-node-running-progress，design D2）。
//!
//! 运行态节点在内容区显示进度环 + 整数百分比；进度由「本节点加入运行态的经过时间」按
//! 节点种类估算，并与规范上报的 `progress` 取较大者。动画只存在于可丢弃渲染状态：
//! 不修改 revision、规范画布或提交命令。媒体解码/缓冲只显示转圈与「加载中」，不估算百分比。

use std::collections::HashMap;

use bevy::{prelude::*, camera::visibility::NoFrustumCulling};

use crate::app::{CurrentScene, NodeIndex};
use crate::canvas_ecs::components::{CanvasDepth, CanvasLabelRole, CanvasNodeId, RunningProgressLayer};
use crate::generation_progress::{display_percent, estimate_percent};

use super::geometry::Geometry;
use super::labels::{LabelRequests, LabelStyle};
use super::layout::{generation_ring_rect, shows_generation_ring};

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
    index: Res<NodeIndex>,
    theme: Res<crate::theme::ThemeResource>,
    materials: Res<super::CanvasMaterials>,
    mut clock: ResMut<GenerationClock>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    nodes: Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
    layers: Query<(Entity, Option<&Mesh2d>), With<RunningProgressLayer>>,
) {
    requests.begin(CanvasLabelRole::Running);
    // 图片/视频聚焦期间隐藏所有普通节点覆盖层
    // （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.2；
    //  change: 2026-10-10-add-video-node-focus-workspace 扩展为视频聚焦）。
    if super::image_focus::has_presented_media_focus(&scene.0) || scene.0.model_focus.is_some() {
        clear_overlay(&mut commands, &mut meshes, &layers);
        return;
    }
    let now = time.elapsed_secs();
    // 只读公共 ECS 组件定位候选节点，完整绘制 DTO 仍按 id 从同代快照取。
    let running: Vec<(Entity, usize, crate::protocol::GraphNode)> = nodes
        .iter()
        .filter_map(|(entity, id, depth)| {
            let node = crate::canvas_ecs::node_for_draw(&scene.0, &index, &id.0)?.into_owned();
            // 进度/加载覆盖层只作用于普通内容节点：
            // - 生成任务：`shows_generation_ring` 覆盖紧凑与纯模型节点
            //   （change: 2026-10-12-unify-generation-history-strip）；
            // - 媒体解码/缓冲：`media_loading`（change: 2026-10-12-unify-node-editors-and-focus-transitions）。
            (shows_generation_ring(&node) || (node.media_loading && !node.busy))
                .then_some((entity, depth.render, node))
        })
        .collect();

    // 清理已离开运行态的起点；为新运行节点写入稳定起点。
    clock
        .started
        .retain(|id, _| running.iter().any(|(_, _, node)| node.busy && &node.id == id));
    for (_, _, node) in &running {
        if node.busy {
            clock.started.entry(node.id.clone()).or_insert(now);
        }
    }

    if running.is_empty() {
        clear_overlay(&mut commands, &mut meshes, &layers);
        return;
    }

    let mut geometry = Geometry::default();
    for (entity, render, node) in &running {
        // 该节点在文档中的 z 带（与卡片外壳同一公式）。进度覆盖层必须落在自身 z 带内，
        // 才能被上层卡片正确遮挡（change: 2026-10-09-fix-model-preview-layering-and-projection）。
        let top_z = 10.0 + *render as f32 * 0.1 + 0.01;
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
            // 运行已持续的秒数优先取投影下发的权威起点（与活动面板同一始点，change:
            // 2026-10-31-unify-node-and-activity-progress）；缺失时退回本渲染器记录的首次
            // 进入运行态时刻。
            let elapsed = match node.progress_started_at {
                Some(started) => {
                    let current = crate::clock::epoch_millis();
                    if current > 0.0 {
                        ((current - started) / 1000.0) as f32
                    } else {
                        now - clock.started[&node.id]
                    }
                }
                None => now - clock.started[&node.id],
            };
            let estimated = estimate_percent(elapsed, &node.kind);
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
        requests.push(
            CanvasLabelRole::Running,
            *entity,
            vec![(label, position, RUNNING_LABEL_FONT, accent)],
            top_z + 0.01,
            LabelStyle::Running,
        );
    }

    replace_overlay_mesh(&mut commands, &mut meshes, &materials, &layers, geometry.build());
}

/// 清空运行覆盖层（无运行节点时调用一次）。
fn clear_overlay(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    layers: &Query<(Entity, Option<&Mesh2d>), With<RunningProgressLayer>>,
) {
    if let Some((entity, old_handle)) = layers.iter().next() {
        let handle = meshes.add(Geometry::default().build());
        if let Some(old) = old_handle { meshes.remove(old.0.id()); }
        if let Ok(mut entity_commands) = commands.get_entity(entity) {
            entity_commands.insert(Mesh2d(handle));
        }
    }
}

/// 替换运行覆盖层共享 mesh（首个运行节点出现时创建实体）。
fn replace_overlay_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &super::CanvasMaterials,
    layers: &Query<(Entity, Option<&Mesh2d>), With<RunningProgressLayer>>,
    built: Mesh,
) {
    let handle = meshes.add(built);
    match layers.iter().next() {
        Some((entity, old_handle)) => {
            if let Some(old) = old_handle { meshes.remove(old.0.id()); }
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(handle));
            }
        }
        None => {
            commands.spawn((RunningProgressLayer, Mesh2d(handle), MeshMaterial2d(materials.blend.clone()), NoFrustumCulling));
        }
    }
}
