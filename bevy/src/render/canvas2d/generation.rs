//! 运行中节点的进度动画与媒体加载提示（change: add-node-running-progress，design D2）。
//!
//! 运行态节点显示进度环 + 整数百分比，进度取「加入运行态的经过时间」估算与上报值的较大者；
//! 媒体解码/缓冲只显示转圈与「加载中」。动画只存在于可丢弃渲染状态：不修改 revision、
//! 规范画布或提交命令。覆盖层输入集按场景代数缓存，纯平移/视口/动画帧不再全表扫描节点。

use std::collections::{HashMap, HashSet};

use bevy::{
    camera::visibility::{NoCpuCulling, NoFrustumCulling},
    prelude::*,
};

use crate::app::{CurrentScene, NodeIndex, SurfaceState};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabelRole, CanvasNodeId, RunningProgressLayer,
};
use crate::canvas_runtime::Aabb;
use crate::generation_progress::{display_percent, estimate_percent};

use super::geometry::Geometry;
use super::labels::{LabelOwner, LabelRequests, LabelSpec, LabelStyle, LabelWriter};
use super::layout::{generation_ring_rect, shows_content, shows_generation_ring};

#[cfg(test)]
use crate::canvas_ecs::components::CardPresentation;

/// 运行状态/加载提示的逻辑字号（世界单位）。
const RUNNING_LABEL_FONT: f32 = 13.0;
/// 屏幕投影字号低于该像素阈值时跳过标签实体，避免远景成千个不可读文字拖垮 Text2d。
const RUNNING_LABEL_MIN_SCREEN_PX: f32 = 4.0;

/// 媒体加载转圈覆盖层实体标记；共享弧段 `Mesh2d` 句柄并通过 `Transform` 旋转驱动动画。
#[derive(Component)]
pub(crate) struct LoadingSpinner {
    pub(crate) owner: Entity,
}

#[derive(Clone, PartialEq, Eq)]
enum StaticOverlayEntry {
    Loading {
        entity: Entity,
        center: [u32; 2],
        radius: u32,
        top_z: u32,
        track: u32,
        backdrop: Option<u32>,
        rect: Option<[u32; 4]>,
    },
    Progress {
        entity: Entity,
        center: [u32; 2],
        radius: u32,
        top_z: u32,
        accent: u32,
        track: u32,
        percent: i32,
        backdrop: Option<u32>,
        rect: Option<[u32; 4]>,
    },
}

/// 当前写在节点实体上的覆盖层阶段；只有正在画进度环/加载环的节点带它。
///
/// `phase` 是阶段自身的动画相位（加载环 = 旋转弧度，进度环 = 显示百分比）。去重键还须带上
/// 环心与配色：平移帧改变坐标、主题切换改变强调色，只比 `(kind, phase)` 会画出残影。
#[derive(Component, Clone, Copy, Debug, PartialEq)]
pub(crate) struct NodeGenerationVisualStage {
    pub(crate) kind: NodeGenerationVisualStageKind,
    pub(crate) phase: f32,
    /// 环心世界坐标（x, y）。
    pub(crate) center: [f32; 2],
    /// 环半径（世界单位）。
    pub(crate) radius: f32,
    /// 主题强调色 token（`ThemeResource::node_palette` 的原值）。
    pub(crate) accent: u32,
}

/// 覆盖层阶段种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NodeGenerationVisualStageKind {
    /// 媒体解码/缓冲：转圈 +「加载中…」。
    Loading,
    /// 生成任务：进度环 + 整数百分比。
    Progress,
}

/// 每个运行节点的动画起点（秒）与覆盖层活跃集缓存。
///
/// `started` 只在节点首次进入 `busy` 时写入，同一 run 内的 scene 刷新不重置起点。
#[derive(Resource, Default)]
pub(crate) struct GenerationClock {
    pub(crate) started: HashMap<String, f32>,
    /// 需要运行覆盖层的节点实体；场景快照与资源状态补丁时整表重建，其余帧复用。
    pub(crate) active_entities: Vec<Entity>,
    /// `active_entities` 是否对应当前场景代数；`false` 时下一帧必须重建。
    pub(crate) cached: bool,
    /// 已写入实体的阶段快照，去重键为 `(阶段, phase_bucket)`；`active_count == 0` 时非场景帧零遍历。
    pub(crate) last_staged: Vec<(Entity, NodeGenerationVisualStage, u32)>,
    pub(crate) last_staged_index: HashMap<Entity, usize>,
    pub(crate) active_count: usize,
    /// 按 `(radius_bits, color)` 共享的加载旋转弧 Mesh。
    pub(crate) spinner_meshes: HashMap<(u32, u32), Handle<Mesh>>,
    /// 测试观测：全表重建次数 / 缓存帧遍历数 / 去重后的实际写入数。
    #[cfg(test)]
    pub(crate) full_scans: u64,
    #[cfg(test)]
    pub(crate) cached_visits: usize,
    #[cfg(test)]
    pub(crate) stage_writes: u64,
}

impl GenerationClock {
    /// 清空全部覆盖层缓存；只清 `started` 而留下活跃集会画出上一代的覆盖层。
    pub(crate) fn reset(&mut self) {
        self.started.clear();
        self.active_entities.clear();
        self.active_count = 0;
        self.cached = false;
        self.last_staged.clear();
        self.last_staged_index.clear();
    }
}

#[derive(Default)]
pub(crate) struct SyncGenerationCache {
    was_active: bool,
    idle_clean: bool,
    last_static_key: Option<Vec<StaticOverlayEntry>>,
    last_labels: Option<Vec<(LabelOwner, u16, LabelSpec)>>,
}

/// 每帧消费运行节点：推进 `GenerationClock` 起点并同步覆盖层（内容面 + 进度环 + 共享转圈 + 标签）。
///
/// 不受 `FrameFlags.changed` 门禁；空闲时不产生几何，从「有」变「无」时清空一次。
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
    mut spinners: Query<(Entity, &LoadingSpinner, &mut Transform, &Mesh2d)>,
    surface: Option<Res<SurfaceState>>,
    flags: Option<Res<crate::app::FrameFlags>>,
    mut cache: Local<SyncGenerationCache>,
) {
    // 图片/视频聚焦期间隐藏所有普通节点覆盖层（change: 2026-10-08-add-image-focus-editing-
    // and-unified-node-history 任务 4.2；change: 2026-10-10-add-video-node-focus-workspace）。
    // 聚焦期间保留 `clock.started`，避免退回画布时丢失正在运行节点的计时起点。
    if super::image_focus::has_presented_media_focus(&scene.0) || scene.0.model_focus.is_some() {
        if cache.was_active {
            clear_overlay(&mut commands, &mut meshes, &layers);
        }
        clear_spinners(&mut commands, &mut meshes, &mut clock, &spinners);
        let stale = std::mem::take(&mut clock.active_entities);
        retire_stages(&mut commands, &mut clock, &stale);
        clock.active_count = 0;
        clock.cached = false;
        cache.was_active = false;
        cache.idle_clean = false;
        cache.last_static_key = None;
        cache.last_labels = None;
        clear_running(&mut requests);
        return;
    }
    // 只有完整场景快照与资源状态补丁会改变活跃集：后者是唯一能在非 scene 帧改
    // `media_loading` 的路径（`ingest_bridge`）。纯视口/位置增量复用缓存。
    let scene_state_changed = flags
        .as_ref()
        .is_none_or(|flags| flags.scene_received || !flags.resource_nodes.is_empty());
    let rebuild = !clock.cached || scene_state_changed;
    if !rebuild {
        if clock.active_entities.is_empty() {
            // 缓存确认没有要画的节点：0 实体扫描直接返回。
            clock.active_count = 0;
            if cache.was_active {
                clear_overlay(&mut commands, &mut meshes, &layers);
                clear_running(&mut requests);
            }
            clear_spinners(&mut commands, &mut meshes, &mut clock, &spinners);
            cache.was_active = false;
            cache.idle_clean = true;
            cache.last_static_key = None;
            cache.last_labels = None;
            return;
        }
        if !cache.was_active && cache.idle_clean {
            return;
        }
    }
    let now = time.elapsed_secs();

    // 重建帧逐节点筛选；缓存帧只回看上一帧的活跃实体，两路共用同一套取值。
    let previous = std::mem::take(&mut clock.active_entities);
    #[cfg(test)]
    {
        clock.full_scans += u64::from(rebuild);
        clock.cached_visits += usize::from(!rebuild) * previous.len();
    }
    let active: Vec<(
        Entity,
        usize,
        std::borrow::Cow<'_, crate::protocol::GraphNode>,
    )> = if rebuild {
        // 上一代阶段快照整体作废，稍后按新集重写。
        clock.last_staged.clear();
        clock.last_staged_index.clear();
        clock.cached = true;
        // 只读公共 ECS 组件定位候选节点，完整绘制 DTO 仍按 id 从同代快照借用（零克隆）。
        nodes
            .iter()
            .filter_map(|(entity, _, _)| overlay_entry(entity, &scene.0, &index, &nodes))
            .collect()
    } else {
        previous
            .iter()
            .filter_map(|entity| overlay_entry(*entity, &scene.0, &index, &nodes))
            .collect()
    };
    if !rebuild && active.len() == previous.len() {
        // !rebuild 只能保留 previous 的子集：长度相等即没有任何实体离开，免建 HashSet。
        clock.active_entities = previous;
        clock.active_count = clock.active_entities.len();
    } else {
        clock.active_entities = active.iter().map(|(entity, _, _)| *entity).collect();
        clock.active_count = clock.active_entities.len();
        let active_set: HashSet<Entity> = clock.active_entities.iter().copied().collect();
        // 回收到期实体：已回收、已离开场景或不再需要覆盖层的节点（O(N) 哈希判重）。
        let retired: Vec<Entity> = previous
            .into_iter()
            .filter(|entity| !active_set.contains(entity))
            .collect();
        retire_stages(&mut commands, &mut clock, &retired);
    }

    if active.is_empty() {
        if cache.was_active {
            clear_overlay(&mut commands, &mut meshes, &layers);
        }
        clear_spinners(&mut commands, &mut meshes, &mut clock, &spinners);
        cache.was_active = false;
        cache.idle_clean = true;
        cache.last_static_key = None;
        cache.last_labels = None;
        clock.active_count = 0;
        clock.started.clear();
        clock.last_staged.clear();
        clock.last_staged_index.clear();
        clear_running(&mut requests);
        return;
    }
    cache.idle_clean = false;

    // 清理已离开运行态的起点；为新运行节点写入稳定起点（含视口外节点）。
    if !clock.started.is_empty() {
        if clock.started.len() > 8 {
            let busy_ids: HashSet<&str> = active
                .iter()
                .filter(|(_, _, node)| node.busy)
                .map(|(_, _, node)| node.id.as_str())
                .collect();
            clock.started.retain(|id, _| busy_ids.contains(id.as_str()));
        } else {
            clock.started.retain(|id, _| {
                active
                    .iter()
                    .any(|(_, _, node)| node.busy && &node.id == id)
            });
        }
    }
    for (_, _, node) in &active {
        if node.busy {
            clock.started.entry(node.id.clone()).or_insert(now);
        }
    }

    let visible_bounds = surface
        .as_ref()
        .filter(|surface| surface.size.x > 0.0 && surface.size.y > 0.0)
        .map(|surface| {
            let viewport = super::render::workset_viewport(&scene.0);
            Aabb::from_viewport(&viewport, surface.size.to_array())
                .expand(48.0 / viewport.zoom.max(0.01))
        });
    let zoom = scene.0.viewport.zoom.max(0.01);
    let show_labels = surface.is_none() || RUNNING_LABEL_FONT * zoom >= RUNNING_LABEL_MIN_SCREEN_PX;
    let content_color = theme.token_u32("canvasNodeContent");
    let track_color = theme.token_u32("canvasProgressTrack");

    let mut has_executing_frame = false;
    let mut static_entries = Vec::new();
    let mut wanted_spinners: HashMap<Entity, (Vec3, Quat, (u32, u32))> = HashMap::new();
    let mut staged = Vec::new();
    let mut visible_items = Vec::new();

    for (entity, render, node) in &active {
        if let Some(bounds) = visible_bounds {
            let node_bounds = Aabb {
                min: [node.x, node.y],
                max: [node.x + node.width, node.y + node.height],
            };
            if !bounds.intersects(node_bounds) {
                continue;
            }
        }
        visible_items.push((*entity, *render, node));
        if matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }) {
            has_executing_frame = true;
            continue;
        }
        let top_z = 10.0 + *render as f32 * 0.1 + 0.01;
        let (accent, _, _) = theme.node_palette(&node.kind);
        let (cx, cy, cw, ch) = generation_ring_rect(node);
        let locked = node
            .edit_scope
            .as_ref()
            .is_some_and(|scope| scope.mode == "locked");
        // CardBlockCache 已为 `shows_content(node)` 的卡片绘制了 `canvasNodeContent` 底色；
        // 仅当存在待覆盖纹理/锁态色差/未走卡片内容面时补画一块内容面，省去 1,800 次重复圆角矩形。
        let backdrop = if node.texture || locked || !shows_content(node) {
            Some(content_color)
        } else {
            None
        };
        let rect = backdrop.map(|_| [cx.to_bits(), cy.to_bits(), cw.to_bits(), ch.to_bits()]);
        let center = Vec2::new(cx + cw / 2.0, cy + ch / 2.0);
        let radius = (cw.min(ch) * 0.18).clamp(12.0, 28.0);
        let (label, position, stage) = if node.media_loading && !node.busy {
            let ring_center = center - Vec2::Y * 8.0;
            wanted_spinners.insert(
                *entity,
                (
                    Vec3::new(ring_center.x, -ring_center.y, top_z + 0.002),
                    Quat::from_rotation_z(-now * 3.0),
                    (radius.to_bits(), accent),
                ),
            );
            static_entries.push(StaticOverlayEntry::Loading {
                entity: *entity,
                center: [ring_center.x.to_bits(), ring_center.y.to_bits()],
                radius: radius.to_bits(),
                top_z: top_z.to_bits(),
                track: track_color,
                backdrop,
                rect,
            });
            (
                "加载中…".to_owned(),
                center + Vec2::Y * (radius + 8.0),
                NodeGenerationVisualStage {
                    kind: NodeGenerationVisualStageKind::Loading,
                    phase: now * 3.0,
                    center: center.to_array(),
                    radius,
                    accent,
                },
            )
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
            let int_percent = percent.round() as i32;
            static_entries.push(StaticOverlayEntry::Progress {
                entity: *entity,
                center: [center.x.to_bits(), center.y.to_bits()],
                radius: radius.to_bits(),
                top_z: top_z.to_bits(),
                accent,
                track: track_color,
                percent: int_percent,
                backdrop,
                rect,
            });
            (
                format!("{int_percent}%"),
                center,
                NodeGenerationVisualStage {
                    kind: NodeGenerationVisualStageKind::Progress,
                    phase: percent,
                    center: center.to_array(),
                    radius,
                    accent,
                },
            )
        };
        stage_entity(&mut commands, &mut clock, *entity, stage);
        if show_labels {
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
    }

    if visible_items.is_empty() {
        if cache.was_active {
            clear_overlay(&mut commands, &mut meshes, &layers);
        }
        clear_spinners(&mut commands, &mut meshes, &mut clock, &spinners);
        cache.was_active = false;
        cache.last_static_key = None;
        if cache
            .last_labels
            .as_ref()
            .is_none_or(|prev| !prev.is_empty())
        {
            cache.last_labels = None;
            clear_running(&mut requests);
        }
        return;
    }

    // 同步共享转圈实体：只改 `Transform` 旋转与新增/下线；同款弧段共享一份 GPU Mesh。
    let mut used_spinner_keys: HashSet<(u32, u32)> = HashSet::new();
    for (spinner_entity, spinner, mut transform, mesh2d) in &mut spinners {
        if let Some((translation, rotation, mesh_key)) = wanted_spinners.remove(&spinner.owner) {
            let handle = spinner_mesh(&mut clock, &mut meshes, mesh_key);
            used_spinner_keys.insert(mesh_key);
            if transform.translation != translation || transform.rotation != rotation {
                transform.translation = translation;
                transform.rotation = rotation;
            }
            if mesh2d.0.id() != handle.id() {
                commands.entity(spinner_entity).insert(Mesh2d(handle));
            }
        } else {
            commands.entity(spinner_entity).despawn();
        }
    }
    for (owner, (translation, rotation, mesh_key)) in wanted_spinners {
        let handle = spinner_mesh(&mut clock, &mut meshes, mesh_key);
        used_spinner_keys.insert(mesh_key);
        commands.spawn((
            LoadingSpinner { owner },
            Mesh2d(handle),
            MeshMaterial2d(materials.solid.clone()),
            Transform::from_translation(translation).with_rotation(rotation),
            NoFrustumCulling,
            NoCpuCulling,
        ));
    }
    clock.spinner_meshes.retain(|key, handle| {
        if used_spinner_keys.contains(key) {
            true
        } else {
            meshes.remove(handle.id());
            false
        }
    });

    if staged.is_empty() {
        if cache
            .last_labels
            .as_ref()
            .is_none_or(|prev| !prev.is_empty())
        {
            cache.last_labels = None;
            clear_running(&mut requests);
        }
    } else if cache.last_labels.as_ref() != Some(&staged) {
        replace_running(&mut requests, staged.clone());
        cache.last_labels = Some(staged);
    }

    let static_changed =
        has_executing_frame || cache.last_static_key.as_ref() != Some(&static_entries);
    if static_changed {
        let mut geometry = Geometry::default();
        if has_executing_frame {
            for (_, render, node) in &visible_items {
                if !matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }) {
                    continue;
                }
                let (color, alpha) = crate::scope_visual::execution_border(&theme, now);
                let z = 10.0 + *render as f32 * 0.1 + 0.005;
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
                    let color =
                        crate::scope_visual::execution_trail_color(&theme, now, segment.step);
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
            }
        }
        for entry in &static_entries {
            match *entry {
                StaticOverlayEntry::Loading {
                    center,
                    radius,
                    top_z,
                    track,
                    backdrop,
                    rect,
                    ..
                } => {
                    let top_z = f32::from_bits(top_z);
                    if let (Some(color), Some([cx, cy, cw, ch])) = (backdrop, rect) {
                        geometry.rounded_rect(
                            f32::from_bits(cx),
                            f32::from_bits(cy),
                            f32::from_bits(cw),
                            f32::from_bits(ch),
                            3.0,
                            top_z,
                            color,
                        );
                    }
                    geometry.loading_track(
                        Vec2::new(f32::from_bits(center[0]), f32::from_bits(center[1])),
                        f32::from_bits(radius),
                        track,
                        top_z + 0.001,
                    );
                }
                StaticOverlayEntry::Progress {
                    center,
                    radius,
                    top_z,
                    accent,
                    track,
                    percent,
                    backdrop,
                    rect,
                    ..
                } => {
                    let top_z = f32::from_bits(top_z);
                    if let (Some(color), Some([cx, cy, cw, ch])) = (backdrop, rect) {
                        geometry.rounded_rect(
                            f32::from_bits(cx),
                            f32::from_bits(cy),
                            f32::from_bits(cw),
                            f32::from_bits(ch),
                            3.0,
                            top_z,
                            color,
                        );
                    }
                    geometry.progress_ring(
                        Vec2::new(f32::from_bits(center[0]), f32::from_bits(center[1])),
                        f32::from_bits(radius),
                        percent as f32,
                        accent,
                        track,
                        top_z + 0.001,
                    );
                }
            }
        }
        replace_overlay_mesh(
            &mut commands,
            &mut meshes,
            &materials,
            &layers,
            geometry.build(),
        );
        cache.last_static_key = if has_executing_frame {
            None
        } else {
            Some(static_entries)
        };
    }

    cache.was_active = true;
}

/// 该节点是否要画运行覆盖层：执行中的 frame，或 `shows_generation_ring` / 媒体加载中的
/// 普通卡片（change: 2026-10-12-unify-generation-history-strip 与
/// unify-node-editors-and-focus-transitions）。只在重建活跃集时按场景 DTO 求值。
fn shows_running_overlay(
    node: &crate::protocol::GraphNode,
    scene: &crate::protocol::Scene,
) -> bool {
    if matches!(node.chrome, crate::protocol::NodeChrome::Frame { .. }) {
        return scene.executing_scopes.contains(&node.id);
    }
    node.chrome.is_card() && (shows_generation_ring(node) || (node.media_loading && !node.busy))
}

/// 取一个候选实体的覆盖层输入；不合格（已回收/不在场景/无需覆盖层）返回 `None`。
fn overlay_entry<'a>(
    entity: Entity,
    scene: &'a crate::protocol::Scene,
    index: &NodeIndex,
    nodes: &Query<(Entity, &CanvasNodeId, &CanvasDepth)>,
) -> Option<(
    Entity,
    usize,
    std::borrow::Cow<'a, crate::protocol::GraphNode>,
)> {
    let (entity, id, depth) = nodes.get(entity).ok()?;
    let node = crate::canvas_ecs::node_for_draw(scene, index, &id.0)?;
    shows_running_overlay(&node, scene).then_some((entity, depth.render, node))
}

/// 写入阶段组件，按 `(阶段, phase_bucket)` 去重（60 格分辨率），O(1) 查表避免 N^2 扫描。
fn stage_entity(
    commands: &mut Commands,
    clock: &mut GenerationClock,
    entity: Entity,
    stage: NodeGenerationVisualStage,
) {
    let phase_bucket = (stage.phase * 60.0) as u32;
    if let Some(&idx) = clock.last_staged_index.get(&entity) {
        let entry = &mut clock.last_staged[idx];
        if entry.1 == stage && entry.2 == phase_bucket {
            return;
        }
        *entry = (entity, stage, phase_bucket);
    } else {
        let idx = clock.last_staged.len();
        clock.last_staged.push((entity, stage, phase_bucket));
        clock.last_staged_index.insert(entity, idx);
    }
    #[cfg(test)]
    {
        clock.stage_writes += 1;
    }
    // 实体可能在同一帧被回收；无效实体静默跳过。
    if let Ok(mut entity) = commands.get_entity(entity) {
        entity.insert(stage);
    }
}

/// 回收离开覆盖层的实体上的阶段组件，并同步清掉去重快照。
fn retire_stages(commands: &mut Commands, clock: &mut GenerationClock, retired: &[Entity]) {
    if retired.is_empty() {
        return;
    }
    for &entity in retired {
        if let Some(idx) = clock.last_staged_index.remove(&entity) {
            let last = clock.last_staged.len() - 1;
            clock.last_staged.swap_remove(idx);
            if idx != last {
                let moved = clock.last_staged[idx].0;
                clock.last_staged_index.insert(moved, idx);
            }
        }
        // 上一代活跃集里的实体可能已回收，命中无效实体时静默跳过。
        if let Ok(mut entity) = commands.get_entity(entity) {
            entity.remove::<NodeGenerationVisualStage>();
        }
    }
}

fn spinner_mesh(
    clock: &mut GenerationClock,
    meshes: &mut Assets<Mesh>,
    key: (u32, u32),
) -> Handle<Mesh> {
    if let Some(handle) = clock.spinner_meshes.get(&key) {
        return handle.clone();
    }
    let handle = meshes.add(Geometry::spinner_arc_mesh(f32::from_bits(key.0), key.1));
    clock.spinner_meshes.insert(key, handle.clone());
    handle
}

fn clear_spinners(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    clock: &mut GenerationClock,
    spinners: &Query<(Entity, &LoadingSpinner, &mut Transform, &Mesh2d)>,
) {
    for (spinner_entity, _, _, _) in spinners {
        commands.entity(spinner_entity).despawn();
    }
    for (_, handle) in clock.spinner_meshes.drain() {
        meshes.remove(handle.id());
    }
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

/// 测试装配：`sync_generation` 需要的全部资源。
#[cfg(test)]
fn insert_runtime(world: &mut World, scene: crate::protocol::Scene, index: NodeIndex) {
    world.insert_resource(CurrentScene(scene));
    world.insert_resource(index);
    world.insert_resource(Time::<()>::default());
    world.insert_resource(crate::theme::ThemeResource::default());
    world.insert_resource(super::CanvasMaterials {
        solid: default(),
        blend: default(),
        font: default(),
    });
    world.insert_resource(GenerationClock::default());
    world.insert_resource(Assets::<Mesh>::default());
    world.insert_resource(LabelRequests::default());
}

#[cfg(test)]
mod overlay_tests {
    use super::*;
    use crate::canvas_ecs::components::CanvasLabel;
    use crate::protocol::{Scene, Viewport};

    fn colors(world: &World, layer: Entity) -> Vec<[f32; 4]> {
        let handle = &world.get::<Mesh2d>(layer).unwrap().0;
        let mesh = world.resource::<Assets<Mesh>>().get(handle).unwrap();
        let Some(bevy::render::mesh::VertexAttributeValues::Float32x4(colors)) =
            mesh.attribute(Mesh::ATTRIBUTE_COLOR)
        else {
            panic!("execution overlay must have vertex colors");
        };
        colors.clone()
    }

    fn update(world: &mut World, schedule: &mut Schedule) {
        schedule.run(world);
        world.flush();
    }

    #[test]
    fn frame_execution_reuses_one_layer_and_clears_once_at_terminal_state() {
        let node = serde_json::json!({
            "id":"g", "type":"workflow-group-2d", "x":0,"y":0,
            "width":300,"height":200,"chrome":{"kind":"frame","groupId":"g"}
        });
        let scene = Scene {
            nodes: vec![serde_json::from_value(node).unwrap()],
            executing_scopes: vec!["g".into()],
            ..default()
        };
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        let mut world = World::new();
        insert_runtime(&mut world, scene, index);
        world.spawn((
            CanvasNodeId("g".into()),
            CanvasDepth {
                index: 0,
                render: 0,
                z: 10.0,
            },
        ));
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_generation);
        update(&mut world, &mut schedule);
        let layer = world
            .query_filtered::<Entity, With<RunningProgressLayer>>()
            .single(&world)
            .unwrap();
        assert_eq!(world.resource::<Assets<Mesh>>().len(), 1);
        let low = colors(&world, layer);
        world
            .resource_mut::<Time>()
            .advance_by(std::time::Duration::from_millis(900));
        update(&mut world, &mut schedule);
        let high = colors(&world, layer);
        assert_ne!(low, high, "the frame mesh must breathe without a new scene");
        assert!(low.iter().any(|color| color[3] == 1.0));
        assert!(
            high.iter().any(|color| color[3] == 1.0),
            "the main stroke must cover a static selected border"
        );
        assert_eq!(world.resource::<Assets<Mesh>>().len(), 1);
        world
            .resource_mut::<CurrentScene>()
            .0
            .executing_scopes
            .clear();
        update(&mut world, &mut schedule);
        let cleared = world.get::<Mesh2d>(layer).unwrap().0.id();
        update(&mut world, &mut schedule);
        // 空闲帧不得持续分配空白覆盖层。
        assert_eq!(world.get::<Mesh2d>(layer).unwrap().0.id(), cleared);
        assert_eq!(world.resource::<Assets<Mesh>>().len(), 1);
    }

    #[test]
    fn running_labels_are_applied_in_the_same_frame_as_generation() {
        let scene = Scene {
            nodes: serde_json::from_value(serde_json::json!([
                {"id":"a","type":"image","x":0,"y":0,"width":180,"height":160,"mediaLoading":true},
                {"id":"b","type":"image","x":200,"y":0,"width":180,"height":160,"mediaLoading":true},
                {"id":"far","type":"image","x":10000,"y":0,"width":180,"height":160,"busy":true}
            ]))
            .unwrap(),
            viewport: Viewport { x: 0., y: 0., zoom: 1. },
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
                let depth = CanvasDepth {
                    index: i,
                    render: i,
                    z: 10. + i as f32 * 0.1,
                };
                world.spawn((CanvasNodeId(node.id.clone()), depth)).id()
            })
            .collect();
        insert_runtime(&mut world, scene, index);
        world.insert_resource(super::super::CanvasOverlayCache::default_for_test());
        let mut schedule = Schedule::default();
        schedule.add_systems((sync_generation, super::super::sync_canvas_labels).chain());
        update(&mut world, &mut schedule);
        let mut texts: Vec<String> = world
            .query::<(&CanvasLabel, &Text2d, &ChildOf)>()
            .iter(&world)
            .filter(|(label, _, child)| {
                label.role == CanvasLabelRole::Running && owners.contains(&child.parent())
            })
            .map(|(_, text, _)| text.0.clone())
            .collect();
        texts.sort();
        // 这一帧必须已经看到 Running 标签，不能只留在期望集里等下一帧。
        assert_eq!(texts, ["1%", "加载中…", "加载中…"], "同帧标签");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Scene, Viewport};

    /// 前 `n_load` 加载中、接着 `n_busy` 生成中、其余空闲。
    fn rig(n_load: usize, n_busy: usize, n_idle: usize) -> (World, Schedule, Vec<Entity>) {
        let tag = |i: usize| match i < n_load {
            true => "l",
            false if i < n_load + n_busy => "b",
            false => "i",
        };
        let specs: Vec<_> = (0..n_load + n_busy + n_idle)
            .map(|i| {
                serde_json::json!({
                    "id": format!("{}{i}", tag(i)), "type": "image", "x": i as f32 * 200.0,
                    "y": 0.0, "width": 180.0, "height": 160.0, "mediaLoading": i < n_load,
                    "busy": i >= n_load && i < n_load + n_busy,
                })
            })
            .collect();
        let scene = Scene {
            nodes: serde_json::from_value(serde_json::Value::Array(specs)).unwrap(),
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
        let owners = scene
            .nodes
            .iter()
            .enumerate()
            .map(|(i, node)| {
                let depth = CanvasDepth {
                    index: i,
                    render: i,
                    z: 10. + i as f32 * 0.1,
                };
                world.spawn((CanvasNodeId(node.id.clone()), depth)).id()
            })
            .collect();
        insert_runtime(&mut world, scene, index);
        let mut schedule = Schedule::default();
        schedule.add_systems(sync_generation);
        let mut rig = (world, schedule, owners);
        run(&mut rig, true, Vec::new(), 0.0);
        rig
    }
    fn run(rig: &mut (World, Schedule, Vec<Entity>), scene: bool, nodes: Vec<usize>, secs: f32) {
        rig.0.insert_resource(crate::app::FrameFlags {
            scene_received: scene,
            resource_nodes: nodes,
            ..default()
        });
        rig.0
            .resource_mut::<Time>()
            .advance_by(std::time::Duration::from_secs_f32(secs));
        rig.1.run(&mut rig.0);
        rig.0.flush();
    }

    /// `(active_count, full_scans, cached_visits)`
    fn stats(rig: &(World, Schedule, Vec<Entity>)) -> (usize, u64, usize) {
        let clock = rig.0.resource::<GenerationClock>();
        (clock.active_count, clock.full_scans, clock.cached_visits)
    }

    fn stage(rig: &(World, Schedule, Vec<Entity>), owner: Entity) -> NodeGenerationVisualStage {
        *rig.0.get::<NodeGenerationVisualStage>(owner).unwrap()
    }
    #[test]
    fn pan_and_animation_frames_never_rescan_the_node_table() {
        // 3000 节点里只有 3 个要画覆盖层：非场景帧的开销跟活跃集成正比，与总节点数无关。
        let mut rig = rig(2, 1, 3000);
        assert_eq!(stats(&rig), (3, 1, 0));
        for _ in 0..60 {
            run(&mut rig, false, Vec::new(), 0.016);
        }
        assert_eq!(stats(&rig), (3, 1, 180), "非场景帧只遍历活跃实体");
        run(&mut rig, true, Vec::new(), 0.016);
        assert_eq!(stats(&rig).1, 2, "场景帧才重建");
    }

    #[test]
    fn resource_patch_rebuilds_without_a_scene_snapshot() {
        let mut rig = rig(1, 0, 2);
        let late = serde_json::json!({
            "id": "late", "type": "image", "x": 600.0, "y": 0.0,
            "width": 180.0, "height": 160.0, "mediaLoading": true
        });
        let mut scene = rig.0.resource_mut::<CurrentScene>();
        scene.0.nodes.push(serde_json::from_value(late).unwrap());
        drop(scene);
        rig.0.spawn((
            CanvasNodeId("late".into()),
            CanvasDepth {
                index: 3,
                render: 3,
                z: 10.3,
            },
        ));
        let scene = rig.0.resource::<CurrentScene>().0.clone();
        rig.0.resource_mut::<NodeIndex>().rebuild(&scene);
        run(&mut rig, false, vec![3], 0.016);
        assert_eq!(stats(&rig).0, 2, "资源补丁必须重建并收进新节点");
    }

    #[test]
    fn empty_active_set_costs_zero_entity_visits() {
        let mut rig = rig(0, 0, 3000);
        for _ in 0..10 {
            run(&mut rig, false, Vec::new(), 0.016);
        }
        assert_eq!(stats(&rig), (0, 1, 0), "0 实体扫描");
        rig.0.resource_mut::<CurrentScene>().0.nodes[0].busy = true;
        run(&mut rig, true, Vec::new(), 0.016);
        assert_eq!(stats(&rig).0, 1);
    }

    #[test]
    fn stage_writes_are_deduped_and_retired_with_the_overlay() {
        let mut rig = rig(1, 0, 1);
        let (owner, first) = (rig.2[0], stage(&rig, rig.2[0]));
        assert_eq!(first.kind, NodeGenerationVisualStageKind::Loading);
        let writes = rig.0.resource::<GenerationClock>().stage_writes;
        run(&mut rig, false, Vec::new(), 0.0);
        run(&mut rig, false, Vec::new(), 0.0);
        let clock = rig.0.resource::<GenerationClock>();
        assert_eq!(
            clock.stage_writes, writes,
            "同一 (阶段, phase_bucket) 不重复写"
        );
        run(&mut rig, false, Vec::new(), 0.1);
        assert_ne!(stage(&rig, owner), first);

        // 纯平移帧仍复用活跃集，但覆盖层要跟着节点走。
        rig.0.resource_mut::<CurrentScene>().0.nodes[0].x += 240.0;
        let moved = stage(&rig, owner);
        run(&mut rig, false, Vec::new(), 0.0);
        assert_eq!(stats(&rig).1, 1, "平移帧不重扫节点表");
        assert_ne!(stage(&rig, owner), moved);

        // 离开覆盖层后阶段组件与去重快照一起回收。
        rig.0.resource_mut::<CurrentScene>().0.nodes[0].media_loading = false;
        run(&mut rig, true, Vec::new(), 0.016);
        assert_eq!(stats(&rig).0, 0);
        assert!(rig.0.get::<NodeGenerationVisualStage>(owner).is_none());
        assert!(rig.0.resource::<GenerationClock>().last_staged.is_empty());
    }

    #[test]
    fn reset_clears_every_cached_field() {
        let stage = NodeGenerationVisualStage {
            kind: NodeGenerationVisualStageKind::Loading,
            phase: 1.0,
            center: [0.0, 0.0],
            radius: 12.0,
            accent: 0xffffff,
        };
        let mut clock = GenerationClock {
            started: HashMap::from([("a".to_owned(), 1.0)]),
            active_entities: vec![Entity::PLACEHOLDER],
            cached: true,
            last_staged: vec![(Entity::PLACEHOLDER, stage, 60)],
            active_count: 1,
            ..default()
        };
        clock.reset();
        assert!(clock.started.is_empty() && clock.active_entities.is_empty());
        assert!(clock.last_staged.is_empty() && clock.active_count == 0 && !clock.cached);
    }
}

#[cfg(test)]
#[path = "generation/tests.rs"]
mod spinner_tests;
