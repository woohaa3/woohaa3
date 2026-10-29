//! 单节点拖动粘连的 2D overlay 绘制（change: add-drag-touch-connections，design D5）。
//!
//! Web 控制器把拖动节点 identity、粘附模式、当前接触目标与待提交边投影到
//! `CanvasRenderScene.dragAttach`；本模块只**被动**消费该语义投影并绘制底部操作条、
//! 活动侧强调、左右触须、接触反馈与待提交连线（虚线）。它不执行碰撞、不锁定目标、
//! 不分配 edge id、不提交命令。
//!
//! 抽出独立模块的理由：`render.rs` 已接近文件体积上限（`tests/file_size.rs` 守卫），
//! 且粘连 overlay 的绘制来源（`dragAttach` 字段）与文字生命周期都与普通卡片不同。

use std::collections::HashMap;

use bevy::{prelude::*, camera::visibility::NoFrustumCulling};

use crate::protocol::{DragAttach, GraphNode};
use crate::theme::ThemeResource;

use super::Visuals;
use super::geometry::Geometry;
use super::layout::port;

/// 拖动粘连操作条高度，必须与 contracts 的 `DRAG_ATTACH_ACTION_BAR_HEIGHT` 一致
/// （change: add-drag-touch-connections；由 `render-scene.test.ts` 断言两边相同）。
pub(crate) const DRAG_ATTACH_ACTION_BAR_HEIGHT: f32 = 24.0;
/// 操作条与节点下缘的间隙，必须与 contracts 的 `DRAG_ATTACH_ACTION_BAR_GAP` 一致。
pub(crate) const DRAG_ATTACH_ACTION_BAR_GAP: f32 = 8.0;
/// 触须探针的固定世界长度，必须与 contracts 的 `DRAG_ATTACH_PROBE_LENGTH` 一致。
pub(crate) const DRAG_ATTACH_PROBE_LENGTH: f32 = 52.0;

/// 未接触目标时的触须扭动振幅（占探针长度的比例）。
const PROBE_WOBBLE_REST_RATIO: f32 = 0.14;
/// 接触目标时的触须扭动振幅（占探针长度的比例）；更大以表达「吸附」。
const PROBE_WOBBLE_CONTACT_RATIO: f32 = 0.24;

/// 操作条圆角半径。
const BAR_RADIUS: f32 = 6.0;
/// 操作条内文字水平内边距。
const LABEL_PADDING: f32 = 8.0;
/// 触须顶点圆钮半径。
const PROBE_TIP_RADIUS: f32 = 3.0;
/// 触须线宽与待提交连线线宽。
const PROBE_WIDTH: f32 = 2.0;
const PENDING_EDGE_WIDTH: f32 = 2.0;

/// 操作条文字标签：位置为 top-left 锚点。
pub(crate) struct AttachLabel {
    pub(crate) key: String,
    pub(crate) text: String,
    pub(crate) position: Vec2,
    pub(crate) size: f32,
    pub(crate) color: u32,
}

/// 按估算宽度截断的中文/ASCII 混排文本宽度（与 `layout::shortened` 同一启发式）。
fn estimated_width(text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| if c.is_ascii() { size * 0.62 } else { size })
        .sum()
}

/// 在共享几何里追加粘连 overlay，并返回操作条文字标签。
///
/// `base_z` 由调用方按节点数量给出，保证 overlay 高于所有节点卡片、又低于框选（500）。
/// `nodes` 是当前投影的节点表，仅用于解析待提交连线的端点；owner 自身由调用方按实体定位。
pub(crate) fn draw_drag_attach(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    owner: &GraphNode,
    node_map: &HashMap<&str, &GraphNode>,
    attach: &DragAttach,
    base_z: f32,
) -> Vec<AttachLabel> {
    if owner.composite_asset.is_some() { return Vec::new(); }
    let mode = attach.mode.as_deref();
    let accent = theme.token_u32("interactionAccent");
    let border = theme.token_u32("canvasNodeBorder");
    let surface = theme.token_u32("canvasNodeSurface");
    let body_text = theme.token_u32("canvasBodyText");

    // 操作条：稳定高度 + 与节点同宽，贴在节点下缘下方。
    let bar_x = owner.x;
    let bar_y = owner.y + owner.height + DRAG_ATTACH_ACTION_BAR_GAP;
    let bar_width = owner.width;
    geometry.rounded_rect(bar_x, bar_y, bar_width, DRAG_ATTACH_ACTION_BAR_HEIGHT, BAR_RADIUS, base_z, border);
    geometry.rounded_rect(
        bar_x + 1.0,
        bar_y + 1.0,
        (bar_width - 2.0).max(1.0),
        (DRAG_ATTACH_ACTION_BAR_HEIGHT - 2.0).max(1.0),
        BAR_RADIUS - 1.0,
        base_z + 0.001,
        surface,
    );
    // 活动侧强调：前序高亮左半、后序高亮右半（半透明，不遮挡文字）。
    if let Some(active) = mode {
        let half = (bar_width - 2.0) / 2.0;
        let (hx, hw) = if active == "predecessor" {
            (bar_x + 1.0, half)
        } else {
            (bar_x + bar_width / 2.0, half)
        };
        geometry.rounded_rect_alpha(
            hx,
            bar_y + 1.0,
            hw.max(1.0),
            (DRAG_ATTACH_ACTION_BAR_HEIGHT - 2.0).max(1.0),
            BAR_RADIUS - 1.0,
            base_z + 0.002,
            accent,
            0.18,
        );
    }

    let left_text = "（Q）粘连前序";
    let right_text = "（E）粘连后序";
    let label_size = 11.0;
    let left_color = if mode == Some("predecessor") { accent } else { body_text };
    let right_color = if mode == Some("successor") { accent } else { body_text };
    let left_width = estimated_width(left_text, label_size);
    let right_width = estimated_width(right_text, label_size);
    let text_y = bar_y + (DRAG_ATTACH_ACTION_BAR_HEIGHT - label_size) / 2.0 - 1.0;
    let labels = vec![
        AttachLabel {
            key: "predecessor".to_owned(),
            text: left_text.to_owned(),
            position: Vec2::new(bar_x + LABEL_PADDING, text_y),
            size: label_size,
            color: left_color,
        },
        AttachLabel {
            key: "successor".to_owned(),
            text: right_text.to_owned(),
            position: Vec2::new(
                (bar_x + bar_width - LABEL_PADDING - right_width).max(bar_x + left_width + LABEL_PADDING),
                text_y,
            ),
            size: label_size,
            color: right_color,
        },
    ];

    // 活动触须与接触反馈由逐帧动画覆盖层绘制（`draw_drag_attach_probe`），
    // 使触须可以扭动而无需每帧重建整场几何（change: add-drag-touch-connections）。

    // 待提交连线预览：虚线曲线，立即可见（即使触须已离开目标也保留）。
    for edge in &attach.pending_edges {
        if let (Some(source), Some(target)) = (
            node_map.get(edge.source.as_str()),
            node_map.get(edge.target.as_str()),
        ) {
            geometry.curve(
                port(source, true),
                port(target, false),
                PENDING_EDGE_WIDTH,
                base_z + 0.008,
                theme.token_u32("canvasEdgeDraft"),
                true,
            );
        }
    }

    labels
}

/// 活动触须与接触反馈的逐帧动画覆盖层（change: add-drag-touch-connections，design D5）。
///
/// 触须用两段折线 + 顶点圆钮绘制，并沿一条轻微正弦曲线扭动：接触目标时抖动更明显，
/// 让用户感觉触须正在「吸附」目标；未接触时几乎平直。返回是否绘制了非空几何，
/// 供调用方在从「有触须」到「无」时清空一次，避免最后一段触须残留。
///
/// 该覆盖层独立于主 card mesh，逐帧更新成本恒定为单个短探针，不随节点数增长。
pub(crate) fn draw_drag_attach_probe(
    geometry: &mut Geometry,
    theme: &ThemeResource,
    owner: &GraphNode,
    attach: &DragAttach,
    contact: Option<&GraphNode>,
    base_z: f32,
    time: f32,
) -> bool {
    let Some(active) = attach.mode.as_deref() else {
        return false;
    };
    let accent = theme.token_u32("interactionAccent");
    let (start, end) = if active == "predecessor" {
        let p = port(owner, false);
        (p, Vec2::new(p.x - DRAG_ATTACH_PROBE_LENGTH, p.y))
    } else {
        let p = port(owner, true);
        (p, Vec2::new(p.x + DRAG_ATTACH_PROBE_LENGTH, p.y))
    };
    // 扭动：沿探针方向叠加横向正弦波；接触目标时振幅更大（吸附感）。
    // 振幅按探针长度比例缩放（约 14%/24%），使短触须也能明显摆动。
    let amplitude =
        DRAG_ATTACH_PROBE_LENGTH * if contact.is_some() { PROBE_WOBBLE_CONTACT_RATIO } else { PROBE_WOBBLE_REST_RATIO };
    let segments = 16;
    let mut previous = start;
    for i in 1..=segments {
        let t = i as f32 / segments as f32;
        let along = start + (end - start) * t;
        // 两端固定（t=0/1 振幅为 0），中段摆动最大。
        let wobble = (t * std::f32::consts::PI).sin()
            * (time * 8.0 + t * std::f32::consts::TAU * 2.0).sin()
            * amplitude;
        let point = Vec2::new(along.x, along.y + wobble);
        geometry.line(previous, point, PROBE_WIDTH, base_z, accent);
        previous = point;
    }
    // 顶点圆钮：随扭动相位呼吸，接触目标时更明显。
    let breath = if contact.is_some() { 0.35 } else { 0.15 };
    let tip_radius = PROBE_TIP_RADIUS * (1.0 + breath * (time * 8.0).sin().abs());
    geometry.circle(previous, tip_radius, base_z + 0.001, accent, 16);
    // 接触反馈：合法目标节点外圈虚线高亮。
    if let Some(target) = contact {
        super::dash::dashed_rounded_rect(
            geometry,
            target.x - 4.0,
            target.y - 4.0,
            target.width + 8.0,
            target.height + 8.0,
            11.0,
            2.0,
            base_z + 0.005,
            accent,
        );
    }
    true
}

/// 替换触须覆盖层共享 mesh；首个触须出现时创建实体（沿用运行进度覆盖层的模式）。
pub(crate) fn replace_probe_mesh(
    commands: &mut Commands,
    visuals: &mut Visuals,
    meshes: &mut Assets<Mesh>,
    built: Mesh,
) {
    let handle = meshes.add(built);
    match visuals.attach_probe_entity {
        Some(entity) => {
            let old = std::mem::replace(&mut visuals.attach_probe_mesh, handle.clone());
            meshes.remove(&old);
            if let Ok(mut entity_commands) = commands.get_entity(entity) {
                entity_commands.insert(Mesh2d(handle));
            }
        }
        None => {
            visuals.attach_probe_mesh = handle.clone();
            let entity = commands
                .spawn((
                    Mesh2d(handle),
                    MeshMaterial2d(visuals.blend_material.clone()),
                    NoFrustumCulling,
                ))
                .id();
            visuals.attach_probe_entity = Some(entity);
        }
    }
}

/// 清空触须覆盖层（无活动触须时调用一次）。
pub(crate) fn clear_probe_mesh(
    commands: &mut Commands,
    visuals: &mut Visuals,
    meshes: &mut Assets<Mesh>,
) {
    if !visuals.attach_probe_active {
        return;
    }
    if let Some(entity) = visuals.attach_probe_entity {
        let handle = meshes.add(Geometry::default().build());
        let old = std::mem::replace(&mut visuals.attach_probe_mesh, handle.clone());
        meshes.remove(&old);
        if let Ok(mut entity_commands) = commands.get_entity(entity) {
            entity_commands.insert(Mesh2d(handle));
        }
    }
    visuals.attach_probe_active = false;
}

/// 逐帧推进粘连触须动画（change: add-drag-touch-connections，design D5）。
///
/// 不受 `FrameFlags.changed` 门禁：触须扭动必须逐帧更新。无活动触须时不产生几何，
/// 从「有触须」到「无」时清空一次，避免最后一段触须残留。
pub(crate) fn sync_attach_probe(
    mut commands: Commands,
    time: Res<Time>,
    scene: Res<crate::app::CurrentScene>,
    index: Res<crate::app::NodeIndex>,
    theme: Res<ThemeResource>,
    mut visuals: ResMut<Visuals>,
    mut meshes: ResMut<Assets<Mesh>>,
) {
    // 图片/视频聚焦期间不绘制粘连触须
    // （change: 2026-10-08-...，任务 4.2；change: 2026-10-10-add-video-node-focus-workspace）。
    if super::image_focus::has_presented_media_focus(&scene.0) {
        clear_probe_mesh(&mut commands, &mut visuals, &mut meshes);
        return;
    }
    let Some(attach) = scene.0.drag_attach.as_ref() else {
        clear_probe_mesh(&mut commands, &mut visuals, &mut meshes);
        return;
    };
    let Some(owner) = index.node(&scene.0, &attach.node_id).map(|(_, node)| node) else {
        clear_probe_mesh(&mut commands, &mut visuals, &mut meshes);
        return;
    };
    let contact = attach
        .contact_node_id
        .as_deref()
        .and_then(|id| index.node(&scene.0, id).map(|(_, node)| node));
    let base_z = 10.0 + scene.0.nodes.len() as f32 * 0.1 + 1.5 + 1.0;
    let mut geometry = Geometry::default();
    let drawn = draw_drag_attach_probe(
        &mut geometry,
        &theme,
        owner,
        attach,
        contact,
        base_z,
        time.elapsed_secs(),
    );
    if drawn {
        replace_probe_mesh(&mut commands, &mut visuals, &mut meshes, geometry.build());
        visuals.attach_probe_active = true;
    } else {
        clear_probe_mesh(&mut commands, &mut visuals, &mut meshes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::DragAttachEdge;

    fn node(id: &str, x: f32, y: f32, width: f32, height: f32) -> GraphNode {
        GraphNode {
            model_preview: None,
            ghost: false,
            card_label: None,
            shot_preview: None,

            id: id.into(),
            kind: "text".into(),
            x,
            y,
            width,
            height,
            body: String::new(),
            title: String::new(),
            type_label: String::new(),
            progress: 0.0,
            busy: false,
            texture: false,
            media_loading: false,
            resizable: false,
            group: None,
            model: None,
            composite_asset: None,
            history_strip: None,
            aggregate_run: None,
        }
    }

    fn attach(mode: Option<&str>, contact: Option<&str>) -> DragAttach {
        DragAttach {
            node_id: "a".into(),
            mode: mode.map(str::to_owned),
            contact_node_id: contact.map(str::to_owned),
            pending_edges: vec![],
        }
    }

    fn node_map(nodes: &[GraphNode]) -> HashMap<&str, &GraphNode> {
        nodes.iter().map(|node| (node.id.as_str(), node)).collect()
    }

    fn positions(geometry: Geometry) -> usize {
        let mesh = geometry.build();
        mesh.attribute(Mesh::ATTRIBUTE_POSITION)
            .expect("positions")
            .as_float3().expect("float3 positions")
            .iter().filter(|p| p[0] > -1.0e5).count()
    }

    #[test]
    fn bar_only_emits_geometry_and_two_labels() {
        let theme = ThemeResource::default();
        let nodes = vec![node("a", 0.0, 0.0, 200.0, 80.0)];
        let map = node_map(&nodes);
        let mut geometry = Geometry::default();
        let labels =
            draw_drag_attach(&mut geometry, &theme, &nodes[0], &map, &attach(None, None), 100.0);
        assert!(positions(geometry) > 20);
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].text, "（Q）粘连前序");
        assert_eq!(labels[1].text, "（E）粘连后序");
    }

    #[test]
    fn bar_and_pending_edges_emit_geometry() {
        let theme = ThemeResource::default();
        let nodes = vec![node("a", 0.0, 0.0, 200.0, 80.0), node("b", 600.0, 0.0, 200.0, 80.0)];
        let map = node_map(&nodes);
        let mut spec = attach(None, None);
        spec.pending_edges = vec![DragAttachEdge {
            id: "e1".into(),
            source: "a".into(),
            target: "b".into(),
        }];
        let mut geometry = Geometry::default();
        draw_drag_attach(&mut geometry, &theme, &nodes[0], &map, &spec, 100.0);
        // 虚线曲线由多段短线组成，顶点数远高于一个实心圆角矩形。
        assert!(positions(geometry) > 200);
    }

    #[test]
    fn probe_animation_only_when_mode_active() {
        let theme = ThemeResource::default();
        let nodes = vec![node("a", 0.0, 0.0, 200.0, 80.0), node("b", 260.0, 0.0, 200.0, 80.0)];
        // 无 mode：不绘制触须。
        let mut idle = Geometry::default();
        assert!(!draw_drag_attach_probe(
            &mut idle,
            &theme,
            &nodes[0],
            &attach(None, None),
            None,
            100.0,
            0.0
        ));
        assert_eq!(positions(idle), 0);
        // 有 mode：绘制触须（多段折线 + 圆钮 + 接触反馈）。
        let mut active = Geometry::default();
        assert!(draw_drag_attach_probe(
            &mut active,
            &theme,
            &nodes[0],
            &attach(Some("successor"), Some("b")),
            Some(&nodes[1]),
            100.0,
            0.0,
        ));
        assert!(positions(active) > 40);
    }

    #[test]
    fn probe_wiggles_over_time() {
        let theme = ThemeResource::default();
        let nodes = vec![node("a", 0.0, 0.0, 200.0, 80.0)];
        let mut first = Geometry::default();
        draw_drag_attach_probe(
            &mut first,
            &theme,
            &nodes[0],
            &attach(Some("successor"), None),
            None,
            100.0,
            0.0,
        );
        let mut later = Geometry::default();
        draw_drag_attach_probe(
            &mut later,
            &theme,
            &nodes[0],
            &attach(Some("successor"), None),
            None,
            100.0,
            0.12,
        );
        // 不同时间采样得到不同触须几何（扭动动画）。
        let first = first.build();
        let later = later.build();
        assert_ne!(first.attribute(Mesh::ATTRIBUTE_POSITION), later.attribute(Mesh::ATTRIBUTE_POSITION));
    }

    #[test]
    fn bar_constants_match_shared_geometry() {
        // 与 contracts `DRAG_ATTACH_*` 常量的一致性由 TypeScript 契约测试断言；
        // 这里锁定相对关系，避免布局漂移。
        assert!(DRAG_ATTACH_ACTION_BAR_HEIGHT > 0.0);
        assert!(DRAG_ATTACH_ACTION_BAR_GAP > 0.0);
        assert!(DRAG_ATTACH_PROBE_LENGTH > 0.0);
    }
}
