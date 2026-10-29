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
use crate::canvas_ecs::components::{CanvasDepth, CanvasLabelRole, CanvasLayout, CanvasNodeId, NodeActionBar, NodeActionLayer};
use crate::protocol::{GraphNode, NodeActions};
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::labels::{Label, LabelRequests, LabelStyle};
use super::layout::{
    NODE_ACTION_TOOLBAR_ACTION_HEIGHT, NODE_ACTION_TOOLBAR_FONT, NODE_ACTION_TOOLBAR_PAD,
    node_action_toolbar,
};

/// 横条容器圆角半径。
const BAR_RADIUS: f32 = 8.0;
/// 动作按钮圆角半径。
const ACTION_RADIUS: f32 = 5.0;

/// 横条覆盖层的世界 z：高于卡片（10 + n×0.1）与粘连操作条（+1.5）、聚合把手（+1.52），
/// 低于框选（500）。与 `attach.rs` 同一层基数。
fn base_z(node_count: usize) -> f32 {
    10.0 + node_count as f32 * 0.1 + 1.5 + 0.5
}

/// 绘制全部带 `nodeActions` 的节点横条，返回按 `(owner, labels)` 分组的标签集合。
///
/// `viewport`/`surface_size` 与命中查询使用**同一组输入**，因此顶部碰撞回退（above/below）
/// 与命中矩形完全一致。
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
                // 纯图标按钮居中；图标 + 文字时图标贴左，文字紧随其后（与 contracts 同一栅格）。
                let center = if slot.icon_only {
                    Vec2::new(ax + aw / 2.0, ay + ah / 2.0)
                } else {
                    Vec2::new(
                        ax + (NODE_ACTION_TOOLBAR_ACTION_PAD + NODE_ACTION_TOOLBAR_ICON_SIZE / 2.0)
                            * scale,
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
                let label_x = ax
                    + (if slot.icon.is_some() {
                        NODE_ACTION_TOOLBAR_ACTION_PAD
                            + NODE_ACTION_TOOLBAR_ICON_SIZE
                            + NODE_ACTION_TOOLBAR_ICON_GAP
                    } else {
                        NODE_ACTION_TOOLBAR_ACTION_PAD
                    }) * scale;
                let text_y = ay + (ah - world_font) / 2.0 - scale;
                labels.push((
                    slot.label.clone(),
                    Vec2::new(ax + 8.0 * scale, text_y),
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
        // 节点摘要：最左侧弱化文本。
        if let Some((text, (sx, sy, _sw, sh))) = &layout.summary {
            let text_y = sy + (sh - world_font) / 2.0 - scale;
            labels.push((text.clone(), Vec2::new(*sx, text_y), screen_font, body_text));
        }
        out.push((*entity, labels));
    }
    out
}

/// 逐帧同步横条 overlay 几何与标签（change: 2026-10-13-add-node-to-film-set-shortcut）。
///
/// 不受 `FrameFlags.changed` 门禁：横条随节点世界位置与视口顶部碰撞变化，必须逐帧更新。无横条
/// 时不产生几何并把覆盖层清空一次。
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
    nodes: Query<(Entity, &CanvasNodeId, &CanvasLayout, &CanvasDepth, &NodeActionBar)>,
    layers: Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
) {
    requests.begin(CanvasLabelRole::NodeAction);
    // 图片/视频聚焦期间不绘制画布横条（横条只属于普通画布）。
    let focused =
        super::image_focus::has_presented_media_focus(&scene.0) || scene.0.model_focus.is_some();
    let viewport = (
        scene.0.viewport.x,
        scene.0.viewport.y,
        scene.0.viewport.zoom,
    );
    let surface_size = (surface.size.x, surface.size.y);
    let z = base_z(scene.0.nodes.len());

    let projected: Vec<(Entity, GraphNode)> = nodes
        .iter()
        .filter_map(|(entity, id, _layout, _depth, _bar)| {
            let (_, source) = index.node(&scene.0, &id.0)?;
            Some((entity, crate::canvas_query::focus_context::node(&scene.0, source).into_owned()))
        })
        .collect();
    let actions = nodes
        .iter()
        .map(|(_, id, _, _, bar)| (id.0.clone(), bar.actions.clone()))
        .collect::<HashMap<_, _>>();
    let mut geometry = Geometry::default();
    let drawn = draw(
        &mut geometry,
        &theme,
        &projected,
        &actions,
        Some(viewport),
        Some(surface_size),
        z,
    );
    if drawn.is_empty() {
        clear_mesh(&mut commands, &mut meshes, &layers);
        return;
    }
    replace_mesh(&mut commands, &mut meshes, &materials, &layers, geometry.build());
    for (owner, labels) in drawn {
        requests.push(
            CanvasLabelRole::NodeAction,
            owner,
            labels,
            z + 0.006,
            LabelStyle::NodeAction,
        );
    }
}

/// 替换横条覆盖层 mesh；实体缺失时按需创建（半透明 Blend 材质，避免写深度遮挡）。
fn replace_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &super::CanvasMaterials,
    layers: &Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
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
            commands.spawn((NodeActionLayer, Mesh2d(handle), MeshMaterial2d(materials.blend.clone()), NoFrustumCulling));
        }
    }
}

/// 清空横条覆盖层（无横条时调用一次）。
fn clear_mesh(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    layers: &Query<(Entity, Option<&Mesh2d>), With<NodeActionLayer>>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::NodeAction;

    fn node(id: &str, x: f32, y: f32) -> GraphNode {
        GraphNode {
            model_preview: None,
            aggregate_run: None,
            history_strip: None,
            shot_preview: None,

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
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            ghost: false,
            card_label: None,
            group: None,
            model: None,
            composite_asset: None,
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
