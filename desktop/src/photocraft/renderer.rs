//! Official PhotoCraft/egui GPU drawing on the injected host device. No surface/device is created.
use bevy::render::render_resource::Texture;
use eframe::{egui_wgpu, wgpu};
use std::sync::Arc;
use woohaa_desktop_host::document_editor::{EditorError, ErrorCode, GpuContext};

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
struct Targets {
    size: [u32; 2],
    document_size: [u32; 2],
    full: wgpu::Texture,
    ui: wgpu::Texture,
    document: wgpu::Texture,
}
pub struct NativeRenderer {
    pub context: egui::Context,
    state: egui_wgpu::RenderState,
    slots: [Option<Targets>; 2],
    next: usize,
    generation: u64,
    budget: u64,
    clipboard_sequence: u64,
    copied_text: Option<String>,
    font_status: &'static str,
    document_requests: Vec<serde_json::Value>,
    request_sequence: u64,
    preparation_frame: u64,
    preparation_reports: u32,
    ready_document: Option<String>,
}
pub struct NativeFrame {
    pub ui: Texture,
    pub document: Texture,
    pub rect: [f64; 4],
    pub snapshot: serde_json::Value,
    pub jobs: Vec<photocraft_engine::jobs::JobEvent>,
}
impl NativeRenderer {
    pub fn new(
        gpu: &GpuContext,
        app: &mut photocraft_ui_egui::PhotocraftApp,
    ) -> Result<Self, EditorError> {
        let initialization_started = std::time::Instant::now();
        let device = gpu.device.wgpu_device().clone();
        let queue = (*gpu.queue).clone();
        let renderer = egui_wgpu::Renderer::new(
            &device,
            FORMAT,
            egui_wgpu::RendererOptions {
                msaa_samples: 1,
                ..Default::default()
            },
        );
        bevy::log::info!(target: "photocraft_preparation", stage="renderer_create", elapsed_ms=initialization_started.elapsed().as_secs_f64()*1000.);
        let canvas_started = std::time::Instant::now();
        let state = egui_wgpu::RenderState {
            adapter: (*gpu.adapter).clone(),
            available_adapters: vec![(*gpu.adapter).clone()],
            instance: (*gpu.instance).clone(),
            device,
            queue,
            target_format: FORMAT,
            renderer: Arc::new(egui::epaint::mutex::RwLock::new(renderer)),
            surface_config: egui_wgpu::SurfaceConfig::LOW_LATENCY,
        };
        photocraft_ui_egui::overlay::set_capture_clean(true);
        photocraft_ui_egui::overlay::set_hosted(true);
        photocraft_ui_egui::overlay::set_presentation(true, true);
        app.set_wgpu(state.clone());
        if app.gpu_health().is_none() {
            return Err(EditorError::new(
                ErrorCode::Unavailable,
                "Native GPU canvas unavailable before document admission",
            ));
        }
        bevy::log::info!(target: "photocraft_preparation", stage="gpu_canvas_initialize", elapsed_ms=canvas_started.elapsed().as_secs_f64()*1000.);
        let bootstrap_started = std::time::Instant::now();
        // Delivered-font installation inspects the current font definitions.
        // egui initializes those only in run_ui, before the first real App frame.
        // Bootstrap that context and consume its texture delta through the same
        // GPU renderer so the initial font atlas is neither lost nor leaked.
        let context = egui::Context::default();
        let mut bootstrap = context.run_ui(egui::RawInput::default(), |_| {});
        {
            let mut renderer = state.renderer.write();
            for (id, changes) in &bootstrap.textures_delta.set {
                for delta in changes {
                    renderer.update_texture(&state.device, &state.queue, *id, delta);
                }
            }
            for id in &bootstrap.textures_delta.free {
                renderer.free_texture(id);
            }
        }
        bootstrap.textures_delta.clear();
        bevy::log::info!(target: "photocraft_preparation", stage="font_context_bootstrap", elapsed_ms=bootstrap_started.elapsed().as_secs_f64()*1000.);
        Ok(Self {
            context,
            state,
            slots: [None, None],
            next: 0,
            generation: gpu.device_generation,
            budget: gpu.budget_bytes,
            clipboard_sequence: 0,
            copied_text: None,
            font_status: "not-loaded",
            document_requests: Vec::new(),
            request_sequence: 0,
            preparation_frame: 0,
            preparation_reports: 0,
            ready_document: None,
        })
    }
    pub fn install_fonts(
        &mut self,
        app: &mut photocraft_ui_egui::PhotocraftApp,
        assets: &dyn woohaa_desktop_host::document_editor::RuntimeAssetResolver,
    ) {
        let fonts_started = std::time::Instant::now();
        use sha2::{Digest, Sha256};
        let manifest = include_str!("font-manifest.txt");
        let (fonts, _) = photocraft_ui_egui::served_fonts::parse_manifest(manifest);
        photocraft_ui_egui::served_fonts::add_fonts(&fonts);
        let mut delivered = Vec::new();
        for font in fonts {
            let expected = manifest
                .lines()
                .filter(|line| !line.trim().starts_with('#'))
                .find_map(|line| {
                    let columns: Vec<_> = line.split('|').map(str::trim).collect();
                    if columns.len() > 6 && columns[2] == font.file {
                        Some(columns[6])
                    } else {
                        None
                    }
                });
            if let Ok(bytes) = assets.resolve(&font.file, 32 * 1024 * 1024) {
                let hash = format!("{:x}", Sha256::digest(&bytes));
                if expected.is_some_and(|expected| expected == hash) {
                    delivered.push((font.family, bytes));
                }
            }
        }
        self.font_status = if delivered.is_empty() {
            "unavailable"
        } else {
            "available"
        };
        bevy::log::info!(target: "photocraft_preparation", stage="font_assets_read_verify", elapsed_ms=fonts_started.elapsed().as_secs_f64()*1000., fonts=delivered.len());
        let font_ui_started = std::time::Instant::now();
        photocraft_ui_egui::served_fonts::install_ui_delivered(&self.context, &delivered);
        bevy::log::info!(target: "photocraft_preparation", stage="font_install_ui", elapsed_ms=font_ui_started.elapsed().as_secs_f64()*1000.);
        let font_document_started = std::time::Instant::now();
        photocraft_ui_egui::served_fonts::install(app, delivered);
        bevy::log::info!(target: "photocraft_preparation", stage="font_install_document", elapsed_ms=font_document_started.elapsed().as_secs_f64()*1000.);
    }
    pub fn acknowledge_request_id(&mut self, id: u64) {
        self.document_requests
            .retain(|r| r.get("nativeRequestId").and_then(serde_json::Value::as_u64) != Some(id));
    }
    pub fn acknowledge_document_request(&mut self, id: &str) {
        self.document_requests
            .retain(|r| r.get("id").and_then(serde_json::Value::as_str) != Some(id));
    }
    pub fn restore_compositor(
        &mut self,
        app: &mut photocraft_ui_egui::PhotocraftApp,
    ) -> Result<(), EditorError> {
        if app.window_lost() || app.gpu_health().is_some_and(|health| !health.is_ok()) {
            return Err(EditorError::new(
                ErrorCode::DeviceLost,
                "Window device requires new generation recovery",
            ));
        }
        app.host_restore_gpu_viewport(self.state.clone());
        Ok(())
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn draw(
        &mut self,
        app: &mut photocraft_ui_egui::PhotocraftApp,
        mut input: egui::RawInput,
        size: [u32; 2],
        scale: f32,
    ) -> Result<NativeFrame, EditorError> {
        if app.window_lost() || app.gpu_health().is_some_and(|health| !health.is_ok()) {
            return Err(EditorError::new(
                ErrorCode::DeviceLost,
                "Native presentation paused; document/project export remains available",
            ));
        }
        let frame_started = std::time::Instant::now();
        if size.contains(&0) || !scale.is_finite() || scale <= 0. {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "Invalid native viewport",
            ));
        }
        let max = self.state.device.limits().max_texture_dimension_2d;
        if size.iter().any(|n| *n > max)
            || u64::from(size[0]) * u64::from(size[1]) * 32 > self.budget
        {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "Native UI textures exceed GPU budget",
            ));
        }
        let viewport_reservation = u64::from(size[0]) * u64::from(size[1]) * 32;
        let remaining = self
            .budget
            .saturating_sub(viewport_reservation)
            .saturating_sub(32 * 1024 * 1024);
        if remaining == 0 || !app.host_set_gpu_budget(remaining) {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "Combined viewport/UI/compositor GPU budget exceeded; original document retained",
            ));
        }
        let zoom = self.context.zoom_factor();
        for event in &mut input.events {
            match event {
                egui::Event::PointerMoved(p)
                | egui::Event::PointerButton { pos: p, .. }
                | egui::Event::Touch { pos: p, .. } => {
                    p.x /= zoom;
                    p.y /= zoom;
                }
                egui::Event::MouseWheel { delta, .. } | egui::Event::MouseMoved(delta) => {
                    *delta /= zoom;
                }
                _ => {}
            }
        }
        input.screen_rect = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::vec2(
                size[0] as f32 / (scale * zoom),
                size[1] as f32 / (scale * zoom),
            ),
        ));
        input
            .viewports
            .entry(egui::ViewportId::ROOT)
            .or_default()
            .native_pixels_per_point = Some(scale);
        self.preparation_frame += 1;
        let input_ms = frame_started.elapsed().as_secs_f64() * 1000.;
        let stage_started = std::time::Instant::now();
        app.host_raw_input(&self.context, &mut input);
        let mut jobs = Vec::new();
        let logic = self
            .context
            .run_logic(&input, |ctx| jobs.extend(app.host_logic(ctx)));
        let logic_ms = stage_started.elapsed().as_secs_f64() * 1000.;
        let stage_started = std::time::Instant::now();
        let mut app_ui_ms = 0.;
        let mut output = self.context.run_ui(input, |ui| {
            let started = std::time::Instant::now();
            app.host_ui(ui, None);
            app_ui_ms += started.elapsed().as_secs_f64() * 1000.;
        });
        let ui_ms = stage_started.elapsed().as_secs_f64() * 1000.;
        output.platform_output.append(logic.platform_output);
        let mut snapshot = serde_json::from_str(&photocraft_ui_egui::overlay::state())
            .unwrap_or(serde_json::Value::Null);
        if let Some(ime) = &output.platform_output.ime {
            snapshot["ime"] = serde_json::json!({"enabled":true,"cursor_rect":[ime.cursor_rect.min.x * output.pixels_per_point / scale,ime.cursor_rect.min.y * output.pixels_per_point / scale,ime.cursor_rect.width() * output.pixels_per_point / scale,ime.cursor_rect.height() * output.pixels_per_point / scale]});
        } else {
            snapshot["ime"] = serde_json::json!({"enabled":false});
        }
        for command in &output.platform_output.commands {
            if let egui::OutputCommand::CopyText(text) = command {
                if let Err(error) = woohaa_desktop_host::platform_clipboard::write_text(text) {
                    snapshot["clipboardError"] = serde_json::json!(error);
                }
                self.clipboard_sequence += 1;
                self.copied_text = Some(text.clone());
            }
        }
        if let Some(text) = &self.copied_text {
            snapshot["copied_text"] = serde_json::json!(text);
            snapshot["clipboard_sequence"] = serde_json::json!(self.clipboard_sequence);
        }
        snapshot["renderPath"] = serde_json::json!(if app.perf.gpu_fallback.is_some() {
            "native-cpu-viewport"
        } else {
            "shared-gpu"
        });
        snapshot["fontStatus"] = serde_json::json!(self.font_status);
        let requests: Vec<serde_json::Value> =
            serde_json::from_str(&photocraft_ui_egui::overlay::take_requests()).unwrap_or_default();
        for mut request in requests {
            if !self
                .document_requests
                .iter()
                .any(|r| r["id"] == request["id"] && r["kind"] == request["kind"])
            {
                self.request_sequence += 1;
                request["nativeRequestId"] = serde_json::json!(self.request_sequence);
                self.document_requests.push(request);
            }
        }
        snapshot["documentRequests"] = serde_json::json!(&self.document_requests);
        let rect = photocraft_ui_egui::overlay::last_rect().unwrap_or([
            0.,
            0.,
            size[0] as f32 / scale,
            size[1] as f32 / scale,
        ]);
        let x = (rect[0] * output.pixels_per_point).floor().max(0.) as u32;
        let y = (rect[1] * output.pixels_per_point).floor().max(0.) as u32;
        let x = x.min(size[0] - 1);
        let y = y.min(size[1] - 1);
        let w = (rect[2] * output.pixels_per_point).ceil().max(1.) as u32;
        let h = (rect[3] * output.pixels_per_point).ceil().max(1.) as u32;
        let document_size = [w.min(size[0] - x), h.min(size[1] - y)];
        let targets_started = std::time::Instant::now();
        let slot = &mut self.slots[self.next];
        self.next = (self.next + 1) % 2;
        let targets_changed = slot
            .as_ref()
            .is_none_or(|t| t.size != size || t.document_size != document_size);
        if targets_changed {
            let texture = |label, dim: [u32; 2]| {
                self.state.device.create_texture(&wgpu::TextureDescriptor {
                    label: Some(label),
                    size: wgpu::Extent3d {
                        width: dim[0],
                        height: dim[1],
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: FORMAT,
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                        | wgpu::TextureUsages::TEXTURE_BINDING
                        | wgpu::TextureUsages::COPY_SRC
                        | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb],
                })
            };
            *slot = Some(Targets {
                size,
                document_size,
                full: texture("photocraft-official-frame", size),
                ui: texture("photocraft-ui", size),
                document: texture("photocraft-document", document_size),
            });
        }
        let t = slot.as_ref().unwrap();
        let targets_ms = targets_started.elapsed().as_secs_f64() * 1000.;
        let lock_started = std::time::Instant::now();
        let mut renderer = self.state.renderer.write();
        let renderer_lock_ms = lock_started.elapsed().as_secs_f64() * 1000.;
        let upload_started = std::time::Instant::now();
        for (id, delta) in &output.textures_delta.set {
            for change in delta {
                renderer.update_texture(&self.state.device, &self.state.queue, *id, change);
            }
        }
        let texture_upload_ms = upload_started.elapsed().as_secs_f64() * 1000.;
        let tessellate_started = std::time::Instant::now();
        let primitives = self
            .context
            .tessellate(output.shapes, output.pixels_per_point);
        let tessellate_ms = tessellate_started.elapsed().as_secs_f64() * 1000.;
        let screen = egui_wgpu::ScreenDescriptor {
            size_in_pixels: size,
            pixels_per_point: output.pixels_per_point,
        };
        let encode_started = std::time::Instant::now();
        let mut encoder =
            self.state
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("photocraft-native-frame"),
                });
        let mut callbacks = renderer.update_buffers(
            &self.state.device,
            &self.state.queue,
            &mut encoder,
            &primitives,
            &screen,
        );
        let buffers_ms = encode_started.elapsed().as_secs_f64() * 1000.;
        let paint_started = std::time::Instant::now();
        // A main document canvas callback covers the exact reported viewport. Egui meshes
        // (scrollbars, selections, modal backdrops, cursors) remain in the UI target.
        let viewport =
            egui::Rect::from_min_size(egui::pos2(rect[0], rect[1]), egui::vec2(rect[2], rect[3]));
        let is_document = |p: &egui::epaint::ClippedPrimitive| match &p.primitive {
            egui::epaint::Primitive::Callback(callback) => {
                (callback.rect.min - viewport.min).length() < 0.1
                    && (callback.rect.max - viewport.max).length() < 0.1
            }
            _ => false,
        };
        let document_primitives: Vec<_> = primitives
            .iter()
            .filter(|p| is_document(p))
            .cloned()
            .collect();
        let ui_primitives: Vec<_> = primitives
            .iter()
            .filter(|p| !is_document(p))
            .cloned()
            .collect();
        let mut paint =
            |target: &wgpu::Texture, paint_jobs: &[egui::epaint::ClippedPrimitive], label| {
                let view = target.create_view(&Default::default());
                let pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some(label),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                    multiview_mask: None,
                });
                renderer.render(&mut pass.forget_lifetime(), paint_jobs, &screen);
            };
        paint(&t.full, &document_primitives, "photocraft-clean-document");
        paint(&t.ui, &ui_primitives, "photocraft-official-ui");
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &t.full,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            t.document.as_image_copy(),
            wgpu::Extent3d {
                width: document_size[0],
                height: document_size[1],
                depth_or_array_layers: 1,
            },
        );
        callbacks.push(encoder.finish());
        let paint_ms = paint_started.elapsed().as_secs_f64() * 1000.;
        let encode_ms = encode_started.elapsed().as_secs_f64() * 1000.;
        let submit_started = std::time::Instant::now();
        self.state.queue.submit(callbacks);
        let submit_ms = submit_started.elapsed().as_secs_f64() * 1000.;
        snapshot["metrics"] = serde_json::json!({"provider_frame_cpu_wall_ms":frame_started.elapsed().as_secs_f64()*1000.,"gpu_command_encode_cpu_ms":encode_ms,"gpu_queue_submit_cpu_ms":submit_ms});
        snapshot["preparationFrame"] = serde_json::json!(self.preparation_frame);
        // Keep detailed evidence bounded: first frames, target allocation/resize,
        // and exceptional frames only. These are CPU call durations, not GPU time.
        let current_document = app.session.active().map(|d| d.doc.id.0.to_string());
        let newly_ready = snapshot["documentId"].as_str() == current_document.as_deref()
            && snapshot["viewReady"] == true
            && snapshot["documentId"].as_str().is_some()
            && snapshot["documentId"].as_str() != self.ready_document.as_deref();
        if newly_ready {
            self.ready_document = snapshot["documentId"].as_str().map(str::to_owned);
        }
        if self.preparation_reports < 32
            && (self.preparation_frame <= 3
                || targets_changed
                || newly_ready
                || frame_started.elapsed().as_millis() >= 50)
        {
            self.preparation_reports += 1;
            let phases = serde_json::json!({"frame":self.preparation_frame,"input_ms":input_ms,"logic_ms":logic_ms,"ui_ms":ui_ms,"app_ui_ms":app_ui_ms,"egui_overhead_ms":(ui_ms-app_ui_ms).max(0.),"targets_ms":targets_ms,"renderer_lock_ms":renderer_lock_ms,"texture_upload_ms":texture_upload_ms,"tessellate_ms":tessellate_ms,"buffers_ms":buffers_ms,"paint_ms":paint_ms,"submit_ms":submit_ms,"targets_changed":targets_changed,"first_ready":newly_ready,"view_ready":snapshot["viewReady"],"texture_delta_count":output.textures_delta.set.len(),"physical_size":size,"document_size":document_size,"total_ms":frame_started.elapsed().as_secs_f64()*1000.});
            bevy::log::info!(target: "photocraft_preparation", "frame_cpu_phases {}", phases);
            snapshot["preparation"] = phases;
            if self.preparation_reports == 32 {
                bevy::log::info!(target: "photocraft_preparation", "detail limit reached (32 reports per renderer); continuous aggregate timings remain enabled");
            }
        }
        for id in &output.textures_delta.free {
            renderer.free_texture(id);
        }
        output.textures_delta.clear();
        Ok(NativeFrame {
            ui: Texture::from(t.ui.clone()),
            document: Texture::from(t.document.clone()),
            rect: [
                x as f64 / scale as f64,
                y as f64 / scale as f64,
                document_size[0] as f64 / scale as f64,
                document_size[1] as f64 / scale as f64,
            ],
            snapshot,
            jobs,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wait<F: std::future::Future>(future: F) -> F::Output {
        struct Wake(std::thread::Thread);
        impl std::task::Wake for Wake {
            fn wake(self: Arc<Self>) {
                self.0.unpark();
            }
        }
        let waker = std::task::Waker::from(Arc::new(Wake(std::thread::current())));
        let mut cx = std::task::Context::from_waker(&waker);
        let mut f = std::pin::pin!(future);
        loop {
            match f.as_mut().poll(&mut cx) {
                std::task::Poll::Ready(r) => return r,
                std::task::Poll::Pending => std::thread::park(),
            }
        }
    }
    fn read(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture) -> Vec<u8> {
        let w = texture.width();
        let h = texture.height();
        let stride = (w * 4).div_ceil(256) * 256;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test-only-readback"),
            size: u64::from(stride) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(stride),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        queue.submit([enc.finish()]);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            tx.send(r).unwrap();
        });
        device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        rx.recv().unwrap().unwrap();
        let mapped = buffer.slice(..).get_mapped_range().unwrap();
        let mut out = Vec::new();
        for row in mapped.chunks(stride as usize) {
            out.extend_from_slice(&row[..w as usize * 4]);
        }
        drop(mapped);
        buffer.unmap();
        out
    }
    #[test]
    #[ignore = "requires real Metal/Vulkan/DX12 GPU; readback is test evidence only"]
    fn official_gpu_ui_document_split_resize_and_alpha() {
        // Exercise the real host feature/limit configuration, not a custom
        // request_device with extra features that the shipping host lacks.
        use bevy::prelude::*;
        let mut host = App::new();
        host.add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: None,
                    exit_condition: bevy::window::ExitCondition::DontExit,
                    ..default()
                })
                .disable::<bevy::render::pipelined_rendering::PipelinedRenderingPlugin>(),
        );
        host.finish();
        host.cleanup();
        let world = host.sub_app(bevy::render::RenderApp).world();
        let adapter = world.resource::<bevy::render::renderer::RenderAdapter>();
        let info = adapter.get_info();
        assert_ne!(
            info.device_type,
            wgpu::DeviceType::Cpu,
            "software GPU cannot establish correctness"
        );
        let device = world
            .resource::<bevy::render::renderer::RenderDevice>()
            .wgpu_device()
            .clone();
        let queue = (**world.resource::<bevy::render::renderer::RenderQueue>()).clone();
        let gpu = GpuContext {
            adapter: adapter.clone(),
            instance: world
                .resource::<bevy::render::renderer::RenderInstance>()
                .clone(),
            device: world
                .resource::<bevy::render::renderer::RenderDevice>()
                .clone(),
            queue: world
                .resource::<bevy::render::renderer::RenderQueue>()
                .clone(),
            device_generation: 1,
            max_texture_dimension_2d: device.limits().max_texture_dimension_2d,
            budget_bytes: 512 * 1024 * 1024,
            color_space: "srgb".into(),
        };
        let mut session = photocraft_engine::Session::new();
        session
            .start("file.new", serde_json::json!({"width":128,"height":96}))
            .unwrap();
        session
            .edit("synthetic pixels", |doc, layer| {
                let bounds = doc.bounds();
                let surf = doc
                    .layer_mut(layer.unwrap())
                    .unwrap()
                    .surface_mut()
                    .unwrap();
                let fmt = surf.format();
                let mut data = Vec::new();
                for y in 0..96 {
                    for x in 0..128 {
                        data.extend(photocraft_raster::from_rgba(
                            &fmt,
                            if x < 64 {
                                [1., 0., 0., 1.]
                            } else {
                                [0., 0., 1., 0.5]
                            },
                        ));
                        let _ = y;
                    }
                }
                surf.write_region(bounds, &data);
                Ok(())
            })
            .unwrap();
        let mut app = photocraft_ui_egui::PhotocraftApp::new(session, Default::default());
        app.background_jobs = true;
        let mut renderer = NativeRenderer::new(&gpu, &mut app).unwrap();
        let mut last = None;
        for size in [[960, 640], [960, 640], [960, 640], [1100, 720], [1100, 720]] {
            let frame = renderer
                .draw(&mut app, egui::RawInput::default(), size, 1.)
                .unwrap();
            last = Some(frame);
        }
        let revision = app.session.active().unwrap().revision;
        let initial = app.session.active().unwrap().doc.clone();
        let point = egui::pos2(375.5, 395.);
        for pressed in [true, false] {
            let mut input = egui::RawInput::default();
            input.events.push(egui::Event::PointerMoved(point));
            input.events.push(egui::Event::PointerButton {
                pos: point,
                button: egui::PointerButton::Primary,
                pressed,
                modifiers: Default::default(),
            });
            last = Some(renderer.draw(&mut app, input, [1100, 720], 1.).unwrap());
        }
        assert!(
            app.session.active().unwrap().revision > revision,
            "official brush input must edit the sole Session"
        );
        assert!(app.session.undo());
        assert_eq!(
            *app.session.active().unwrap().doc,
            *initial,
            "official GPU path must preserve exact undo"
        );
        assert!(app.host_force_cpu_viewport("GPU test injected compositor failure"));
        let owner_before_fallback = app.session.active().unwrap().doc.clone();
        app.session
            .edit("fallback update", |doc, layer| {
                let bounds = doc.bounds();
                let surf = doc
                    .layer_mut(layer.unwrap())
                    .unwrap()
                    .surface_mut()
                    .unwrap();
                let mut data = Vec::new();
                for _ in 0..128 * 96 {
                    data.extend(photocraft_raster::from_rgba(
                        &surf.format(),
                        [0., 1., 0., 1.],
                    ));
                }
                surf.write_region(bounds, &data);
                Ok(())
            })
            .unwrap();
        let before_fallback = app.session.active().unwrap().doc.clone();
        for _ in 0..20 {
            last = Some(
                renderer
                    .draw(&mut app, egui::RawInput::default(), [1100, 720], 1.)
                    .unwrap(),
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(
            *app.session.active().unwrap().doc,
            *before_fallback,
            "worker fallback never replaces document authority"
        );
        let fallback_pixels = read(&device, &queue, &last.as_ref().unwrap().document);
        assert!(
            fallback_pixels
                .chunks_exact(4)
                .any(|p| p[1] > 200 && p[0] < 30 && p[2] < 30),
            "background CPU viewport must publish changed source pixels, not retain stale GPU front"
        );
        assert!(app.session.undo());
        assert_eq!(
            *app.session.active().unwrap().doc,
            *owner_before_fallback,
            "CPU fallback edit remains undoable"
        );
        renderer.restore_compositor(&mut app).unwrap();
        for _ in 0..3 {
            last = Some(
                renderer
                    .draw(&mut app, egui::RawInput::default(), [1100, 720], 1.)
                    .unwrap(),
            );
        }
        assert_eq!(last.as_ref().unwrap().snapshot["renderPath"], "shared-gpu");
        assert_eq!(
            *app.session.active().unwrap().doc,
            *owner_before_fallback,
            "restored GPU uses same owner"
        );
        app.host_release_gpu();
        let mut recovered = gpu.clone();
        recovered.device_generation = 2;
        renderer = NativeRenderer::new(&recovered, &mut app).unwrap();
        for _ in 0..3 {
            last = Some(
                renderer
                    .draw(&mut app, egui::RawInput::default(), [1100, 720], 1.)
                    .unwrap(),
            );
        }
        assert_eq!(
            *app.session.active().unwrap().doc,
            *initial,
            "GPU resource recreation keeps authoritative pixels/history"
        );
        assert_eq!(renderer.generation(), 2);
        let frame = last.unwrap();
        assert!(
            frame.rect[2] > 100. && frame.rect[3] > 100.,
            "official document viewport must be reported"
        );
        let ui = read(&device, &queue, &frame.ui);
        let doc = read(&device, &queue, &frame.document);
        let x = frame.rect[0] as usize + 4;
        let y = frame.rect[1] as usize + 4;
        assert_eq!(ui[(y * 1100 + x) * 4 + 3], 0, "UI cutout is transparent");
        assert!(
            ui.chunks_exact(4).any(|p| p[3] > 0),
            "official toolbar/layers UI must draw"
        );
        assert!(
            doc.chunks_exact(4)
                .any(|p| p[2] > 100 && p[0] < 30 && p[3] > 110 && p[3] < 150),
            "blue source alpha must survive without checkerboard"
        );
        assert!(
            doc.chunks_exact(4)
                .any(|p| p[0] > 200 && p[1] < 80 && p[2] < 80),
            "official red source pixels must appear"
        );
        std::fs::write("/tmp/photocraft-native-ui.rgba", ui).unwrap();
        std::fs::write("/tmp/photocraft-native-document.rgba", doc).unwrap();
        std::fs::write("/tmp/photocraft-native-gpu-evidence.json",serde_json::to_vec_pretty(&serde_json::json!({"adapter":format!("{info:?}"),"uiSize":[1100,720],"documentSize":[frame.document.width(),frame.document.height()],"rect":frame.rect,"snapshot":frame.snapshot})).unwrap()).unwrap();
    }
}
