//! 节点顶部操作横条的 2D overlay 绘制（change: 2026-10-13-add-node-to-film-set-shortcut，
//! design D6/D7）。
//!
//! 横条由 Bevy 在画布场景内绘制、由 Rust interaction snapshot 命中：**整张画布仍是同一张
//! canvas**，因此中键/空格/右键拖拽平移与滚轮缩放在横条覆盖区域照常生效，只有「左键落在哪个
//! 动作矩形内」由 Rust 决定。本模块只**被动**消费 scene 下发的 `nodeActions` 描述并绘制
//! 容器/动作/设置箭头/模型名摘要；几何来自 `super::layout::node_action_toolbar`，与命中查询
//! 共用同一派生（同一组 node/viewport/surface 输入），保证「画在哪、点在哪」一致。
//!
//! 逐帧 overlay：横条锚定在节点上方并随节点位置/视口顶部碰撞变化，与粘连触须一样不适合放在
//! 按场景指纹缓存的共享 card mesh 里；它独立成一张小 mesh 与独立标签池，只在存在横条时重建。
//! 抽出独立模块的理由同 `attach.rs`：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫）。

use std::collections::HashMap;

use bevy::{camera::visibility::NoFrustumCulling, prelude::*};

use crate::app::{CurrentScene, NodeIndex};
use crate::canvas_ecs::components::{
    CanvasDepth, CanvasLabelRole, CanvasLayout, CanvasNodeId, NodeActionBar, NodeActionLayer,
};
use crate::protocol::{GraphNode, NodeActions};
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::labels::{Label, LabelOwner, LabelRequests, LabelSpec, LabelStyle, LabelWriter};
use super::layout::{
    NODE_ACTION_TOOLBAR_ACTION_HEIGHT, NODE_ACTION_TOOLBAR_FONT, NODE_ACTION_TOOLBAR_ICON_GAP,
    NODE_ACTION_TOOLBAR_ICON_SIZE, NODE_ACTION_TOOLBAR_PAD, node_action_content_x,
    node_action_toolbar,
};

/// 最近一次绘制覆盖层所用的输入摘要。空横条集合不参与去抖：首次进入空集合仍要清一次网格，
/// 之后由 `clear_mesh` 的“空网格不重写”短路保证静止帧不再分配 mesh。
#[derive(Default)]
pub(crate) struct NodeActionStamp(Option<u64>);

/// 保留范围在横条矩形外的额外余量（世界单位）：覆盖描边与抗锯齿边缘。
const SPAN_PADDING: f32 = 2.0;

/// 横条容器圆角半径。
const BAR_RADIUS: f32 = 8.0;
/// 动作按钮圆角半径。
const ACTION_RADIUS: f32 = 5.0;

/// 横条覆盖层的世界 z：高于卡片（10 + n×0.1）与粘连操作条（+1.5）、聚合把手（+1.52），
/// 低于框选（500）。与 `attach.rs` 同一层基数。
fn base_z(node_count: usize) -> f32 {
    10.0 + node_count as f32 * 0.1 + 1.5 + 0.5
}

/// 横条覆盖层每帧的输入：(实体, 该实体是否需要重绘, 动作描述)。
type BarTargets<'a> = &'a [(Entity, bool, Option<&'a NodeActions>)];

/// 绘制全部带 `nodeActions` 的节点横条，返回按 `(owner, labels)` 分组的标签集合。
///
/// `viewport`/`surface_size` 与命中查询使用**同一组输入**，因此顶部碰撞回退（above/below）
/// 与命中矩形完全一致。
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    nodes: &[(Entity, GraphNode)],
    node_actions: &HashMap<String, NodeActions>,
    viewport: Option<(f32, f32, f32)>,
    surface_size: Option<(f32, f32)>,
    z: f32,
) -> Vec<(Entity, Vec<Label>)> {
    let border = theme.token_u32("canvasNodeBorder");
    let surface = theme.token_u32("canvasNodeSurface");
    let accent = theme.token_u32("interactionAccent");
    let body_text = theme.token_u32("canvasBodyText");

    let mut out = Vec::new();
    for (entity, node) in nodes {
        // `chrome.none` 的世界对象没有卡片锚点，动作横条留在原生菜单中选择。
        if node.chrome.is_none() {
            continue;
        }
        // 容器（片场）与普通节点共用同一条动作横条；是否绘制由 `action_bar_visible` 决定
        // （只有声明 `actionBar` 的容器才带 NodeActionBar 组件）。
        let Some(actions) = node_actions.get(&node.id) else {
            continue;
        };
        let Some(layout) = node_action_toolbar(node, actions, viewport, surface_size) else {
            continue;
        };

        let scale =
            layout.bar.3 / (NODE_ACTION_TOOLBAR_ACTION_HEIGHT + NODE_ACTION_TOOLBAR_PAD * 2.0);
        let (bx, by, bw, bh) = layout.bar;
        geometry.rounded_rect(bx, by, bw, bh, BAR_RADIUS * scale, z, border);
        geometry.rounded_rect(
            bx + scale,
            by + scale,
            (bw - 2.0 * scale).max(scale),
            (bh - 2.0 * scale).max(scale),
            (BAR_RADIUS - 1.0) * scale,
            z + 0.001,
            surface,
        );
        // 横条文字是**固定屏幕字号**：`layout` 已是世界矩形（屏幕像素 ÷ zoom），因此文字在
        // 世界空间里的高度是 `NODE_ACTION_TOOLBAR_FONT / zoom`（下面的 `world_font` 只用于
        // 垂直居中），而 `Label.size` 传**屏幕逻辑字号**，由共享文字策略用实体尺度抵消相机
        // 缩放（change: 2026-10-22-improve-canvas-text-clarity，design D3）。这样字形字号键
        // 不再随 `1 / zoom` 连续变化。
        let world_font = NODE_ACTION_TOOLBAR_FONT * scale;
        let screen_font = NODE_ACTION_TOOLBAR_FONT;
        let mut labels: Vec<Label> = Vec::new();
        for slot in &layout.slots {
            let (ax, ay, aw, ah) = slot.rect;
            let primary = slot.tone == "primary";
            let tint = if !slot.enabled {
                body_text
            } else if primary {
                theme.token_u32("interactionOnAccent")
            } else {
                body_text
            };
            if primary {
                let fill = if slot.enabled {
                    accent
                } else {
                    theme.token_u32("interactionDisabled")
                };
                geometry.rounded_rect(ax, ay, aw, ah, ACTION_RADIUS * scale, z + 0.002, fill);
            }
            if let Some(icon) = slot.icon.as_deref().filter(|icon| {
                matches!(
                    *icon,
                    "download"
                        | "edit"
                        | "arrange-horizontal"
                        | "arrange-vertical"
                        | "arrange-grid"
                        | "arrange-diagonal-up"
                        | "arrange-diagonal-down"
                        | "collapse-groups"
                        | "expand-groups"
                )
            }) {
                // 纯图标按钮居中；图标 + 文字时整块内容按槽内富余居中，文字紧随图标。
                let content_x = node_action_content_x(aw / scale, &slot.label, slot.icon.is_some());
                let center = if slot.icon_only {
                    Vec2::new(ax + aw / 2.0, ay + ah / 2.0)
                } else {
                    Vec2::new(
                        ax + (content_x + NODE_ACTION_TOOLBAR_ICON_SIZE / 2.0) * scale,
                        ay + ah / 2.0,
                    )
                };
                let point = |x: f32, y: f32| center + Vec2::new(x, y) * scale;
                let segments: &[((f32, f32), (f32, f32))] = match icon {
                    "download" => &[
                        ((0.0, -7.0), (0.0, 3.0)),
                        ((-4.0, -1.0), (0.0, 3.0)),
                        ((0.0, 3.0), (4.0, -1.0)),
                        ((-6.0, 3.0), (-6.0, 7.0)),
                        ((-6.0, 7.0), (6.0, 7.0)),
                        ((6.0, 7.0), (6.0, 3.0)),
                    ],
                    "edit" => &[
                        ((-6.0, 6.0), (-2.5, 5.5)),
                        ((-6.0, 6.0), (-5.5, 2.5)),
                        ((-2.5, 5.5), (-5.5, 2.5)),
                        ((-2.5, 5.5), (5.5, -2.5)),
                        ((-5.5, 2.5), (2.5, -5.5)),
                        ((5.5, -2.5), (2.5, -5.5)),
                    ],
                    // 横排：三个纵向条，表示并排的三张卡片。
                    "arrange-horizontal" => &[
                        ((-5.5, -6.0), (-5.5, 6.0)),
                        ((0.0, -6.0), (0.0, 6.0)),
                        ((5.5, -6.0), (5.5, 6.0)),
                    ],
                    // 竖排：三个横向条，表示自上而下的三张卡片。
                    "arrange-vertical" => &[
                        ((-6.0, -5.5), (6.0, -5.5)),
                        ((-6.0, 0.0), (6.0, 0.0)),
                        ((-6.0, 5.5), (6.0, 5.5)),
                    ],
                    // 宫格：2×2 分栏。
                    "arrange-grid" => &[
                        ((-6.0, -6.0), (6.0, -6.0)),
                        ((6.0, -6.0), (6.0, 6.0)),
                        ((6.0, 6.0), (-6.0, 6.0)),
                        ((-6.0, 6.0), (-6.0, -6.0)),
                        ((-6.0, 0.0), (6.0, 0.0)),
                        ((0.0, -6.0), (0.0, 6.0)),
                    ],
                    // 斜排 ↘：三个小方块沿右下方向阶梯排列。
                    "arrange-diagonal-down" => &[
                        ((-7.0, -7.0), (-3.0, -7.0)),
                        ((-3.0, -7.0), (-3.0, -3.0)),
                        ((-3.0, -3.0), (-7.0, -3.0)),
                        ((-7.0, -3.0), (-7.0, -7.0)),
                        ((-2.0, -2.0), (2.0, -2.0)),
                        ((2.0, -2.0), (2.0, 2.0)),
                        ((2.0, 2.0), (-2.0, 2.0)),
                        ((-2.0, 2.0), (-2.0, -2.0)),
                        ((3.0, 3.0), (7.0, 3.0)),
                        ((7.0, 3.0), (7.0, 7.0)),
                        ((7.0, 7.0), (3.0, 7.0)),
                        ((3.0, 7.0), (3.0, 3.0)),
                    ],
                    // 斜排 ↗：同一阶梯翻转，三个小方块沿右上方向排列。
                    "arrange-diagonal-up" => &[
                        ((-7.0, 3.0), (-3.0, 3.0)),
                        ((-3.0, 3.0), (-3.0, 7.0)),
                        ((-3.0, 7.0), (-7.0, 7.0)),
                        ((-7.0, 7.0), (-7.0, 3.0)),
                        ((-2.0, -2.0), (2.0, -2.0)),
                        ((2.0, -2.0), (2.0, 2.0)),
                        ((2.0, 2.0), (-2.0, 2.0)),
                        ((-2.0, 2.0), (-2.0, -2.0)),
                        ((3.0, -7.0), (7.0, -7.0)),
                        ((7.0, -7.0), (7.0, -3.0)),
                        ((7.0, -3.0), (3.0, -3.0)),
                        ((3.0, -3.0), (3.0, -7.0)),
                    ],
                    "expand-groups" => &[
                        ((0.0, 6.0), (0.0, -2.0)),
                        ((-4.0, 2.0), (0.0, -2.0)),
                        ((4.0, 2.0), (0.0, -2.0)),
                        ((-6.0, -6.0), (-6.0, 6.0)),
                        ((6.0, -6.0), (6.0, 6.0)),
                    ],
                    "collapse-groups" => &[
                        ((0.0, -6.0), (0.0, 2.0)),
                        ((-4.0, -2.0), (0.0, 2.0)),
                        ((4.0, -2.0), (0.0, 2.0)),
                        ((-6.0, -6.0), (-6.0, 6.0)),
                        ((6.0, -6.0), (6.0, 6.0)),
                    ],
                    _ => &[],
                };
                for (from, to) in segments {
                    geometry.line(
                        point(from.0, from.1),
                        point(to.0, to.1),
                        1.5 * scale,
                        z + 0.004,
                        tint,
                    );
                }
            }
            if !slot.icon_only {
                let content_x = node_action_content_x(aw / scale, &slot.label, slot.icon.is_some());
                let label_x = ax
                    + (content_x
                        + if slot.icon.is_some() {
                            NODE_ACTION_TOOLBAR_ICON_SIZE + NODE_ACTION_TOOLBAR_ICON_GAP
                        } else {
                            0.0
                        })
                        * scale;
                let text_y = ay + (ah - world_font) / 2.0 - scale;
                labels.push((
                    slot.label.clone(),
                    Vec2::new(label_x, text_y),
                    screen_font,
                    tint,
                ));
            }
            if let Some((mx, my, mw, mh)) = slot.menu {
                let center = Vec2::new(mx + mw / 2.0, my + mh / 2.0);
                geometry.polygon(
                    &[
                        center + Vec2::new(-4.0, -1.5) * scale,
                        center + Vec2::new(4.0, -1.5) * scale,
                        center + Vec2::new(0.0, 3.0) * scale,
                    ],
                    z + 0.004,
                    body_text,
                );
            }
        }
        // 模型名摘要：最右侧弱化文本。
        if let Some((text, (sx, sy, _sw, sh))) = &layout.summary {
            let text_y = sy + (sh - world_font) / 2.0 - scale;
            labels.push((text.clone(), Vec2::new(*sx, text_y), screen_font, body_text));
        }
        out.push((*entity, labels));
    }
    out
}

/// 横条覆盖层的保留状态：每根横条最近一次绘制占用的世界 x 范围与绘制摘要。
///
/// 横条与框选/聚合把手处在不同 z 层，同层内容互不重叠：每根横条自己的外框、动作条、图标与
/// 文字都落在它自己记录的范围里，因此按 x 区间替换即可保持绘制顺序与原全量重建一致。
#[derive(Default)]
pub(crate) struct BarLayer {
    /// 覆盖层实体；`None` 表示还没有可用缓冲，下一次绘制走整层重建。
    entity: Option<Entity>,
    /// 稳定节点 id → 最近一次绘制的世界 x 范围。
    spans: HashMap<String, (f32, f32)>,
    /// 稳定节点 id → 最近一次绘制的输入摘要。
    row_keys: HashMap<String, u64>,
    /// 最近一次整层重建的输入摘要；不等即整层重建。
    key: Option<u64>,
}

impl BarLayer {
    fn forget(&mut self) {
        self.entity = None;
        self.spans.clear();
        self.row_keys.clear();
        self.key = None;
    }
}

/// 同步横条 overlay 几何与标签（change: 2026-10-13-add-node-to-film-set-shortcut）。
///
/// 横条随节点世界位置与视口顶部碰撞变化，不能只按 `FrameFlags.changed` 跳帧。这里用两层键：
///
/// - `stamp`：整帧输入（节点布局、视口、surface、主题、动作声明）的价值摘要。相等即整段返回，
///   不遍历节点、不写 mesh、不重提标签。
/// - `BarLayer::row_keys`：逐节点摘要（布局、动作声明、绘制 z）。只有摘要变化的横条需要重绘，
///   其余保留的几何与标签原样留在覆盖层里；换画布、动作声明集合变化、结构变化、主题/视口/
///   surface 变化时整层重建，不做拼接。
///
/// 无横条时不产生几何并把覆盖层清空一次。
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_node_action_bars(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    index: Res<NodeIndex>,
    surface: Res<crate::app::SurfaceState>,
    theme: Res<ThemeResource>,
    materials: Res<super::CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut requests: ResMut<LabelRequests>,
    stamp: Res<super::OverlayStamp>,
    mut synced: Local<NodeActionStamp>,
    mut layer: Local<BarLayer>,
    nodes: Query<(
        Entity,
        &CanvasNodeId,
        &CanvasLayout,
        &CanvasDepth,
        &NodeActionBar,
    )>,
    layers: Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
) {
    // 空横条集合也要跑一次：覆盖层可能还留着上一帧的几何。
    let whole_key = if nodes.is_empty() { None } else { stamp.get() };
    if whole_key.is_some() && synced.0 == whole_key {
        return;
    }
    synced.0 = whole_key;
    let viewport = (
        scene.0.viewport.x,
        scene.0.viewport.y,
        scene.0.viewport.zoom,
    );
    let surface_size = (surface.size.x, surface.size.y);
    let z = base_z(scene.0.nodes.len());

    // 横条由已接受场景的 `nodeActions` 声明；投影实体自带的声明用于场景之外装配的横条。
    let mut declared: HashMap<String, NodeActions> = HashMap::new();
    for (_, id, _, _, bar) in &nodes {
        let actions = scene.0.node_actions.get(&id.0).unwrap_or(&bar.actions);
        declared.insert(id.0.clone(), actions.clone());
    }
    // 整层重建的判据：动作声明集合、主题、视口、surface、绘制 z 或换画布。任何一项变化都会让
    // 每个横条的位置或外观变化，局部拼接不再能保证与原全量重建一致。
    let layer_key = layer_key(&scene.0, &theme, declared.keys(), viewport, surface_size, z);
    let whole = layer.key != Some(layer_key) || layer.entity.is_none();

    // 上一帧的几何范围；本帧会重建 `spans`，嫁接时只能用这份快照。
    let previous_spans = layer.spans.clone();
    let mut redrawn: Vec<(Entity, GraphNode, NodeActions)> = Vec::new();
    let mut spans: HashMap<String, (f32, f32)> = HashMap::new();
    /// 本帧需要重绘的节点 id：上一帧的几何范围必须从保留缓冲里剔除。
    let mut stale: Vec<String> = Vec::new();
    let mut seen = 0usize;
    for (entity, id, _layout, _depth, _bar) in &nodes {
        let Some((_, source)) = index.node(&scene.0, &id.0) else {
            continue;
        };
        seen += 1;
        let node = crate::canvas_query::focus_context::node(&scene.0, source).into_owned();
        let actions = &declared[&id.0];
        let layout = node_action_toolbar(&node, actions, Some(viewport), Some(surface_size));
        // 横条几何（圆角、图标、文字）可以比声明矩形略宽，保留范围按同一余量外扩，避免把
        // 未重绘横条的边缘顶点误剔。
        let span = layout.as_ref().map(|layout| {
            (
                layout.bar.0 - SPAN_PADDING,
                layout.bar.0 + layout.bar.2 + SPAN_PADDING,
            )
        });
        let row = row_digest(&node, actions, span, z);
        spans.insert(id.0.clone(), span.unwrap_or((0.0, 0.0)));
        if whole || layer.row_keys.get(&id.0) != Some(&row) {
            redrawn.push((entity, node, actions.clone()));
            stale.push(id.0.clone());
            layer.row_keys.insert(id.0.clone(), row);
        }
    }
    if layer.row_keys.len() != seen {
        // 结构收缩：被删除的节点不能留下旧横条。
        layer.row_keys.retain(|id, _| declared.contains_key(id));
    }
    #[cfg(test)]
    super::bar_paint::record(redrawn.len(), whole);
    if redrawn.is_empty() {
        // 没有需要重绘的横条：保留的几何与标签都不动。
        return;
    }

    let mut geometry = Geometry::default();
    let drawn = draw(
        &mut geometry,
        &theme,
        &redrawn
            .iter()
            .map(|(entity, node, _)| (*entity, node.clone()))
            .collect::<Vec<_>>(),
        &declared,
        Some(viewport),
        Some(surface_size),
        z,
    );
    let owner_of: HashMap<Entity, String> = redrawn
        .iter()
        .map(|(entity, node, _)| (*entity, node.id.clone()))
        .collect();
    let mut drawn_spans: Vec<(f32, f32)> = Vec::new();
    for (id, span) in &spans {
        if drawn
            .iter()
            .any(|(owner, _)| owner_of.get(owner) == Some(id))
            && let Some((start, end)) = span_of(*span)
        {
            drawn_spans.push((start, end));
        }
    }

    // 标签：整层重建写完整名单；局部只替换被重绘 owner 的槽位名单（空名单即删除）。
    // bind 必须在事务打开之前完成：`LabelRequests` 的 `bind` 需要独占借用，而事务持有它。
    for (owner, id) in &owner_of {
        requests.bind(LabelOwner::Node(id.clone()), *owner);
    }
    if whole {
        let keys = label_keys(&drawn, &owner_of, z);
        let mut txn = requests.transaction(LabelWriter::NodeAction);
        txn.replace_role(CanvasLabelRole::NodeAction, keys);
        let _ = txn.commit();
    } else {
        let mut txn = requests.transaction(LabelWriter::NodeAction);
        for (owner, id) in &owner_of {
            let labels = drawn
                .iter()
                .find(|(drawn_owner, _)| drawn_owner == owner)
                .map(|(_, labels)| labels.clone())
                .unwrap_or_default();
            txn.replace_owner(
                CanvasLabelRole::NodeAction,
                LabelOwner::Node(id.clone()),
                labels,
                z + 0.006,
                LabelStyle::NodeAction,
            );
        }
        let _ = txn.commit();
    }

    if drawn.is_empty() {
        clear_mesh(&mut commands, &mut meshes, &layers);
        layer.entity = None;
        layer.spans.clear();
        layer.row_keys.clear();
        layer.key = None;
        clear_node_actions(&mut requests);
        return;
    }

    let built = geometry.build();
    let mut target = layer.entity.filter(|entity| layers.get(*entity).is_ok());
    if whole || layer.spans.is_empty() || target.is_none() {
        target = Some(replace_mesh(
            &mut commands,
            &mut meshes,
            &materials,
            &layers,
            built,
        ));
    } else if let Some(entity) = target {
        // 只把重绘批次嫁接回保留缓冲：未重绘的横条逐顶点保留，其余旧几何（包括被重绘横条
        // 移动前的位置）被剔除，新批次追加在末尾。
        let retained: Vec<(f32, f32)> = previous_spans
            .iter()
            .filter(|(id, span)| !stale.contains(*id) && span_of(**span).is_some())
            .map(|(_, span)| *span)
            .collect();
        replace_range_mesh(
            &mut commands,
            &mut meshes,
            &layers,
            entity,
            built,
            &retained,
        );
    }
    layer.spans = spans;
    layer.key = Some(layer_key);
    layer.entity = target;
}

fn span_of(span: (f32, f32)) -> Option<(f32, f32)> {
    (span.1 > span.0 && span.0.is_finite() && span.1.is_finite()).then_some(span)
}

fn label_keys(
    drawn: &[(Entity, Vec<Label>)],
    owner_of: &HashMap<Entity, String>,
    z: f32,
) -> Vec<(LabelOwner, u16, LabelSpec)> {
    drawn
        .iter()
        .filter_map(|(owner, labels)| {
            let id = owner_of.get(owner)?;
            Some((id.clone(), labels))
        })
        .flat_map(|(id, labels)| {
            labels.iter().enumerate().map(move |(slot, label)| {
                (
                    LabelOwner::Node(id.clone()),
                    slot as u16,
                    LabelSpec::from_label(label.clone(), z + 0.006, LabelStyle::NodeAction),
                )
            })
        })
        .collect()
}

/// 整层键：动作声明集合 + 主题 + 视口 + surface + 绘制 z + 画布身份。
fn layer_key<'a>(
    scene: &crate::protocol::Scene,
    theme: &ThemeResource,
    ids: impl Iterator<Item = &'a String>,
    viewport: (f32, f32, f32),
    surface: (f32, f32),
    z: f32,
) -> u64 {
    let mut ids: Vec<&str> = ids.map(String::as_str).collect();
    ids.sort_unstable();
    let fingerprint = theme.token_u32("canvasNodeBorder").rotate_left(7)
        ^ theme.token_u32("canvasNodeSurface").rotate_left(13)
        ^ theme.token_u32("interactionAccent").rotate_left(19)
        ^ theme.token_u32("canvasBodyText").rotate_left(23);
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut mix = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    };
    mix(scene.canvas_id.len() as u64);
    for byte in scene.canvas_id.bytes() {
        mix(u64::from(byte));
    }
    mix(scene.nodes.len() as u64);
    for id in ids {
        mix(id.len() as u64);
        for byte in id.bytes() {
            mix(u64::from(byte));
        }
    }
    mix(u64::from(fingerprint));
    for value in [viewport.0, viewport.1, viewport.2, surface.0, surface.1, z] {
        mix(u64::from(if value == 0.0 { 0 } else { value.to_bits() }));
    }
    hash
}

/// 单根横条的绘制摘要：布局、动作声明与绘制 z。相等即保留上一帧的几何与标签。
fn row_digest(node: &GraphNode, actions: &NodeActions, span: Option<(f32, f32)>, z: f32) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut mix = |value: u64| {
        hash ^= value;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    };
    for value in [node.x, node.y, node.width, node.height] {
        mix(u64::from(if value == 0.0 { 0 } else { value.to_bits() }));
    }
    for text in [&node.kind, &node.title, &node.type_label, &node.body] {
        mix(text.len() as u64);
        for byte in text.bytes() {
            mix(u64::from(byte));
        }
    }
    match &node.chrome {
        crate::protocol::NodeChrome::Card => mix(0),
        crate::protocol::NodeChrome::Frame {
            group_id,
            member_node_ids,
        } => {
            mix(1);
            mix(group_id.len() as u64);
            mix(member_node_ids.len() as u64);
        }
        crate::protocol::NodeChrome::None => mix(2),
    }
    match span {
        Some((start, end)) => {
            mix(1);
            mix(u64::from(start.to_bits()));
            mix(u64::from(end.to_bits()));
        }
        None => mix(0),
    }
    mix(u64::from(z.to_bits()));
    mix(actions.actions.len() as u64);
    for action in &actions.actions {
        mix(action.id.len() as u64);
        for byte in action.id.bytes() {
            mix(u64::from(byte));
        }
        mix(action.label.len() as u64);
        for byte in action.label.bytes() {
            mix(u64::from(byte));
        }
        mix(u64::from(action.enabled)
            | (u64::from(action.menu) << 1)
            | (u64::from(action.icon_only) << 2));
        mix(u64::from(action.tone.len() as u64));
        for byte in action.tone.bytes() {
            mix(u64::from(byte));
        }
    }
    if let Some(summary) = &actions.summary {
        mix(1);
        mix(summary.len() as u64);
        for byte in summary.bytes() {
            mix(u64::from(byte));
        }
    } else {
        mix(0);
    }
    hash
}

fn clear_node_actions(requests: &mut LabelRequests) {
    if !requests.writer_role_occupied(LabelWriter::NodeAction, CanvasLabelRole::NodeAction) {
        return;
    }
    let mut txn = requests.transaction(LabelWriter::NodeAction);
    txn.replace_role(CanvasLabelRole::NodeAction, Vec::new());
    let _ = txn.commit();
}

/// 替换横条覆盖层 mesh；实体缺失时按需创建（半透明 Blend 材质，避免写深度遮挡）。
fn replace_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &super::CanvasMaterials,
    layers: &Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
    built: Mesh,
) -> Entity {
    let handle = meshes.add(built);
    match layers.iter().next() {
        Some((entity, old_handle)) => {
            if let Some(old) = old_handle {
                meshes.remove(old.0.id());
            }
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(handle));
            }
            entity
        }
        None => commands
            .spawn((
                NodeActionLayer,
                Mesh2d(handle),
                MeshMaterial2d(materials.blend.clone()),
                NoFrustumCulling,
            ))
            .id(),
    }
}

/// 把本帧重绘的横条嫁接回上一帧的覆盖层 mesh。
///
/// `retained` 是上一帧里未被重绘、需要原样留下的横条世界 x 范围。范围外的旧三角形（包括被
/// 重绘横条移动前的位置）全部剔除，随后接上本帧新批次。未重绘横条的顶点与绘制顺序原样保留。
fn replace_range_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    layers: &Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
    entity: Entity,
    built: Mesh,
    retained: &[(f32, f32)],
) {
    let Some((_, Some(handle))) = layers.get(entity).ok() else {
        return;
    };
    let Some(previous) = meshes.get(handle.id()) else {
        return;
    };
    let (positions, colors, indices) = buffers(previous);
    let (new_positions, new_colors, new_indices) = buffers(&built);
    let (mesh, ..) = Geometry::from_buffers(new_positions, new_colors, new_indices)
        .append_retained((positions, colors, indices), retained);
    if let Ok(mut entity_commands) = commands.get_entity(entity) {
        let next = meshes.add(mesh);
        meshes.remove(handle.id());
        entity_commands.insert(Mesh2d(next));
    }
}

/// 取出几何的原始顶点缓冲（不产出 mesh）。
fn colors_of(mesh: &Mesh) -> Option<Vec<[f32; 4]>> {
    match mesh.attribute(Mesh::ATTRIBUTE_COLOR) {
        Some(bevy::render::mesh::VertexAttributeValues::Float32x4(values)) => Some(values.clone()),
        _ => None,
    }
}

fn indices_of(mesh: &Mesh) -> Option<Vec<u32>> {
    Some(mesh.indices()?.iter().map(|index| index as u32).collect())
}

fn buffers(mesh: &Mesh) -> (Vec<[f32; 3]>, Vec<[f32; 4]>, Vec<u32>) {
    let positions = mesh
        .attribute(Mesh::ATTRIBUTE_POSITION)
        .and_then(|values| values.as_float3())
        .map(<[[f32; 3]]>::to_vec)
        .unwrap_or_default();
    (
        positions,
        colors_of(mesh).unwrap_or_default(),
        indices_of(mesh).unwrap_or_default(),
    )
}

/// 清空横条覆盖层（无横条时调用一次）。
///
/// 已经是空网格就不再分配新 mesh：静止无横条时重写空 mesh 只会让网格资产无意义地增删。
fn clear_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    layers: &Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
) {
    if let Some((entity, old_handle)) = layers.iter().next() {
        if old_handle.is_some_and(|handle| {
            meshes
                .get(handle.id())
                .is_some_and(|mesh| mesh.count_vertices() == 0)
        }) {
            return;
        }
        let handle = meshes.add(Geometry::default().build());
        if let Some(old) = old_handle {
            meshes.remove(old.0.id());
        }
        if let Ok(mut entity_commands) = commands.get_entity(entity) {
            entity_commands.insert(Mesh2d(handle));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::NodeAction;

    fn node(id: &str, x: f32, y: f32) -> GraphNode {
        GraphNode {
            edit_scope: None,
            chrome: crate::protocol::NodeChrome::Card,
            shared_world_instance: None,
            world_camera: None,
            history_strip: None,
            id: id.into(),
            kind: "image".into(),
            x,
            y,
            width: 200.0,
            height: 120.0,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            progress_started_at: None,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            model: None,
        }
    }

    fn actions(summary: Option<&str>) -> NodeActions {
        NodeActions {
            actions: vec![
                NodeAction {
                    id: "download".into(),
                    label: "下载".into(),
                    enabled: true,
                    menu: false,
                    ..Default::default()
                },
                NodeAction {
                    id: "convert".into(),
                    label: "转为片场".into(),
                    enabled: true,
                    menu: true,
                    ..Default::default()
                },
            ],
            summary: summary.map(str::to_owned),
        }
    }

    fn projected(nodes: Vec<GraphNode>) -> (World, Vec<(Entity, GraphNode)>) {
        let mut world = World::new();
        let projected = nodes
            .into_iter()
            .map(|node| (world.spawn_empty().id(), node))
            .collect();
        (world, projected)
    }

    fn positions(geometry: Geometry) -> usize {
        geometry
            .build()
            .attribute(bevy::render::mesh::Mesh::ATTRIBUTE_POSITION)
            .and_then(|values| values.as_float3())
            .map(|values| values.iter().filter(|p| p[0] > -1.0e5).count())
            .unwrap_or(0)
    }

    /// 生产调度要求横条在 Labels 之前提交。这里按同一顺序跑真实系统，不手写期望集。
    #[test]
    fn node_action_labels_are_applied_in_the_same_frame() {
        use crate::canvas_ecs::components::CanvasLabel;

        let node = node("a", 0.0, 200.0);
        let mut world = World::new();
        let scene = crate::protocol::Scene {
            nodes: vec![node.clone()],
            viewport: crate::protocol::Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            ..default()
        };
        let mut index = NodeIndex::default();
        index.rebuild(&scene);
        world.spawn((
            CanvasNodeId(node.id.clone()),
            CanvasLayout::from_node(&node),
            CanvasDepth {
                index: 0,
                render: 0,
                z: 10.0,
            },
            NodeActionBar {
                actions: actions(Some("gpt-5")),
                summary: None,
            },
            Transform::IDENTITY,
        ));
        let mut scene = scene;
        scene
            .node_actions
            .insert(node.id.clone(), actions(Some("gpt-5")));
        world.insert_resource(CurrentScene(scene));
        world.init_resource::<crate::canvas2d::OverlayStamp>();
        world.insert_resource(index);
        world.insert_resource(crate::app::SurfaceState::with_size(Vec2::new(800.0, 600.0)));
        world.insert_resource(ThemeResource::default());
        world.insert_resource(super::super::CanvasMaterials {
            solid: default(),
            blend: default(),
            font: default(),
        });
        world.insert_resource(Assets::<Mesh>::default());
        world.insert_resource(LabelRequests::default());
        world.insert_resource(super::super::CanvasOverlayCache::default_for_test());
        let mut schedule = Schedule::default();
        schedule.add_systems((sync_node_action_bars, super::super::sync_canvas_labels).chain());
        schedule.run(&mut world);
        world.flush();

        let labels: Vec<_> = world
            .query::<(&CanvasLabel, &Text2d)>()
            .iter(&world)
            .filter(|(label, _)| label.role == CanvasLabelRole::NodeAction)
            .map(|(_, text)| text.0.clone())
            .collect();
        assert_eq!(labels.len(), 3, "横条的三个文字必须在同一帧变成标签实体");
        assert!(labels.iter().any(|text| text == "下载"));
        assert!(labels.iter().any(|text| text == "转为片场"));
        assert!(labels.iter().any(|text| text == "gpt-5"));
    }

    #[test]
    fn draws_bar_and_labels_only_when_present() {
        let theme = ThemeResource::default();
        let (_world, nodes) = projected(vec![node("a", 0.0, 200.0), node("b", 400.0, 200.0)]);
        let owner = nodes[0].0;
        let mut map = HashMap::new();
        map.insert("a".to_owned(), actions(Some("gpt-5")));
        let mut geometry = Geometry::default();
        let labels = draw(&mut geometry, &theme, &nodes, &map, None, None, 100.0);
        assert!(positions(geometry) > 40);
        // 仅带横条的节点产出标签（2 动作 + 1 摘要）。
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].0, owner);
        assert_eq!(labels[0].1.len(), 3);
    }

    /// 五种排列图标都是纯图标按钮：绘制线段，不产生文字标签。
    #[test]
    fn arrange_icons_draw_geometry_without_labels() {
        let theme = ThemeResource::default();
        for icon in [
            "arrange-horizontal",
            "arrange-vertical",
            "arrange-grid",
            "arrange-diagonal-down",
            "arrange-diagonal-up",
        ] {
            let (_world, nodes) = projected(vec![node("a", 0.0, 200.0)]);
            let mut map = HashMap::new();
            map.insert(
                "a".to_owned(),
                NodeActions {
                    actions: vec![NodeAction {
                        id: icon.into(),
                        label: icon.into(),
                        enabled: true,
                        icon: Some(icon.into()),
                        icon_only: true,
                        ..Default::default()
                    }],
                    summary: None,
                },
            );
            let mut geometry = Geometry::default();
            let labels = draw(&mut geometry, &theme, &nodes, &map, None, None, 100.0);
            assert!(positions(geometry) > 0, "{icon} 应绘制图标线段");
            assert_eq!(labels.len(), 1, "{icon} 仍应产出横条 owner");
            assert!(labels[0].1.is_empty(), "{icon} 纯图标按钮不应产生文字标签");
        }
    }

    #[test]
    fn labels_declare_screen_font_size_independent_of_zoom() {
        let theme = ThemeResource::default();
        let (_world, nodes) = projected(vec![node("a", 0.0, 200.0)]);
        let mut map = HashMap::new();
        map.insert("a".to_owned(), actions(Some("gpt-5")));
        let surface = (1200.0, 800.0);
        for zoom in [0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0] {
            let mut geometry = Geometry::default();
            let labels = draw(
                &mut geometry,
                &theme,
                &nodes,
                &map,
                Some((0.0, 0.0, zoom)),
                Some(surface),
                100.0,
            );
            for (_, _, size, _) in &labels[0].1 {
                assert_eq!(
                    *size, NODE_ACTION_TOOLBAR_FONT,
                    "横条标签必须声明固定屏幕字号，不随 zoom={zoom} 变化"
                );
            }
        }
    }

    /// 横条文字声明为屏幕模式：策略系统用 `1 / zoom` 的实体尺度抵消相机，字号键恒定。
    #[test]
    fn toolbar_labels_use_screen_scale_mode() {
        use crate::canvas2d::text_presentation::{LogicalText, TextScaleMode, present};
        let meta = LogicalText::screen(NODE_ACTION_TOOLBAR_FONT);
        assert_eq!(meta.mode, TextScaleMode::Screen);
        let mut keys = Vec::new();
        for zoom in [0.1, 0.5, 1.0, 2.0, 4.0, 8.0, 12.0] {
            let target = present(&meta, zoom, 2.0).expect("合法输入");
            keys.push(target.raster_key(2.0));
            // 世界尺寸 = 屏幕字号 / zoom，投影回屏幕后仍是固定字号。
            assert!(
                (target.font_size * target.scale - NODE_ACTION_TOOLBAR_FONT / zoom).abs() <= 1.0e-3
            );
        }
        assert!(
            keys.iter().all(|key| *key == keys[0]),
            "连续缩放不得产生新字号键：{keys:?}"
        );
    }

    #[test]
    fn no_actions_no_geometry() {
        let theme = ThemeResource::default();
        let (_world, nodes) = projected(vec![node("a", 0.0, 200.0)]);
        let mut geometry = Geometry::default();
        let labels = draw(
            &mut geometry,
            &theme,
            &nodes,
            &HashMap::new(),
            None,
            None,
            100.0,
        );
        assert_eq!(positions(geometry), 0);
        assert!(labels.is_empty());
    }

    #[test]
    fn bar_sits_above_node_with_fixed_gap() {
        let theme = ThemeResource::default();
        let (_world, nodes) = projected(vec![node("a", 0.0, 200.0)]);
        let mut map = HashMap::new();
        map.insert("a".to_owned(), actions(None));
        let mut geometry = Geometry::default();
        draw(&mut geometry, &theme, &nodes, &map, None, None, 100.0);
        // 世界几何：横条底边 = 节点顶边(y=200) - GAP(8)；mesh 顶点 y 取世界 y 的负值。
        // 因此 bar 覆盖 mesh y ∈ [-(200-8), -(200-8-40)] = [-192, -152]。
        let mesh = geometry.build();
        let positions = mesh
            .attribute(bevy::render::mesh::Mesh::ATTRIBUTE_POSITION)
            .expect("positions")
            .as_float3()
            .expect("float3 positions");
        let min_y = positions.iter().map(|p| p[1]).fold(f32::MAX, f32::min);
        let max_y = positions.iter().map(|p| p[1]).fold(f32::MIN, f32::max);
        assert!(
            min_y >= -193.0 && max_y <= -151.0,
            "min={min_y} max={max_y}"
        );
    }
}
