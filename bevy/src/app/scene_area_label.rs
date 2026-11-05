//! Scene-area nameplates belong to the ground scene, including model depth occlusion.
//! Glyphs reuse Bevy's font layout/atlas; only 3D meshes are submitted for drawing.
use super::{CurrentScene, SurfaceState};
use crate::{
    canvas_query::layout::{self, SceneAreaLabelGeometry},
    canvas2d::{
        CanvasOverlayCache,
        geometry::Geometry,
        text_presentation::{self, LogicalText},
    },
    scope_visual::{GROUND_SCOPE_HEIGHT, ScopeStyle, ScopeVisuals},
    theme::ThemeResource,
};
use bevy::{
    asset::{AssetId, RenderAssetUsages},
    camera::visibility::{NoFrustumCulling, RenderLayers},
    ecs::system::SystemParam,
    light::NotShadowCaster,
    prelude::*,
    render::{
        mesh::{Indices, VertexAttributeValues},
        render_resource::PrimitiveTopology,
    },
    text::{
        ComputedTextBlock, FontAtlasSet, FontCx, FontHinting, LayoutCx, LetterSpacing, LineBreak,
        LineHeight, RemSize, ScaleCx, TextBounds, TextElement, TextLayoutInfo, TextPipeline,
    },
};
use std::collections::{HashMap, HashSet};
mod player;

#[derive(Component)]
struct GroundScopeLabel;

struct GlyphVisual {
    entity: Entity,
    mesh: Handle<Mesh>,
    material: Handle<StandardMaterial>,
}
struct LabelVisual {
    body: GlyphVisual,
    controls: Option<GlyphVisual>,
    glyphs: HashMap<AssetId<Image>, GlyphVisual>,
    geometry: Option<SceneAreaLabelGeometry>,
    style: Option<ScopeStyle>,
    text_key: Option<(String, u32)>,
    layout: TextLayoutInfo,
    playback: Option<crate::protocol::SceneAreaPlayback>,
}
#[derive(Default)]
pub(super) struct Labels {
    areas: HashMap<String, LabelVisual>,
}

#[derive(SystemParam)]
pub(super) struct TextResources<'w> {
    fonts: Res<'w, Assets<Font>>,
    images: ResMut<'w, Assets<Image>>,
    atlases: ResMut<'w, FontAtlasSet>,
    pipeline: ResMut<'w, TextPipeline>,
    font_cx: ResMut<'w, FontCx>,
    layout_cx: ResMut<'w, LayoutCx>,
    scale_cx: ResMut<'w, ScaleCx>,
    rem: Res<'w, RemSize>,
}
impl TextResources<'_> {
    fn shape(
        &mut self,
        entity: Entity,
        text: &str,
        font: Handle<Font>,
        font_size: f32,
        dpr: f32,
        viewport: Vec2,
    ) -> Option<TextLayoutInfo> {
        let font = TextFont {
            font: font.into(),
            font_size: FontSize::Px(font_size),
            ..default()
        };
        let span = TextElement::Text {
            text,
            font: &font,
            color: Color::WHITE,
            line_height: LineHeight::default(),
            letter_spacing: LetterSpacing::default(),
        };
        let mut computed = ComputedTextBlock::default();
        self.pipeline
            .update_buffer(
                &self.fonts,
                std::iter::once((entity, 0, span)),
                LineBreak::NoWrap,
                Justify::Left,
                TextBounds::UNBOUNDED,
                dpr,
                &mut computed,
                &mut self.font_cx,
                &mut self.layout_cx,
                viewport,
                *self.rem,
            )
            .ok()?;
        let mut info = TextLayoutInfo::default();
        self.pipeline
            .update_text_layout_info(
                &mut info,
                &mut self.atlases,
                &mut self.images,
                &mut computed,
                &mut self.scale_cx,
                TextBounds::UNBOUNDED,
                Justify::Left,
                FontHinting::Disabled,
            )
            .ok()?;
        Some(info)
    }
}

/// Inverse of the shared canvas projection, constrained to the outline's ground plane.
fn ground_point(point: Vec2) -> Vec3 {
    let rotation = crate::isometric_grid::view_rotation();
    let x = rotation * Vec3::X;
    let z = rotation * Vec3::Z;
    let determinant = x.x * z.y - z.x * x.y;
    let y = -point.y;
    Vec3::new(
        (point.x * z.y - z.x * y) / determinant,
        GROUND_SCOPE_HEIGHT,
        (x.x * y - point.x * x.y) / determinant,
    )
}
fn label_point(geometry: &SceneAreaLabelGeometry, local: Vec2) -> Vec3 {
    ground_point(geometry.center + geometry.axis * local.x - geometry.axis.perp() * local.y)
}
fn body_shape(geometry: &SceneAreaLabelGeometry, style: ScopeStyle) -> Geometry {
    let mut shape = Geometry::default();
    let outline = layout::scene_area_label_outline(geometry);
    // Share the exact inner edge with Geometry::outline rather than overlap two fills.
    let inner: Vec<_> = (0..outline.len())
        .map(|i| {
            let previous = outline[(i + outline.len() - 1) % outline.len()];
            let next = outline[(i + 1) % outline.len()];
            let a = (outline[i] - previous).normalize_or_zero().perp();
            let b = (next - outline[i]).normalize_or_zero().perp();
            let normal = (a + b).normalize_or_zero();
            outline[i] + normal * (0.5 * geometry.scale() / normal.dot(b).abs().max(0.25))
        })
        .collect();
    shape.polygon(&inner, 0.0, style.label_fill);
    shape.outline(&outline, geometry.scale(), 0.0, style.border);
    shape
}
fn body_mesh(geometry: &SceneAreaLabelGeometry, style: ScopeStyle) -> Mesh {
    ground_mesh(body_shape(geometry, style))
}
fn ground_mesh(shape: Geometry) -> Mesh {
    let mut mesh = shape.build();
    let count = if let Some(VertexAttributeValues::Float32x3(points)) =
        mesh.attribute_mut(Mesh::ATTRIBUTE_POSITION)
    {
        for point in points.iter_mut() {
            *point = ground_point(Vec2::new(point[0], -point[1])).to_array();
        }
        points.len()
    } else {
        0
    };
    mesh.insert_attribute(Mesh::ATTRIBUTE_NORMAL, vec![Vec3::Y.to_array(); count]);
    mesh.insert_attribute(Mesh::ATTRIBUTE_UV_0, vec![[0.0, 0.0]; count]);
    mesh
}

#[derive(Default)]
struct GlyphMesh {
    positions: Vec<[f32; 3]>,
    uvs: Vec<[f32; 2]>,
    indices: Vec<u32>,
}
impl GlyphMesh {
    fn build(self) -> Mesh {
        let count = self.positions.len();
        Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.positions)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![Vec3::Y.to_array(); count])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uvs)
        .with_inserted_indices(Indices::U32(self.indices))
    }
}
fn glyph_meshes(
    info: &TextLayoutInfo,
    geometry: &SceneAreaLabelGeometry,
    scale: f32,
    images: &Assets<Image>,
) -> HashMap<AssetId<Image>, GlyphMesh> {
    let mut batches: HashMap<AssetId<Image>, GlyphMesh> = HashMap::new();
    for glyph in &info.glyphs {
        let atlas = &glyph.atlas_info;
        let Some(image) = images.get(atlas.texture) else {
            continue;
        };
        let atlas_size = image.size().as_vec2();
        let batch = batches.entry(atlas.texture).or_default();
        let center = (glyph.position - info.size * 0.5) * scale;
        let half = atlas.rect.size() * scale * 0.5;
        let base = batch.positions.len() as u32;
        for (corner, uv) in [
            (Vec2::new(-half.x, -half.y), atlas.rect.min),
            (
                Vec2::new(half.x, -half.y),
                Vec2::new(atlas.rect.max.x, atlas.rect.min.y),
            ),
            (Vec2::new(half.x, half.y), atlas.rect.max),
            (
                Vec2::new(-half.x, half.y),
                Vec2::new(atlas.rect.min.x, atlas.rect.max.y),
            ),
        ] {
            let pixel = center + corner;
            batch
                .positions
                .push(label_point(geometry, Vec2::new(pixel.x, -pixel.y)).to_array());
            batch.uvs.push((uv / atlas_size).to_array());
        }
        batch
            .indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    batches
}
fn rgb(color: u32) -> Color {
    Color::srgb_u8((color >> 16) as u8, (color >> 8) as u8, color as u8)
}
fn spawn_visual(
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
    mesh: Mesh,
    material: StandardMaterial,
) -> GlyphVisual {
    let mesh = meshes.add(mesh);
    let material = materials.add(material);
    let entity = commands
        .spawn((
            GroundScopeLabel,
            Mesh3d(mesh.clone()),
            MeshMaterial3d(material.clone()),
            RenderLayers::from_layers(&[
                crate::world_camera::WORLD_CAMERA_GIZMO_LAYER,
                crate::world_camera_preview::EDITOR_GUIDE_LAYER,
            ]),
            NoFrustumCulling,
            NotShadowCaster,
        ))
        .id();
    GlyphVisual {
        entity,
        mesh,
        material,
    }
}
fn remove_visual(
    visual: &GlyphVisual,
    commands: &mut Commands,
    meshes: &mut Assets<Mesh>,
    materials: &mut Assets<StandardMaterial>,
) {
    commands.entity(visual.entity).despawn();
    meshes.remove(visual.mesh.id());
    materials.remove(visual.material.id());
}

#[allow(clippy::too_many_arguments)]
pub(super) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    theme: Res<ThemeResource>,
    scopes: Option<Res<ScopeVisuals>>,
    canvas: Res<CanvasOverlayCache>,
    mut text: TextResources,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<StandardMaterial>>,
    mut labels: Local<Labels>,
) {
    let mut seen = HashSet::new();
    let hidden = scene.0.model_focus.is_some()
        || scene.0.image_focus.is_some()
        || scene.0.video_focus.is_some();
    if !hidden {
        for (area, is_player) in scene
            .0
            .scene_areas
            .iter()
            .flat_map(|area| [(area, false), (area, true)])
        {
            let Some(geometry) = (if is_player {
                crate::canvas_query::scene_area_player::geometry(area, scene.0.viewport.zoom)
            } else {
                layout::scene_area_label_geometry_for_zoom(area, scene.0.viewport.zoom)
            }) else {
                continue;
            };
            let dpr = surface.pixel_ratio.min(text_presentation::MAX_DPR);
            let Some(target) = text_presentation::present(
                &LogicalText::world(layout::SCENE_AREA_LABEL_TEXT_SIZE, None),
                scene.0.viewport.zoom * geometry.scale(),
                dpr,
            ) else {
                continue;
            };
            let key = if is_player {
                format!("{}:playback", area.node_id)
            } else {
                area.node_id.clone()
            };
            seen.insert(key.clone());
            let playback = if is_player {
                area.playback.clone()
            } else {
                None
            };
            let style = scopes
                .as_deref()
                .map(|scopes| scopes.style(&scene.0, &theme, &area.node_id))
                .unwrap_or_else(|| ScopeStyle::for_node(&scene.0, &theme, &area.node_id));
            let visual = labels.areas.entry(key).or_insert_with(|| LabelVisual {
                body: spawn_visual(
                    &mut commands,
                    &mut meshes,
                    &mut materials,
                    body_mesh(&geometry, style),
                    StandardMaterial {
                        unlit: true,
                        cull_mode: None,
                        // Only resolves coplanarity with the outline; scene depth testing stays enabled.
                        depth_bias: 1.0,
                        ..default()
                    },
                ),
                controls: None,
                glyphs: HashMap::new(),
                geometry: None,
                style: None,
                text_key: None,
                layout: TextLayoutInfo::default(),
                playback: None,
            });
            let geometry_changed = visual.geometry.as_ref() != Some(&geometry);
            if geometry_changed || visual.style != Some(style) {
                meshes
                    .insert(visual.body.mesh.id(), body_mesh(&geometry, style))
                    .expect("retained label mesh");
            }
            if let Some(state) = &playback {
                if geometry_changed || visual.style != Some(style) || visual.playback != playback {
                    let mesh = player::mesh(&geometry, style, state, &theme);
                    if let Some(controls) = &visual.controls {
                        meshes
                            .insert(controls.mesh.id(), mesh)
                            .expect("retained player ink");
                    } else {
                        visual.controls = Some(spawn_visual(
                            &mut commands,
                            &mut meshes,
                            &mut materials,
                            mesh,
                            StandardMaterial {
                                unlit: true,
                                alpha_mode: AlphaMode::Blend,
                                cull_mode: None,
                                depth_bias: 2.0,
                                ..default()
                            },
                        ));
                    }
                }
            }
            let title = if area.title.trim().is_empty() {
                "导演区"
            } else {
                &area.title
            };
            let limit = ((geometry.width - 2.0 * geometry.padding()) / geometry.text_size())
                .max(1.0) as usize;
            let mut title: String = title.chars().take(limit).collect();
            if title.chars().count() < area.title.chars().count() {
                title.pop();
                title.push('…');
            }
            let title = if let Some(state) = &playback {
                format!("{:.1} / {:.1}s", state.time, state.duration)
            } else {
                title
            };
            let text_key = (title, (target.font_size * dpr).round().max(1.0) as u32);
            let mut layout_changed = false;
            if visual.text_key.as_ref() != Some(&text_key) {
                if let Some(info) = text.shape(
                    visual.body.entity,
                    &text_key.0,
                    canvas.font(),
                    target.font_size,
                    dpr,
                    surface.size,
                ) {
                    visual.layout = info;
                    visual.text_key = Some(text_key.clone());
                    layout_changed = true;
                }
            }
            if geometry_changed || layout_changed {
                let scale = visual
                    .text_key
                    .as_ref()
                    .map_or(1.0, |key| geometry.text_size() / key.1 as f32);
                let mut text_geometry = geometry.clone();
                if is_player {
                    text_geometry.center += geometry.axis * (54.0 * geometry.scale());
                }
                let batches = glyph_meshes(&visual.layout, &text_geometry, scale, &text.images);
                visual.glyphs.retain(|atlas, glyph| {
                    if batches.contains_key(atlas) {
                        true
                    } else {
                        remove_visual(glyph, &mut commands, &mut meshes, &mut materials);
                        false
                    }
                });
                for (atlas, batch) in batches {
                    if let Some(glyph) = visual.glyphs.get(&atlas) {
                        meshes
                            .insert(glyph.mesh.id(), batch.build())
                            .expect("retained glyph mesh");
                    } else if let Some(image) = text.images.get_strong_handle(atlas) {
                        let glyph = spawn_visual(
                            &mut commands,
                            &mut meshes,
                            &mut materials,
                            batch.build(),
                            StandardMaterial {
                                base_color: rgb(style.label_text),
                                base_color_texture: Some(image),
                                unlit: true,
                                alpha_mode: AlphaMode::Blend,
                                cull_mode: None,
                                depth_bias: 2.0,
                                ..default()
                            },
                        );
                        visual.glyphs.insert(atlas, glyph);
                    }
                }
            }
            for glyph in visual.glyphs.values() {
                if let Some(mut material) = materials.get_mut(&glyph.material) {
                    let color = rgb(style.label_text);
                    if material.base_color != color {
                        material.base_color = color;
                    }
                }
            }
            visual.geometry = Some(geometry);
            visual.style = Some(style);
            visual.playback = playback;
        }
    }
    labels.areas.retain(|id, visual| {
        if seen.contains(id) {
            return true;
        }
        remove_visual(&visual.body, &mut commands, &mut meshes, &mut materials);
        if let Some(controls) = &visual.controls {
            remove_visual(controls, &mut commands, &mut meshes, &mut materials);
        }
        for glyph in visual.glyphs.values() {
            remove_visual(glyph, &mut commands, &mut meshes, &mut materials);
        }
        false
    });
}

#[cfg(test)]
mod tests;
