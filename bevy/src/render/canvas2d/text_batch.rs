//! Retained 2D text mesh batching for card and edge labels.
//!
//! Card and edge labels use `TextScaleMode::World`, whose glyph positions in world space are
//! invariant across camera panning and same-step zooming (`zoom <= 1.0`). Instead of letting Bevy
//! traverse, cull, and extract 24,000 individual `Text2d` entities every frame, this module shapes
//! unique `(text, font_size, dpr, justify)` runs through `TextPipeline` and bakes glyphs into
//! block-grouped `Mesh2d` chunks bound to the `FontAtlas` textures.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use bevy::{
    asset::{AssetId, RenderAssetUsages},
    camera::visibility::{
        InheritedVisibility, NoCpuCulling, NoFrustumCulling, ViewVisibility, VisibilityClass,
    },
    ecs::system::SystemParam,
    prelude::*,
    render::{mesh::Indices, render_resource::PrimitiveTopology},
    sprite::Anchor,
    sprite_render::AlphaMode2d,
    text::{
        ComputedTextBlock, FontAtlasSet, FontCx, FontHinting, LayoutCx, LetterSpacing, LineBreak,
        LineHeight, RemSize, ScaleCx, TextBounds, TextColor, TextElement, TextFont, TextLayout,
        TextLayoutInfo, TextPipeline,
    },
};

use super::{CanvasOverlayCache, CardBlockCache, EdgeBlockCache, text_presentation};
use crate::{
    app::{CurrentScene, FrameFlags, SurfaceState},
    canvas_ecs::components::{CanvasLabel, CanvasLabelRole, CanvasNodeId},
};

/// Number of 16-item card/edge blocks grouped into one retained text `Mesh2d` chunk.
const BLOCKS_PER_CHUNK: u32 = 4;

/// Marker placed on `CanvasLabel` entities (`Card` and `Edge`) whose glyphs are baked into
/// retained `Mesh2d` chunks so Bevy's per-entity `Text2d` systems skip them.
#[derive(Component)]
pub(crate) struct BatchedCanvasLabel;

/// Marker placed on retained chunk `Mesh2d` entities owned by [`TextBatchCache`].
#[derive(Component)]
pub(crate) struct TextBatchChunkMesh;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum ChunkKey {
    Card(u32),
    Edge(u32),
    OrphanCard,
    OrphanEdge,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct ShapeKey {
    text: String,
    font_size_bits: u32,
    dpr_bits: u32,
    justify: u8,
}

#[derive(Clone, Debug)]
struct ShapedGlyph {
    position: Vec2,
    rect: Rect,
    texture: AssetId<Image>,
}

#[derive(Clone, Debug, Default)]
struct ShapedRun {
    size: Vec2,
    glyphs: Vec<ShapedGlyph>,
}

struct ChunkVisual {
    entity: Entity,
    mesh: Handle<Mesh>,
}

#[derive(Default)]
struct ChunkState {
    visuals: HashMap<AssetId<Image>, ChunkVisual>,
    visible: Option<bool>,
}

/// Retained cache of shaped glyph runs and block-grouped `Mesh2d` chunks.
#[derive(Resource, Default)]
pub(crate) struct TextBatchCache {
    canvas_id: String,
    font_was_ready: bool,
    last_dpr_bits: u32,
    /// 上一帧已烘焙的有效相机倍率；与当前一致即没有文字需要重新栅格化。
    pub last_zoom_bits: u32,
    shaped: HashMap<ShapeKey, ShapedRun>,
    materials: HashMap<AssetId<Image>, Handle<ColorMaterial>>,
    label_chunk: HashMap<Entity, ChunkKey>,
    chunk_labels: HashMap<ChunkKey, BTreeSet<Entity>>,
    chunks: HashMap<ChunkKey, ChunkState>,
    dirty_chunks: BTreeSet<ChunkKey>,
    /// 走完整重建/扫描的次数；纯平移早退不得增加（测试可观测「零扫描」）。
    #[cfg(test)]
    pub(crate) full_rebuilds: usize,
}

impl TextBatchCache {
    /// 丢弃保留状态并把 zoom 基准清零，让下一帧按「zoom 已变」走完整流程，
    /// 而不是命中纯平移的零扫描早退。
    fn clear(&mut self) {
        self.label_chunk.clear();
        self.chunk_labels.clear();
        self.dirty_chunks.clear();
        self.last_zoom_bits = 0;
    }

    fn clear_chunks(&mut self, commands: &mut Commands, meshes: &mut Assets<Mesh>) {
        for (_, mut state) in self.chunks.drain() {
            for (_, visual) in state.visuals.drain() {
                commands.entity(visual.entity).despawn();
                meshes.remove(visual.mesh.id());
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn chunk_mesh_count(&self) -> usize {
        self.chunks.values().map(|c| c.visuals.len()).sum()
    }
}

#[derive(SystemParam)]
pub(crate) struct TextShapeParams<'w> {
    pub(crate) fonts: Res<'w, Assets<Font>>,
    pub(crate) images: ResMut<'w, Assets<Image>>,
    pub(crate) atlases: ResMut<'w, FontAtlasSet>,
    pub(crate) pipeline: ResMut<'w, TextPipeline>,
    pub(crate) font_cx: ResMut<'w, FontCx>,
    pub(crate) layout_cx: ResMut<'w, LayoutCx>,
    pub(crate) scale_cx: ResMut<'w, ScaleCx>,
    pub(crate) rem: Res<'w, RemSize>,
}

impl TextShapeParams<'_> {
    fn shape(
        &mut self,
        entity: Entity,
        text: &str,
        font: Handle<Font>,
        font_size: f32,
        dpr: f32,
        justify: Justify,
        viewport: Vec2,
    ) -> Option<ShapedRun> {
        if text.is_empty() {
            return Some(ShapedRun::default());
        }
        let text_font = TextFont {
            font: font.into(),
            font_size: FontSize::Px(font_size),
            ..default()
        };
        let span = TextElement::Text {
            text,
            font: &text_font,
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
                justify,
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
                justify,
                FontHinting::Disabled,
            )
            .ok()?;
        let glyphs = info
            .glyphs
            .into_iter()
            .map(|g| ShapedGlyph {
                position: g.position,
                rect: g.atlas_info.rect,
                texture: g.atlas_info.texture,
            })
            .collect();
        Some(ShapedRun {
            size: info.size,
            glyphs,
        })
    }
}

#[derive(Default)]
struct GlyphBatchBuffer {
    positions: Vec<[f32; 3]>,
    uvs: Vec<[f32; 2]>,
    colors: Vec<[f32; 4]>,
    indices: Vec<u32>,
}

impl GlyphBatchBuffer {
    fn build(self) -> Mesh {
        let len = self.positions.len();
        Mesh::new(
            PrimitiveTopology::TriangleList,
            RenderAssetUsages::default(),
        )
        .with_inserted_attribute(Mesh::ATTRIBUTE_POSITION, self.positions)
        .with_inserted_attribute(Mesh::ATTRIBUTE_NORMAL, vec![[0.0, 0.0, 1.0]; len])
        .with_inserted_attribute(Mesh::ATTRIBUTE_UV_0, self.uvs)
        .with_inserted_attribute(Mesh::ATTRIBUTE_COLOR, self.colors)
        .with_inserted_indices(Indices::U32(self.indices))
    }
}

fn is_batched_role(role: CanvasLabelRole) -> bool {
    matches!(role, CanvasLabelRole::Card | CanvasLabelRole::Edge)
}

fn chunk_key_for(
    role: CanvasLabelRole,
    parent: Entity,
    cards: &CardBlockCache,
    edges: &EdgeBlockCache,
) -> ChunkKey {
    match role {
        CanvasLabelRole::Card => cards.owner_block(parent).map_or(ChunkKey::OrphanCard, |b| {
            ChunkKey::Card(b / BLOCKS_PER_CHUNK)
        }),
        CanvasLabelRole::Edge => edges
            .entity_block(parent)
            .map_or(ChunkKey::OrphanEdge, |b| {
                ChunkKey::Edge(b / BLOCKS_PER_CHUNK)
            }),
        _ => ChunkKey::OrphanCard,
    }
}

fn chunk_is_visible(key: ChunkKey, cards: &CardBlockCache, edges: &EdgeBlockCache) -> bool {
    if cfg!(feature = "canvas-reference") {
        return true;
    }
    match key {
        ChunkKey::Card(chunk) => {
            let count = cards.block_count();
            if count == 0 {
                return true;
            }
            let start = chunk * BLOCKS_PER_CHUNK;
            let end = (start + BLOCKS_PER_CHUNK).min(count);
            (start..end).any(|b| cards.block_visible(b))
        }
        ChunkKey::Edge(chunk) => {
            let count = edges.block_count();
            if count == 0 {
                return true;
            }
            let start = chunk * BLOCKS_PER_CHUNK;
            let end = (start + BLOCKS_PER_CHUNK).min(count);
            (start..end).any(|b| edges.block_visible(b))
        }
        ChunkKey::OrphanCard | ChunkKey::OrphanEdge => true,
    }
}

fn justify_code(justify: Justify) -> u8 {
    match justify {
        Justify::Left => 0,
        Justify::Center => 1,
        Justify::Right => 2,
        Justify::Justified => 3,
        Justify::Start => 4,
        Justify::End => 5,
    }
}

fn resolve_font_size(font: &TextFont) -> f32 {
    match font.font_size {
        FontSize::Px(px) => px,
        _ => 12.0,
    }
}

#[derive(SystemParam)]
pub(crate) struct TextBatchQueries<'w, 's> {
    unbatched: Query<
        'w,
        's,
        (Entity, &'static CanvasLabel, &'static ChildOf),
        Without<BatchedCanvasLabel>,
    >,
    changed_labels: Query<
        'w,
        's,
        (Entity, &'static CanvasLabel, &'static ChildOf),
        (
            With<BatchedCanvasLabel>,
            Or<(
                Changed<Text2d>,
                Changed<TextFont>,
                Changed<TextColor>,
                Changed<TextLayout>,
                Changed<TextBounds>,
                Changed<Anchor>,
                Changed<Transform>,
                Changed<ChildOf>,
            )>,
        ),
    >,
    removed: RemovedComponents<'w, 's, BatchedCanvasLabel>,
    changed_owners: Query<'w, 's, Entity, (With<CanvasNodeId>, Changed<Visibility>)>,
    owner_visibility: Query<'w, 's, &'static Visibility, With<CanvasNodeId>>,
    all_labels: Query<
        'w,
        's,
        (
            &'static CanvasLabel,
            &'static ChildOf,
            &'static Text2d,
            &'static TextFont,
            &'static TextColor,
            &'static TextLayout,
            &'static TextBounds,
            &'static Anchor,
            &'static Transform,
        ),
    >,
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
pub(crate) fn sync(
    mut commands: Commands,
    scene: Res<CurrentScene>,
    surface: Res<SurfaceState>,
    flags: Option<Res<FrameFlags>>,
    visuals: Res<CanvasOverlayCache>,
    cards: Res<CardBlockCache>,
    edges: Res<EdgeBlockCache>,
    mut cache: ResMut<TextBatchCache>,
    mut shape_params: TextShapeParams,
    mut meshes: ResMut<Assets<Mesh>>,
    mut materials: ResMut<Assets<ColorMaterial>>,
    mut queries: TextBatchQueries,
) {
    let dpr = surface.pixel_ratio.min(text_presentation::MAX_DPR).max(1.0);
    let dpr_bits = dpr.to_bits();

    if !scene.0.canvas_id.is_empty() && cache.canvas_id != scene.0.canvas_id {
        cache.canvas_id.clone_from(&scene.0.canvas_id);
        cache.clear_chunks(&mut commands, &mut meshes);
        cache.clear();
    }

    // 纯平移帧：文字块 `Mesh2d` 的世界坐标只由标签自身布局决定，`observer.x / observer.y`
    // 变化只移动相机与 `CardBlockOrigin`，不改任何文字块 Mesh。此时不必遍历 24,000 个
    // `changed_labels`，只按工作集刷新块可见性（O(块数)）后直接返回。
    let zoom_bits = effective_zoom_bits(&scene);
    let zoom_changed = cache.last_zoom_bits != zoom_bits;
    let needs_full_rebuild = dpr_bits != cache.last_dpr_bits || zoom_changed;
    let quiet_flags = flags.as_ref().is_some_and(|flags| {
        !flags.scene_received
            && !flags.positions_received
            && !flags.theme_changed
            && !flags.surface_changed
    });
    // `font_was_ready` / `dirty_chunks` 是「上一次同步还没收尾」的标记：字体迟到或块仍脏时
    // 必须继续原有流程，否则早退会把待烘焙的块永远留在缓存里。
    let pure_pan =
        !needs_full_rebuild && quiet_flags && cache.font_was_ready && cache.dirty_chunks.is_empty();
    if pure_pan && queries.removed.is_empty() {
        // 零扫描早退：不碰 `changed_labels` / `all_labels` / 形状缓存。
        sync_chunk_visibility(&mut commands, &cards, &edges, &mut cache);
        return;
    }
    cache.last_zoom_bits = zoom_bits;
    #[cfg(test)]
    {
        cache.full_rebuilds += 1;
    }

    if cache.last_dpr_bits != dpr_bits {
        cache.last_dpr_bits = dpr_bits;
        cache.shaped.clear();
        let all_keys: Vec<ChunkKey> = cache.chunk_labels.keys().copied().collect();
        cache.dirty_chunks.extend(all_keys);
    }

    for entity in queries.removed.read() {
        if let Some(old_chunk) = cache.label_chunk.remove(&entity) {
            if let Some(set) = cache.chunk_labels.get_mut(&old_chunk) {
                set.remove(&entity);
            }
            cache.dirty_chunks.insert(old_chunk);
        }
    }

    for (entity, label, child) in &queries.unbatched {
        if !is_batched_role(label.role) {
            continue;
        }
        commands
            .entity(entity)
            .insert((BatchedCanvasLabel, NoCpuCulling))
            .remove::<(
                TextLayoutInfo,
                VisibilityClass,
                InheritedVisibility,
                ViewVisibility,
                GlobalTransform,
            )>();
        let chunk = chunk_key_for(label.role, child.parent(), &cards, &edges);
        if let Some(old_chunk) = cache.label_chunk.insert(entity, chunk)
            && old_chunk != chunk
        {
            if let Some(set) = cache.chunk_labels.get_mut(&old_chunk) {
                set.remove(&entity);
            }
            cache.dirty_chunks.insert(old_chunk);
        }
        cache.chunk_labels.entry(chunk).or_default().insert(entity);
        cache.dirty_chunks.insert(chunk);
    }

    for (entity, label, child) in &queries.changed_labels {
        if !is_batched_role(label.role) {
            continue;
        }
        let chunk = chunk_key_for(label.role, child.parent(), &cards, &edges);
        if let Some(old_chunk) = cache.label_chunk.insert(entity, chunk)
            && old_chunk != chunk
        {
            if let Some(set) = cache.chunk_labels.get_mut(&old_chunk) {
                set.remove(&entity);
            }
            cache.dirty_chunks.insert(old_chunk);
        }
        cache.chunk_labels.entry(chunk).or_default().insert(entity);
        cache.dirty_chunks.insert(chunk);
    }

    for owner in &queries.changed_owners {
        if let Some(block) = cards.owner_block(owner) {
            cache
                .dirty_chunks
                .insert(ChunkKey::Card(block / BLOCKS_PER_CHUNK));
        } else {
            cache.dirty_chunks.insert(ChunkKey::OrphanCard);
        }
    }

    let font_ready = super::font_ready(&shape_params.fonts, &visuals);
    if !font_ready {
        cache.font_was_ready = false;
        return;
    }
    if !cache.font_was_ready {
        cache.font_was_ready = true;
        let all_keys: Vec<ChunkKey> = cache.chunk_labels.keys().copied().collect();
        cache.dirty_chunks.extend(all_keys);
    }

    let dirty_chunks = std::mem::take(&mut cache.dirty_chunks);
    let font_handle = visuals.font();
    let viewport_size = surface.size.max(Vec2::ONE);

    for chunk_key in dirty_chunks {
        let mut stale_entities = Vec::new();
        let mut remapped_entities = Vec::new();
        let mut sorted_labels = Vec::new();

        if let Some(entities) = cache.chunk_labels.get(&chunk_key) {
            for &entity in entities {
                let Ok((
                    label,
                    child,
                    text2d,
                    text_font,
                    text_color,
                    text_layout,
                    bounds,
                    anchor,
                    transform,
                )) = queries.all_labels.get(entity)
                else {
                    stale_entities.push(entity);
                    continue;
                };
                let actual_chunk = chunk_key_for(label.role, child.parent(), &cards, &edges);
                if actual_chunk != chunk_key {
                    remapped_entities.push((entity, actual_chunk));
                    continue;
                }
                if queries.owner_visibility.get(child.parent()) == Ok(&Visibility::Hidden) {
                    continue;
                }
                if text2d.0.is_empty() {
                    continue;
                }
                sorted_labels.push((
                    label.slot,
                    entity,
                    text2d.0.as_str(),
                    resolve_font_size(text_font),
                    text_color.0,
                    text_layout.justify,
                    *bounds,
                    *anchor,
                    *transform,
                ));
            }
        }

        if !stale_entities.is_empty() {
            if let Some(set) = cache.chunk_labels.get_mut(&chunk_key) {
                for &entity in &stale_entities {
                    set.remove(&entity);
                }
            }
            for entity in stale_entities {
                cache.label_chunk.remove(&entity);
            }
        }

        if !remapped_entities.is_empty() {
            for (entity, new_chunk) in remapped_entities {
                if let Some(set) = cache.chunk_labels.get_mut(&chunk_key) {
                    set.remove(&entity);
                }
                cache.label_chunk.insert(entity, new_chunk);
                cache
                    .chunk_labels
                    .entry(new_chunk)
                    .or_default()
                    .insert(entity);
                cache.dirty_chunks.insert(new_chunk);
            }
        }

        sorted_labels.sort_by_key(|(slot, entity, ..)| (*slot, *entity));

        let mut batches: BTreeMap<AssetId<Image>, GlyphBatchBuffer> = BTreeMap::new();
        let inv_dpr = dpr.recip();

        for (_, entity, text, font_size, color, justify, bounds, anchor, transform) in sorted_labels
        {
            let shape_key = ShapeKey {
                text: text.to_owned(),
                font_size_bits: font_size.to_bits(),
                dpr_bits,
                justify: justify_code(justify),
            };
            let run = if let Some(existing) = cache.shaped.get(&shape_key) {
                existing.clone()
            } else {
                let Some(shaped) = shape_params.shape(
                    entity,
                    text,
                    font_handle.clone(),
                    font_size,
                    dpr,
                    justify,
                    viewport_size,
                ) else {
                    continue;
                };
                cache.shaped.insert(shape_key, shaped.clone());
                shaped
            };

            if run.glyphs.is_empty() {
                continue;
            }

            let size = Vec2::new(
                bounds.width.unwrap_or(run.size.x * inv_dpr),
                bounds.height.unwrap_or(run.size.y * inv_dpr),
            );
            let top_left = (Anchor::TOP_LEFT.0 - anchor.as_vec()) * size;
            let scale = transform.scale.truncate();
            let translation = transform.translation;
            let rgba = color.to_linear().to_f32_array();

            for glyph in &run.glyphs {
                let Some(image) = shape_params.images.get(glyph.texture) else {
                    continue;
                };
                let atlas_size = image.size().as_vec2();
                if atlas_size.x <= 0.0 || atlas_size.y <= 0.0 {
                    continue;
                }
                let batch = batches.entry(glyph.texture).or_default();
                let half = glyph.rect.size() * 0.5;
                let base = batch.positions.len() as u32;

                for (corner, uv) in [
                    (Vec2::new(-half.x, -half.y), glyph.rect.min),
                    (
                        Vec2::new(half.x, -half.y),
                        Vec2::new(glyph.rect.max.x, glyph.rect.min.y),
                    ),
                    (Vec2::new(half.x, half.y), glyph.rect.max),
                    (
                        Vec2::new(-half.x, half.y),
                        Vec2::new(glyph.rect.min.x, glyph.rect.max.y),
                    ),
                ] {
                    let px = glyph.position + corner;
                    let local = top_left + Vec2::new(px.x * inv_dpr, -px.y * inv_dpr);
                    let world_xy = translation.truncate() + local * scale;
                    batch
                        .positions
                        .push([world_xy.x, world_xy.y, translation.z]);
                    batch.uvs.push((uv / atlas_size).to_array());
                    batch.colors.push(rgba);
                }
                batch.indices.extend_from_slice(&[
                    base,
                    base + 2,
                    base + 1,
                    base,
                    base + 3,
                    base + 2,
                ]);
            }
        }

        let visible = chunk_is_visible(chunk_key, &cards, &edges);
        let visibility_component = if visible {
            Visibility::Visible
        } else {
            Visibility::Hidden
        };

        let mut new_materials = Vec::new();
        for &texture_id in batches.keys() {
            if !cache.materials.contains_key(&texture_id)
                && let Some(image_handle) = shape_params.images.get_strong_handle(texture_id)
            {
                let mat = materials.add(ColorMaterial {
                    color: Color::WHITE,
                    alpha_mode: AlphaMode2d::Blend,
                    texture: Some(image_handle),
                    ..default()
                });
                new_materials.push((texture_id, mat));
            }
        }
        for (texture_id, mat) in new_materials {
            cache.materials.insert(texture_id, mat);
        }
        let material_snapshot: HashMap<AssetId<Image>, Handle<ColorMaterial>> = batches
            .keys()
            .filter_map(|id| cache.materials.get(id).cloned().map(|m| (*id, m)))
            .collect();

        let state = cache.chunks.entry(chunk_key).or_default();
        state.visible = Some(visible);
        state.visuals.retain(|texture_id, visual| {
            if batches.contains_key(texture_id) {
                true
            } else {
                commands.entity(visual.entity).despawn();
                meshes.remove(visual.mesh.id());
                false
            }
        });

        for (texture_id, batch) in batches {
            let mesh = batch.build();
            if let Some(visual) = state.visuals.get(&texture_id) {
                let _ = meshes.insert(visual.mesh.id(), mesh);
                commands.entity(visual.entity).insert(visibility_component);
            } else if let Some(material) = material_snapshot.get(&texture_id).cloned() {
                let mesh_handle = meshes.add(mesh);
                let entity = commands
                    .spawn((
                        TextBatchChunkMesh,
                        Mesh2d(mesh_handle.clone()),
                        MeshMaterial2d(material),
                        visibility_component,
                        NoFrustumCulling,
                    ))
                    .id();
                state.visuals.insert(
                    texture_id,
                    ChunkVisual {
                        entity,
                        mesh: mesh_handle,
                    },
                );
            }
        }
    }

    sync_chunk_visibility(&mut commands, &cards, &edges, &mut cache);
}

/// 有效相机倍率（与 `text_presentation` 内的同源函数逐位一致：模型聚焦固定 1，
/// 媒体聚焦取聚焦取景，其余取 overview viewport）。
fn effective_zoom_bits(scene: &CurrentScene) -> u32 {
    if scene.0.model_focus.is_some() {
        return 1.0f32.to_bits();
    }
    super::image_focus::camera_view(&scene.0)
        .map(|(_, _, zoom)| zoom)
        .unwrap_or(scene.0.viewport.zoom)
        .to_bits()
}

/// 纯平移帧的 O(块数) 刷新：文字块 Mesh 不变，只有工作集可见性可能变化。
fn sync_chunk_visibility(
    commands: &mut Commands,
    cards: &CardBlockCache,
    edges: &EdgeBlockCache,
    cache: &mut TextBatchCache,
) {
    for (&chunk_key, state) in &mut cache.chunks {
        let visible = chunk_is_visible(chunk_key, cards, edges);
        if state.visible != Some(visible) {
            state.visible = Some(visible);
            let visibility_component = if visible {
                Visibility::Visible
            } else {
                Visibility::Hidden
            };
            for visual in state.visuals.values() {
                commands.entity(visual.entity).insert(visibility_component);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canvas2d::{CanvasMaterials, text_presentation::LogicalText};

    fn test_app() -> App {
        let mut app = App::new();
        app.add_plugins((
            MinimalPlugins,
            bevy::asset::AssetPlugin::default(),
            bevy::image::ImagePlugin::default(),
            bevy::text::TextPlugin,
        ));
        app.init_resource::<CurrentScene>();
        app.init_resource::<SurfaceState>();
        app.init_resource::<CardBlockCache>();
        app.init_resource::<EdgeBlockCache>();
        app.init_resource::<TextBatchCache>();
        app.init_resource::<Assets<Mesh>>();
        app.init_resource::<Assets<ColorMaterial>>();

        let bytes = include_bytes!("../../../assets/fonts/NotoSansSC-Regular.otf").to_vec();
        let font = app
            .world_mut()
            .resource_mut::<Assets<Font>>()
            .add(Font::from_bytes(bytes));
        let mesh = app
            .world_mut()
            .resource_mut::<Assets<Mesh>>()
            .add(super::super::geometry::Geometry::default().build());
        let solid = app
            .world_mut()
            .resource_mut::<Assets<ColorMaterial>>()
            .add(ColorMaterial::default());
        let blend = app
            .world_mut()
            .resource_mut::<Assets<ColorMaterial>>()
            .add(ColorMaterial::default());
        app.insert_resource(CanvasMaterials {
            solid: solid.clone(),
            blend: blend.clone(),
            font: font.clone(),
        });
        app.insert_resource(CanvasOverlayCache {
            mesh: mesh.clone(),
            material: solid,
            mesh_entity: None,
            blend_mesh: mesh,
            blend_material: blend,
            blend_mesh_entity: None,
            static_blend: super::super::geometry::Geometry::default(),
            font,
        });
        app.add_systems(
            PostUpdate,
            (sync, bevy::ecs::schedule::ApplyDeferred)
                .chain()
                .after(bevy::text::load_font_assets_into_font_collection),
        );
        app
    }

    #[test]
    fn batches_card_labels_into_chunk_mesh_and_strips_per_entity_text_components() {
        let mut app = test_app();
        let font = app.world().resource::<CanvasOverlayCache>().font();
        let owner = app.world_mut().spawn(CanvasNodeId("n1".into())).id();
        let label = app
            .world_mut()
            .spawn((
                Text2d::new("Hello Canvas"),
                TextFont {
                    font: font.clone().into(),
                    font_size: FontSize::Px(16.0),
                    ..default()
                },
                TextColor(Color::WHITE),
                TextLayout::new(Justify::Left, LineBreak::NoWrap),
                TextBounds::UNBOUNDED,
                Anchor::TOP_LEFT,
                Transform::from_xyz(100.0, -50.0, 10.12),
                LogicalText::world(16.0, None),
                CanvasLabel {
                    role: CanvasLabelRole::Card,
                    slot: 0,
                },
                ChildOf(owner),
            ))
            .id();

        app.update();

        assert!(app.world().get::<BatchedCanvasLabel>(label).is_some());
        assert!(app.world().get::<NoCpuCulling>(label).is_some());
        assert!(app.world().get::<TextLayoutInfo>(label).is_none());
        assert!(app.world().get::<VisibilityClass>(label).is_none());
        assert!(app.world().get::<GlobalTransform>(label).is_none());
        assert_eq!(
            app.world().resource::<TextBatchCache>().chunk_mesh_count(),
            1
        );

        let chunk_entity = app
            .world_mut()
            .query_filtered::<Entity, With<TextBatchChunkMesh>>()
            .single(app.world())
            .expect("single chunk mesh entity");
        let mesh_handle = app.world().get::<Mesh2d>(chunk_entity).unwrap().0.clone();
        let mesh = app
            .world()
            .resource::<Assets<Mesh>>()
            .get(&mesh_handle)
            .unwrap();
        assert!(mesh.count_vertices() >= 4 * "HelloCanvas".len());

        // Non-card/edge roles (e.g. NodeAction) remain standard Text2d entities.
        let action_label = app
            .world_mut()
            .spawn((
                Text2d::new("Action"),
                TextFont {
                    font: font.into(),
                    font_size: FontSize::Px(12.0),
                    ..default()
                },
                TextColor(Color::WHITE),
                TextLayout::new(Justify::Left, LineBreak::NoWrap),
                TextBounds::UNBOUNDED,
                Anchor::TOP_LEFT,
                Transform::from_xyz(0.0, 0.0, 50.0),
                LogicalText::screen(12.0),
                CanvasLabel {
                    role: CanvasLabelRole::NodeAction,
                    slot: 0,
                },
                ChildOf(owner),
            ))
            .id();

        app.update();
        assert!(
            app.world()
                .get::<BatchedCanvasLabel>(action_label)
                .is_none()
        );
        assert!(app.world().get::<TextLayoutInfo>(action_label).is_some());
    }

    #[test]
    fn pure_pan_frame_skips_label_scan_and_keeps_chunks() {
        use crate::app::FrameFlags;

        let mut app = test_app();
        let font = app.world().resource::<CanvasOverlayCache>().font();
        let owner = app.world_mut().spawn(CanvasNodeId("n1".into())).id();
        let label = app
            .world_mut()
            .spawn((
                Text2d::new("Pan"),
                TextFont {
                    font: font.into(),
                    font_size: FontSize::Px(16.0),
                    ..default()
                },
                TextColor(Color::WHITE),
                TextLayout::new(Justify::Left, LineBreak::NoWrap),
                TextBounds::UNBOUNDED,
                Anchor::TOP_LEFT,
                Transform::from_xyz(10.0, -10.0, 1.0),
                LogicalText::world(16.0, None),
                CanvasLabel {
                    role: CanvasLabelRole::Card,
                    slot: 0,
                },
                ChildOf(owner),
            ))
            .id();

        // 首帧：完整重建并烘焙出保留块。
        app.update();
        assert!(app.world().get::<BatchedCanvasLabel>(label).is_some());
        let chunk_entity = app
            .world_mut()
            .query_filtered::<Entity, With<TextBatchChunkMesh>>()
            .single(app.world())
            .unwrap();
        let mesh_handle = app.world().get::<Mesh2d>(chunk_entity).unwrap().0.clone();
        let zoom_bits = app.world().resource::<TextBatchCache>().last_zoom_bits;
        let rebuilds = app.world().resource::<TextBatchCache>().full_rebuilds;
        assert_ne!(zoom_bits, 0, "首帧必须写入 zoom 基准");

        // 纯平移帧：只有相机 x/y 变化，文字块 Mesh 与 chunk 实体都不应被重建。
        app.init_resource::<FrameFlags>();
        for _ in 0..4 {
            app.update();
        }
        let cache = app.world().resource::<TextBatchCache>();
        assert_eq!(cache.last_zoom_bits, zoom_bits);
        assert_eq!(cache.chunk_mesh_count(), 1);
        assert_eq!(
            cache.full_rebuilds, rebuilds,
            "纯平移帧不得进入标签扫描（24,000 实体遍历）"
        );
        assert_eq!(
            app.world().get::<Mesh2d>(chunk_entity).unwrap().0,
            mesh_handle,
            "纯平移不得替换文字块 mesh 句柄"
        );

        // 对照：zoom 变化必须重新进入完整流程，否则早退会把缩放吞掉。
        app.world_mut()
            .resource_mut::<CurrentScene>()
            .0
            .viewport
            .zoom = 2.0;
        app.update();
        assert!(
            app.world().resource::<TextBatchCache>().full_rebuilds > rebuilds,
            "zoom 变化必须走完整重建"
        );
        assert_ne!(
            app.world().resource::<TextBatchCache>().last_zoom_bits,
            zoom_bits
        );
    }
}
