//! Opt-in evidence from main-world bindings, prepared draw batches and GPU texture bytes.
//! A prepared batch is not proof of presentation; readback proves texture contents only.
use crate::canvas_ecs::components::CanvasTextureSprite;
use bevy::{
    core_pipeline::core_2d::Transparent2d,
    prelude::*,
    render::{
        Extract, ExtractSchedule, Render, RenderApp, RenderSystems,
        gpu_readback::{ReadbackComplete, ReadbackOnce},
        render_asset::RenderAssets,
        render_phase::ViewSortedRenderPhases,
        render_resource::{PipelineCache, TextureUsages},
        texture::GpuImage,
        view::screenshot::{Screenshot, ScreenshotCaptured},
    },
    sprite_render::{ExtractedSprites, SpriteBatches},
};
use serde_json::{Value, json};

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = sessionStorage, js_name = getItem, catch)]
    fn session_item(key: &str) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace = console, js_name = info, catch)]
    fn console_info(prefix: &str, payload: &str) -> Result<(), JsValue>;
}
pub(crate) fn enabled() -> bool {
    #[cfg(feature = "wasm")]
    {
        session_item("woohaaVideoDebug")
            .ok()
            .and_then(|v| v.as_string())
            .as_deref()
            == Some("1")
    }
    #[cfg(not(feature = "wasm"))]
    {
        false
    }
}
pub(super) fn log(mut value: Value) {
    #[cfg(feature = "wasm")]
    {
        // Keep diagnostics in the existing top-level export buffer; no generated JS snippets.
        value["rendererProbe"] = json!("gpu-texture-v1");
        value["at"] = json!(String::from(js_sys::Date::new_0().to_iso_string()));
        let payload = value.to_string();
        let _ = (|| -> Result<(), JsValue> {
            let entry = js_sys::JSON::parse(&payload)?;
            let global = js_sys::global();
            let parent = js_sys::Reflect::get(&global, &"parent".into())?;
            let key = JsValue::from_str("__woohaaVideoPlaybackLog");
            let host = if js_sys::Reflect::get(&parent, &key).is_ok() {
                parent
            } else {
                global.into()
            };
            let existing = js_sys::Reflect::get(&host, &key)?;
            let entries = if js_sys::Array::is_array(&existing) {
                js_sys::Array::from(&existing)
            } else {
                js_sys::Array::new()
            };
            entries.push(&entry);
            while entries.length() > 200 {
                entries.shift();
            }
            js_sys::Reflect::set(&host, &key, &entries)?;
            Ok(())
        })();
        let _ = console_info("[DEBUG-video-playback]", &payload);
    }
    #[cfg(not(feature = "wasm"))]
    let _ = &mut value;
}

// Same 32-byte sample as frontend raster logs, with GPU row padding removed.
fn sample(bytes: &[u8], width: usize, height: usize, stride: usize) -> Option<u32> {
    let row = width.checked_mul(4)?;
    let size = row.checked_mul(height)?;
    if size == 0 || stride < row {
        return None;
    }
    let mut hash = 0u32;
    for i in 0..32 {
        let offset = i * size / 32;
        hash = hash
            .wrapping_mul(31)
            .wrapping_add(*bytes.get(offset / row * stride + offset % row)? as u32);
    }
    Some(hash)
}
// Sparse 32x32 RGBA grid of the final Bevy canvas, not the DOM controls.
fn screen_sample(bytes: &[u8], width: usize, height: usize) -> Option<u32> {
    region_sample(bytes, width, height, [0.0, 0.0, 1.0, 1.0])
}
fn region_sample(bytes: &[u8], width: usize, height: usize, rect: [f32; 4]) -> Option<u32> {
    if width == 0 || height == 0 {
        return None;
    }
    if !rect.iter().all(|v| v.is_finite()) || rect[2] <= rect[0] || rect[3] <= rect[1] {
        return None;
    }
    let mut hash = 0u32;
    for y in 0..32 {
        for x in 0..32 {
            let px =
                ((rect[0] + (rect[2] - rect[0]) * (x as f32 + 0.5) / 32.0) * width as f32) as usize;
            let py = ((rect[1] + (rect[3] - rect[1]) * (y as f32 + 0.5) / 32.0) * height as f32)
                as usize;
            let offset = (py.min(height - 1) * width + px.min(width - 1)) * 4;
            for channel in 0..4 {
                hash = hash
                    .wrapping_mul(31)
                    .wrapping_add(*bytes.get(offset + channel)? as u32);
            }
        }
    }
    Some(hash)
}
#[derive(Resource, Default, Clone)]
pub(super) struct Snapshot {
    pub(super) serial: u64,
    pub(super) rows: Vec<(Entity, Value)>,
}
#[derive(Component)]
struct Pending(crate::clock::Instant);
pub(crate) struct VideoDiagnosticsPlugin;
impl Plugin for VideoDiagnosticsPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Snapshot>().add_systems(Last, capture);
        if let Some(render) = app.get_sub_app_mut(RenderApp) {
            super::video_draw_diagnostics::install(render);
            render
                .init_resource::<Snapshot>()
                .add_systems(ExtractSchedule, extract)
                .add_systems(
                    Render,
                    prepared
                        .after(RenderSystems::Render)
                        .before(RenderSystems::Cleanup),
                );
        }
    }
}
fn capture(
    mut commands: Commands,
    scene: Res<crate::app::CurrentScene>,
    images: Res<Assets<Image>>,
    cameras: Query<(&Camera, &GlobalTransform), With<super::MainCanvasCamera>>,
    sprites: Query<(
        Entity,
        &CanvasTextureSprite,
        &Sprite,
        &GlobalTransform,
        &ViewVisibility,
        &Visibility,
    )>,
    pending: Query<(Entity, &Pending)>,
    mut snapshot: ResMut<Snapshot>,
    mut last: Local<Option<crate::clock::Instant>>,
) {
    for (entity, at) in &pending {
        if at.0.elapsed().as_secs() >= 10 {
            log(json!({"stage":"gpu-readback-timeout", "probeEntity":format!("{entity:?}")}));
            commands.entity(entity).despawn();
        }
    }
    snapshot.rows.clear();
    if !enabled() {
        return;
    }
    if last.is_some_and(|at| at.elapsed().as_secs_f32() < 1.0) {
        return;
    }
    *last = Some(crate::clock::Instant::now());
    let Some(focus) = &scene.0.video_focus else {
        return;
    };
    snapshot.serial += 1;
    let mut readback_started = !pending.is_empty();
    let mut screenshot_started = !pending.is_empty();
    for (entity, owner, sprite, transform, view_visibility, visibility) in &sprites {
        if owner.node_id != focus.node_id {
            continue;
        }
        let image = images.get(&sprite.image);
        let cpu_sample = image.and_then(|im| {
            sample(
                im.data.as_deref()?,
                im.width() as usize,
                im.height() as usize,
                im.width() as usize * 4,
            )
        });
        let screen_rect = cameras.iter().find_map(|(camera, camera_transform)| {
            let size = sprite.custom_size? * 0.5;
            let target = camera.logical_target_size()?;
            let a = camera
                .world_to_viewport(
                    camera_transform,
                    transform.transform_point(Vec3::new(-size.x, -size.y, 0.0)),
                )
                .ok()?
                / target;
            let b = camera
                .world_to_viewport(
                    camera_transform,
                    transform.transform_point(Vec3::new(size.x, size.y, 0.0)),
                )
                .ok()?
                / target;
            let min = a.min(b).clamp(Vec2::ZERO, Vec2::ONE);
            let max = a.max(b).clamp(Vec2::ZERO, Vec2::ONE);
            Some([min.x, min.y, max.x, max.y])
        });
        let row = json!({"stage":"sprite-binding", "probe":snapshot.serial,
            "nodeId":owner.node_id, "contentId":owner.content_id,
            "entity":format!("{entity:?}"), "image":format!("{:?}",sprite.image.id()),
            "cpuSample":cpu_sample, "assetExists":image.is_some(), "screenRect":screen_rect,
            "visibility":format!("{visibility:?}"), "viewVisible":view_visibility.get(),
            "translation":transform.translation().to_array(), "alpha":sprite.color.alpha(),
            "customSize":sprite.custom_size.map(|v|v.to_array())});
        log(row.clone());
        snapshot.rows.push((entity, row.clone()));
        if !screenshot_started {
            screenshot_started = true;
            let screen_row = row.clone();
            commands
                .spawn((
                    Screenshot::primary_window(),
                    Pending(crate::clock::Instant::now()),
                ))
                .observe(move |event: On<ScreenshotCaptured>| {
                    let mut row = screen_row.clone();
                    row["stage"] = json!("gpu-canvas-readback");
                    let im = &event.image;
                    row["width"] = json!(im.width());
                    row["height"] = json!(im.height());
                    row["format"] = json!(format!("{:?}", im.texture_descriptor.format));
                    row["screenSample"] = json!(im.data.as_deref().and_then(|b| screen_sample(
                        b,
                        im.width() as usize,
                        im.height() as usize
                    )));
                    row["focusScreenSample"] =
                        json!(
                            screen_rect.and_then(|rect| im.data.as_deref().and_then(|b| {
                                region_sample(b, im.width() as usize, im.height() as usize, rect)
                            }))
                        );
                    log(row);
                });
        }
        if !readback_started && let Some(image) = image {
            if !image
                .texture_descriptor
                .usage
                .contains(TextureUsages::COPY_SRC)
            {
                log(
                    json!({"stage":"gpu-readback-unavailable", "nodeId":owner.node_id,"reason":"image missing COPY_SRC"}),
                );
                continue;
            }
            let (w, h) = (image.width() as usize, image.height() as usize);
            if w.saturating_mul(h).saturating_mul(4) > 16 * 1024 * 1024 {
                log(
                    json!({"stage":"gpu-readback-unavailable", "nodeId":owner.node_id,"reason":"texture exceeds 16MiB diagnostic limit"}),
                );
                continue;
            }
            readback_started = true;
            commands
                .spawn((
                    ReadbackOnce::texture(sprite.image.clone()),
                    Pending(crate::clock::Instant::now()),
                ))
                .observe(move |event: On<ReadbackComplete>, mut commands: Commands| {
                    let mut row = row.clone();
                    row["stage"] = json!("gpu-texture-readback");
                    let stride = (w * 4).div_ceil(256) * 256;
                    let actual = sample(&event.data, w, h, stride);
                    row["gpuSample"] = json!(actual);
                    row["matchesCpu"] = json!(actual.zip(cpu_sample).map(|(a, b)| a == b));
                    row["readbackBytes"] = json!(event.data.len());
                    log(row);
                    commands.entity(event.entity).despawn();
                });
        }
    }
    if snapshot.rows.is_empty() {
        log(
            json!({"stage":"sprite-binding-missing", "nodeId":focus.node_id,"probe":snapshot.serial}),
        );
    }
}
fn extract(mut commands: Commands, snapshot: Extract<Res<Snapshot>>) {
    commands.insert_resource(snapshot.clone());
}
fn prepared(
    snapshot: Res<Snapshot>,
    extracted: Res<ExtractedSprites>,
    gpu: Res<RenderAssets<GpuImage>>,
    phases: Res<ViewSortedRenderPhases<Transparent2d>>,
    batches: Res<SpriteBatches>,
    pipelines: Res<PipelineCache>,
    mut last: Local<u64>,
) {
    if snapshot.rows.is_empty() || snapshot.serial == *last {
        return;
    }
    *last = snapshot.serial;
    let batches = &*batches;
    let pipelines = &*pipelines;
    for (entity, row) in &snapshot.rows {
        let mut row = row.clone();
        row["stage"] = json!("gpu-draw-prepared");
        let extracted_rows: Vec<_> = extracted.sprites.iter().filter(|s| s.main_entity == *entity).map(|s| {
            let image = gpu.get(s.image_handle_id);
            let draws: Vec<_> = phases.iter().flat_map(|(view,phase)| phase.items.values().filter(move |i| i.entity.0 == s.render_entity).map(move |i| json!({
                "view":format!("{view:?}"),"batchRange":format!("{:?}",i.batch_range),
                "batch":batches.get(&(*view,i.entity.0)).map(|b|format!("{b:?}")),
                "pipeline":format!("{:?}",i.pipeline),"pipelineReady":pipelines.get_render_pipeline(i.pipeline).is_some(),"z":i.sort_key.0
            }))).collect();
            json!({"image":format!("{:?}",s.image_handle_id),"gpuReady":image.is_some(),
                "texture":image.map(|im|format!("{:?}",im.texture.id())),
                "textureView":image.map(|im|format!("{:?}",im.texture_view.id())),
                "draws":draws})
        }).collect();
        row["extractedSprites"] = json!(extracted_rows);
        log(row);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canvas_sample_detects_changed_pixels_and_rejects_incomplete_data() {
        let a = vec![0; 32 * 32 * 4];
        let mut b = a.clone();
        b[(16 * 32 + 16) * 4] = 128;
        assert_ne!(screen_sample(&a, 32, 32), screen_sample(&b, 32, 32));
        assert_eq!(screen_sample(&[], 32, 32), None);
        assert_eq!(screen_sample(&[], 0, 0), None);
        assert_eq!(
            region_sample(&b, 32, 32, [0.0, 0.0, 0.25, 0.25]),
            region_sample(&a, 32, 32, [0.0, 0.0, 0.25, 0.25])
        );
        assert_eq!(region_sample(&b, 32, 32, [0.0, 0.0, 0.0, 0.0]), None);
    }
    #[test]
    fn gpu_row_padding_matches_raster_sample_and_detects_changed_pixels() {
        let pixels: Vec<u8> = (0..24).collect();
        let mut padded = vec![255; 512];
        padded[..12].copy_from_slice(&pixels[..12]);
        padded[256..268].copy_from_slice(&pixels[12..]);
        assert_eq!(sample(&pixels, 3, 2, 12), sample(&padded, 3, 2, 256));
        padded[256] ^= 1;
        assert_ne!(sample(&pixels, 3, 2, 12), sample(&padded, 3, 2, 256));
        assert_eq!(sample(&[], 3, 2, 256), None);
    }
}
