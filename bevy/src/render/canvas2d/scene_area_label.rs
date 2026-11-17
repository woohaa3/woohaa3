//! 2D 组的小圆角名称标签（Bevy 2D）。
//!
//! 导演区名称由 app::scene_area_label 绘制在真实 3D 地面，此层只保留 2D 组。
//!
//! 标签底与描边合并为一张共享 mesh（集合/主题/状态变化时重建）；文字是独立
//! `Text2d` 实体，交给统一字体清晰度 pipeline 处理。

use crate::scope_visual::{ScopeStyle, ScopeVisuals};
use std::collections::HashSet;

use bevy::prelude::*;
use bevy::sprite::Anchor;
use bevy::text::{LineBreak, TextBounds};

use crate::app::CurrentScene;
use crate::canvas_query::layout;
use crate::theme::ThemeResource;

use super::geometry::Geometry;
use super::text_presentation::{LogicalText, TextScaleMode};
use super::{CanvasMaterials, CanvasOverlayCache};

/// 2D 组标签的画布绘制顺序；真实 3D 导演区名称不经过此层。
const LABEL_Z: f32 = 500.0;

/// 2D 组标签实体标记。
#[derive(Component)]
pub(crate) struct SceneAreaLabelText {
    node_id: String,
}

#[derive(Default)]
pub(crate) struct SceneAreaLabelLayer {
    entity: Option<Entity>,
    mesh: Option<Handle<Mesh>>,
    signature: String,
}

struct LabelSpec {
    geometry: layout::SceneAreaLabelGeometry,
    text: String,
    fill: u32,
    text_color: Color,
    border: u32,
}

fn truncate(text: &str, max_width: f32, font_size: f32) -> String {
    let max_chars = (max_width / font_size).max(1.0) as usize;
    let mut out = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars.saturating_sub(1) {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

fn specs(
    scene: &crate::protocol::Scene,
    theme: &ThemeResource,
    scopes: Option<&ScopeVisuals>,
) -> Vec<LabelSpec> {
    layout::scene_area_labels(scene)
        .into_iter()
        .filter(|geometry| {
            !scene
                .scene_areas
                .iter()
                .any(|area| area.node_id == geometry.node_id)
        })
        .map(|geometry| {
            let title = scene
                .scene_areas
                .iter()
                .find(|area| area.node_id == geometry.node_id)
                .map(|area| {
                    if area.title.trim().is_empty() {
                        "导演区"
                    } else {
                        area.title.as_str()
                    }
                })
                .or_else(|| {
                    scene
                        .nodes
                        .iter()
                        .find(|node| node.id == geometry.node_id)
                        .map(|node| {
                            if node.title.trim().is_empty() {
                                "2D 组"
                            } else {
                                node.title.as_str()
                            }
                        })
                })
                .unwrap_or("组");
            let style = scopes
                .map(|scopes| scopes.style(scene, theme, &geometry.node_id))
                .unwrap_or_else(|| ScopeStyle::for_node(scene, theme, &geometry.node_id));
            LabelSpec {
                text: truncate(
                    title,
                    geometry.width - 2.0 * geometry.padding(),
                    geometry.text_size(),
                ),
                geometry,
                fill: style.label_fill,
                text_color: Color::srgb_u8(
                    (style.label_text >> 16) as u8,
                    (style.label_text >> 8) as u8,
                    style.label_text as u8,
                ),
                border: style.border,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scene_area_names_never_enter_the_2d_overlay() {
        let mut scene = crate::protocol::Scene::default();
        scene.scene_areas = serde_json::from_value(serde_json::json!([
            {"nodeId":"area", "title":"导演区", "bounds":{"min":{"u":0,"v":0},"max":{"u":3,"v":3}}}
        ]))
        .unwrap();
        scene.nodes = serde_json::from_value(serde_json::json!([
            {"id":"group", "type":"workflow-group-2d", "title":"2D 组", "x":0,"y":0,"width":200,"height":100,
             "chrome":{"kind":"frame","groupId":"group","memberNodeIds":[]}}
        ])).unwrap();
        let labels = specs(&scene, &ThemeResource::default(), None);
        assert_eq!(labels.len(), 1);
        assert_eq!(labels[0].geometry.node_id, "group");
        assert_eq!(labels[0].text, "2D 组");
    }
}

fn label_text_mode(geometry: &layout::SceneAreaLabelGeometry, zoom: f32) -> (f32, TextScaleMode) {
    if geometry.scale() > 1.0 {
        (geometry.text_size() * zoom, TextScaleMode::Screen)
    } else {
        (layout::SCENE_AREA_LABEL_TEXT_SIZE, TextScaleMode::World)
    }
}

fn signature(specs: &[LabelSpec], theme: &ThemeResource) -> String {
    let mut out = String::with_capacity(specs.len() * 48);
    for spec in specs {
        use std::fmt::Write;
        let _ = write!(
            out,
            "{}:{:.2},{:.2}:{:.2},{:.2}:{:.2},{:.2}:{}:{}:{}|",
            spec.geometry.node_id,
            spec.geometry.center.x,
            spec.geometry.center.y,
            spec.geometry.axis.x,
            spec.geometry.axis.y,
            spec.geometry.width,
            spec.geometry.height,
            spec.text,
            spec.border,
            spec.fill,
        );
    }
    out.push_str(theme.fingerprint());
    out
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_scene_area_labels(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    scopes: Option<Res<ScopeVisuals>>,
    theme: Res<ThemeResource>,
    visuals: Res<CanvasOverlayCache>,
    materials: Res<CanvasMaterials>,
    mut meshes: ResMut<Assets<Mesh>>,
    mut labels: Query<(
        Entity,
        &SceneAreaLabelText,
        &mut Transform,
        &mut Text2d,
        &mut TextColor,
        &mut LogicalText,
    )>,
    mut layer: Local<SceneAreaLabelLayer>,
) {
    let specs = specs(&scene.0, &theme, scopes.as_deref());

    // 文字：按 node_id 复用；消失的导演区回收实体。
    let mut seen: HashSet<String> = HashSet::with_capacity(specs.len());
    for (entity, marker, mut transform, mut text, mut color, mut meta) in &mut labels {
        let Some(spec) = specs
            .iter()
            .find(|spec| spec.geometry.node_id == marker.node_id)
        else {
            commands.entity(entity).despawn();
            continue;
        };
        seen.insert(marker.node_id.clone());
        let target = Vec3::new(
            spec.geometry.center.x,
            -spec.geometry.center.y,
            LABEL_Z + 0.01,
        );
        if transform.translation != target {
            transform.translation = target;
        }
        let rotation = Quat::from_rotation_z(layout::scene_area_label_rotation(&spec.geometry));
        if transform.rotation != rotation {
            transform.rotation = rotation;
        }
        if text.0 != spec.text {
            text.0 = spec.text.clone();
        }
        if color.0 != spec.text_color {
            color.0 = spec.text_color;
        }
        let (size, mode) = label_text_mode(&spec.geometry, scene.0.viewport.zoom);
        if !meta.matches(size, None, mode) {
            meta.set(size, None, mode);
        }
    }
    for spec in &specs {
        if seen.contains(&spec.geometry.node_id) {
            continue;
        }
        commands.spawn((
            SceneAreaLabelText {
                node_id: spec.geometry.node_id.clone(),
            },
            Text2d::new(spec.text.clone()),
            TextFont {
                font: visuals.font().into(),
                font_size: FontSize::Px(layout::SCENE_AREA_LABEL_TEXT_SIZE),
                ..default()
            },
            TextColor(spec.text_color),
            TextLayout::new(Justify::Center, LineBreak::NoWrap),
            Anchor::CENTER,
            TextBounds::default(),
            {
                let (size, mode) = label_text_mode(&spec.geometry, scene.0.viewport.zoom);
                let mut meta = LogicalText::world(size, None);
                meta.set(size, None, mode);
                meta
            },
            Transform::from_xyz(
                spec.geometry.center.x,
                -spec.geometry.center.y,
                LABEL_Z + 0.01,
            )
            .with_rotation(Quat::from_rotation_z(layout::scene_area_label_rotation(
                &spec.geometry,
            ))),
        ));
    }

    // 胶囊底：同一张 mesh；集合/角度/选中态/主题不变时不重建。
    let next_signature = signature(&specs, &theme);
    if next_signature == layer.signature {
        return;
    }
    layer.signature = next_signature;
    if specs.is_empty() {
        if let Some(entity) = layer.entity.take() {
            commands.entity(entity).despawn();
        }
        if let Some(mesh) = layer.mesh.take() {
            meshes.remove(mesh.id());
        }
        return;
    }
    let mut geometry = Geometry::default();
    for spec in &specs {
        let path = layout::scene_area_label_outline(&spec.geometry);
        geometry.polygon(&path, LABEL_Z, spec.fill);
        geometry.outline(&path, spec.geometry.scale(), LABEL_Z + 0.001, spec.border);
    }
    let handle = meshes.add(geometry.build());
    if let Some(entity) = layer.entity {
        commands.entity(entity).insert(Mesh2d(handle.clone()));
        if let Some(old) = layer.mesh.replace(handle) {
            meshes.remove(old.id());
        }
    } else {
        let entity = commands
            .spawn((
                Mesh2d(handle.clone()),
                MeshMaterial2d(materials.solid.clone()),
                bevy::camera::visibility::NoFrustumCulling,
            ))
            .id();
        layer.entity = Some(entity);
        layer.mesh = Some(handle);
    }
}
