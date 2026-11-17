//! 运行中节点的进度动画与媒体加载提示
//! （change: add-node-running-progress，design D2）。
//!
//! 运行态节点在内容区显示进度环 + 整数百分比；进度由「本节点加入运行态的经过时间」按
//! 节点种类估算，并与规范上报的 `progress` 取较大者。动画只存在于可丢弃渲染状态：
//! 不修改 revision、规范画布或提交命令。媒体解码/缓冲只显示转圈与「加载中」，不估算百分比。

use std::collections::HashMap;

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use crate::app::{CurrentScene, NodeIndex};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabelRole, CanvasNodeId, RunningProgressLayer,
};
use crate::generation_progress::{display_percent, estimate_percent};

use super::geometry::Geometry;
use super::labels::{LabelOwner, LabelRequests, LabelSpec, LabelStyle, LabelWriter};
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
    mut was_active: Local<bool>,
) {
    // 图片/视频聚焦期间隐藏所有普通节点覆盖层
    // （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 4.2；
    //  change: 2026-10-10-add-video-node-focus-workspace 扩展为视频聚焦）。
    if super::image_focus::has_presented_media_focus(&scene.0) || scene.0.model_focus.is_some() {
        if *was_active {
            clear_overlay(&mut commands, &mut meshes, &layers);
        }
        *was_active = false;
        clock.started.clear();
        clear_running(&mut requests);
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
            ((node.chrome.is_card()
                && (shows_generation_ring(&node) || (node.media_loading && !node.busy)))
                || (matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. })
                    && scene.0.executing_scopes.contains(&node.id)))
            .then_some((entity, depth.render, node))
        })
        .collect();

    // 清理已离开运行态的起点；为新运行节点写入稳定起点。
    clock.started.retain(|id, _| {
        running
            .iter()
            .any(|(_, _, node)| node.busy && &node.id == id)
    });
    for (_, _, node) in &running {
        if node.busy {
            clock.started.entry(node.id.clone()).or_insert(now);
        }
    }

    if running.is_empty() {
        if *was_active {
            clear_overlay(&mut commands, &mut meshes, &layers);
        }
        *was_active = false;
        clock.started.clear();
        clear_running(&mut requests);
        return;
    }

    let mut geometry = Geometry::default();
    let mut staged = Vec::new();
    for (entity, render, node) in &running {
        if matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }) {
            let zoom = scene.0.viewport.zoom.max(0.01);
            let (color, alpha) = crate::scope_visual::execution_border(&theme, now);
            let z = 10.0 + *render as f32 * 0.1 + 0.005;
            // Follow the exact existing dash slots, leaving the spaces and corners intact.
            // Cover the static selected/hover stroke: translucent blending against that
            // constant accent would wash out the dark half of the breathing cycle.
            for (width, opacity, depth) in [(5.0, alpha * 0.15, z), (2.0, 1.0, z + 0.001)] {
                super::dash::dashed_rounded_rect_alpha(
                    &mut geometry,
                    node.x,
                    node.y,
                    node.width,
                    node.height,
                    crate::scope_visual::FRAME_RADIUS,
                    width / zoom,
                    depth,
                    color,
                    opacity,
                );
            }
            let path = crate::scope_visual::rounded_path(
                node.x,
                node.y,
                node.width,
                node.height,
                crate::scope_visual::FRAME_RADIUS,
            );
            for segment in crate::scope_visual::execution_trail(&path, now) {
                let color = crate::scope_visual::execution_trail_color(&theme, now, segment.step);
                let strength = crate::scope_visual::execution_trail_strength(segment.step);
                geometry.line_alpha(
                    segment.start,
                    segment.end,
                    7.0 / zoom,
                    z + 0.002,
                    color,
                    strength * 0.18,
                );
                geometry.line_alpha(
                    segment.start,
                    segment.end,
                    3.0 / zoom,
                    z + 0.003,
                    color,
                    1.0,
                );
            }
            continue;
        }
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
        requests.bind(LabelOwner::Node(node.id.clone()), *entity);
        staged.push((
            LabelOwner::Node(node.id.clone()),
            0,
            LabelSpec::from_label(
                (label, position, RUNNING_LABEL_FONT, accent),
                top_z + 0.01,
                LabelStyle::Running,
            ),
        ));
    }
    replace_running(&mut requests, staged);

    *was_active = true;
    replace_overlay_mesh(
        &mut commands,
        &mut meshes,
        &materials,
        &layers,
        geometry.build(),
    );
}

fn replace_running(requests: &mut LabelRequests, keys: Vec<(LabelOwner, u16, LabelSpec)>) {
    let mut txn = requests.transaction(LabelWriter::Running);
    txn.replace_role(CanvasLabelRole::Running, keys);
    let _ = txn.commit();
}

/// 角色里没有键时不进事务。空闲帧反复调用不得克隆规格或标脏。
fn clear_running(requests: &mut LabelRequests) {
    if !requests.writer_role_occupied(LabelWriter::Running, CanvasLabelRole::Running) {
        return;
    }
    replace_running(requests, Vec::new());
}

/// 清空运行覆盖层（无运行节点时调用一次）。
fn clear_overlay(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    layers: &Query<(Entity, Option<&Mesh2d>), With<RunningProgressLayer>>,
) {
    if let Some((entity, old_handle)) = layers.iter().next() {
        let handle = meshes.add(Geometry::default().build());
        if let Some(old) = old_handle {
            meshes.remove(old.0.id());
        }
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
            if let Some(old) = old_handle {
                meshes.remove(old.0.id());
            }
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(handle));
            }
        }
        None => {
            commands.spawn((
                RunningProgressLayer,
                Mesh2d(handle),
                MeshMaterial2d(materials.blend.clone()),
                NoFrustumCulling,
            ));
        }
    }
}

#[cfg(test)]
mod scope_execution_tests {
    use super::*;
    use crate::protocol::Scene;

    #[test]
    fn frame_execution_reuses_one_layer_and_clears_once_at_terminal_state() {
        let scene = Scene {
            nodes: vec![
                serde_json::from_value(serde_json::json!({
                    "id":"g", "type":"workflow-group-2d", "x":0,"y":0,
                    "width":300,"height":200,"chrome":{"kind":"frame","groupId":"g"}
                }))
                .unwrap(),
            ],
            executing_scopes: vec!["g".into()],
            ..default()
        };
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        let mut app = App::new();
        app.insert_resource(CurrentScene(scene))
            .insert_resource(index)
            .insert_resource(Time::<()>::default())
            .init_resource::<crate::theme::ThemeResource>()
            .init_resource::<Assets<Mesh>>()
            .init_resource::<GenerationClock>()
            .init_resource::<LabelRequests>()
            .insert_resource(super::super::CanvasMaterials {
                solid: default(),
                blend: default(),
                font: default(),
            })
            .add_systems(Update, sync_generation);
        app.world_mut().spawn((
            CanvasNodeId("g".into()),
            CanvasDepth {
                index: 0,
                render: 0,
                z: 10.0,
            },
        ));
        app.update();
        let layer = app
            .world_mut()
            .query_filtered::<(Entity, &Mesh2d), With<RunningProgressLayer>>()
            .single(app.world())
            .unwrap()
            .0;
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 1);
        let colors = |app: &App| {
            let handle = &app.world().get::<Mesh2d>(layer).unwrap().0;
            let mesh = app.world().resource::<Assets<Mesh>>().get(handle).unwrap();
            let Some(bevy::render::mesh::VertexAttributeValues::Float32x4(colors)) =
                mesh.attribute(Mesh::ATTRIBUTE_COLOR)
            else {
                panic!("execution overlay must have vertex colors");
            };
            colors.clone()
        };
        let low = colors(&app);
        app.world_mut()
            .resource_mut::<Time>()
            .advance_by(std::time::Duration::from_millis(900));
        app.update();
        let high = colors(&app);
        assert_ne!(
            low, high,
            "the actual frame mesh must breathe without a new scene"
        );
        assert!(low.iter().any(|color| color[3] == 1.0));
        assert!(
            high.iter().any(|color| color[3] == 1.0),
            "the main stroke must cover a static selected border"
        );
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 1);
        app.world_mut()
            .resource_mut::<CurrentScene>()
            .0
            .executing_scopes
            .clear();
        app.update();
        let cleared = app.world().get::<Mesh2d>(layer).unwrap().0.id();
        app.update();
        assert_eq!(
            app.world().get::<Mesh2d>(layer).unwrap().0.id(),
            cleared,
            "idle frames must not keep allocating blank overlays"
        );
        assert_eq!(app.world().resource::<Assets<Mesh>>().len(), 1);
    }
}

/// 生产调度把 `sync_generation` 放在 `sync_canvas_labels` 之前。这一帧必须能看到运行标签，
/// 不能只留在期望集里等下一帧。
#[cfg(test)]
mod frame_tests {
    use super::*;
    use crate::canvas_ecs::components::CanvasLabel;
    use crate::protocol::{Scene, Viewport};

    #[test]
    fn running_labels_are_applied_in_the_same_frame_as_generation() {
        let scene = Scene {
            nodes: serde_json::from_value(serde_json::json!([
                {"id":"a","type":"image","x":0,"y":0,"width":180,"height":160,"mediaLoading":true},
                {"id":"b","type":"image","x":200,"y":0,"width":180,"height":160,"mediaLoading":true},
                {"id":"far","type":"image","x":10000,"y":0,"width":180,"height":160,"busy":true}
            ]))
            .unwrap(),
            viewport: Viewport {
                x: 0.,
                y: 0.,
                zoom: 1.,
            },
            ..default()
        };
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        let mut world = World::new();
        let owners: Vec<Entity> = scene
            .nodes
            .iter()
            .enumerate()
            .map(|(i, node)| {
                world
                    .spawn((
                        CanvasNodeId(node.id.clone()),
                        CanvasDepth {
                            index: i,
                            render: i,
                            z: 10. + i as f32 * 0.1,
                        },
                    ))
                    .id()
            })
            .collect();
        world.insert_resource(CurrentScene(scene));
        world.insert_resource(index);
        world.insert_resource(Time::<()>::default());
        world.insert_resource(crate::theme::ThemeResource::default());
        world.insert_resource(super::super::CanvasMaterials {
            solid: default(),
            blend: default(),
            font: default(),
        });
        world.insert_resource(GenerationClock::default());
        world.insert_resource(Assets::<Mesh>::default());
        world.insert_resource(LabelRequests::default());
        world.insert_resource(super::super::CanvasOverlayCache::default_for_test());
        let mut schedule = Schedule::default();
        schedule.add_systems((sync_generation, super::super::sync_canvas_labels).chain());
        schedule.run(&mut world);
        world.flush();

        let mut texts = Vec::new();
        for (label, text, child) in world
            .query::<(&CanvasLabel, &Text2d, &ChildOf)>()
            .iter(&world)
        {
            if label.role == CanvasLabelRole::Running && owners.contains(&child.parent()) {
                texts.push(text.0.clone());
            }
        }
        texts.sort();
        assert_eq!(
            texts,
            vec!["1%".to_owned(), "加载中…".to_owned(), "加载中…".to_owned()],
            "sync_generation 提交的 Running 标签必须在同一帧被 sync_canvas_labels 生成"
        );
    }
}
