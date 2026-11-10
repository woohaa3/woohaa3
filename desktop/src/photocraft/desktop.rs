use super::export::{ExportError, ExportFormat};
use super::*;
use photocraft_engine::jobs::JobOutcome;
use std::collections::HashMap;
use woohaa_desktop_host::document_editor::*;

pub struct PhotoCraftFactory;
impl NativeDocumentEditorFactory for PhotoCraftFactory {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            provider_id: "photocraft-native".into(),
            api_major: EDITOR_API_MAJOR,
            api_minor: 0,
            project_protocol: 1,
            browser_protocol: 1,
            formats: vec![
                "image/png".into(),
                "image/jpeg".into(),
                "image/webp".into(),
                "application/x-photocraft".into(),
                "application/vnd.woohaa.photocraft-project".into(),
            ],
            capabilities: if cfg!(all(
                feature = "native-ui",
                any(target_os = "macos", target_os = "windows")
            )) {
                vec![
                    #[cfg(target_os = "macos")]
                    "required-native".into(),
                    "native-ui".into(),
                    "shared-texture".into(),
                    "export".into(),
                    "cpu-session".into(),
                    "background-remove".into(),
                    "background-spot-healing".into(),
                ]
            } else {
                vec!["cpu-session".into()]
            },
            build_identity: option_env!("WOOHAA_PHOTOCRAFT_BUILD_ID")
                .or(option_env!("WOOHAA_DIAGNOSTIC_REVISION"))
                .unwrap_or("unknown")
                .into(),
        }
    }
    fn create(&self, context: EditorCreateContext) -> Result<Box<dyn EditorSession>, EditorError> {
        #[cfg(feature = "native-ui")]
        let mut owner = NativeSession::with_services(super::native_services::native());
        #[cfg(not(feature = "native-ui"))]
        let mut owner = NativeSession::new();
        #[cfg(feature = "native-ui")]
        let renderer = {
            let mut renderer =
                super::renderer::NativeRenderer::new(&context.gpu, &mut owner.engine.app)?;
            renderer.install_fonts(&mut owner.engine.app, context.assets.as_ref());
            owner.job_context = renderer.context.clone();
            Some(renderer)
        };
        Ok(Box::new(DesktopSession {
            owner,
            pending: HashMap::new(),
            exports: HashMap::new(),
            completed: Vec::new(),
            sources: HashMap::new(),
            opening_sources: HashMap::new(),
            job_started: HashMap::new(),
            last_job_elapsed: None,
            exported: std::collections::BTreeSet::new(),
            #[cfg(feature = "native-ui")]
            renderer,
            #[cfg(feature = "native-ui")]
            assets: context.assets.clone(),
        }))
    }
}
struct DesktopSession {
    owner: NativeSession,
    pending: HashMap<u64, (u64, u64, bool)>,
    exports: HashMap<u64, (u64, u64)>,
    completed: Vec<photocraft_engine::jobs::JobEvent>,
    sources: HashMap<u64, (String, Option<String>)>,
    opening_sources: HashMap<u64, (String, Option<String>)>,
    job_started: HashMap<u64, std::time::Instant>,
    last_job_elapsed: Option<(u64, f64)>,
    exported: std::collections::BTreeSet<(u64, u64)>,
    #[cfg(feature = "native-ui")]
    renderer: Option<super::renderer::NativeRenderer>,
    #[cfg(feature = "native-ui")]
    assets: std::sync::Arc<dyn RuntimeAssetResolver>,
}
fn error(e: AdapterError) -> EditorError {
    let code = match e {
        AdapterError::Busy => ErrorCode::Busy,
        AdapterError::BudgetExceeded => ErrorCode::BudgetExceeded,
        AdapterError::StaleRevision => ErrorCode::StaleRevision,
        AdapterError::Unsupported => ErrorCode::Unsupported,
        _ => ErrorCode::InternalError,
    };
    EditorError::new(code, format!("{e:?}"))
}
fn id(s: &str) -> Result<u64, EditorError> {
    s.parse()
        .map_err(|_| EditorError::new(ErrorCode::Unsupported, "Invalid document identity"))
}
impl DesktopSession {
    fn result(&self, opening: bool, document: Option<u64>) -> Result<OperationResult, EditorError> {
        let d = document
            .and_then(|id| {
                self.owner
                    .engine()
                    .documents()
                    .iter()
                    .find(|d| d.doc.id.0 == id)
            })
            .or_else(|| {
                if document.is_none() {
                    self.owner.engine().active()
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                EditorError::new(ErrorCode::InternalError, "Missing completed document")
            })?;
        Ok(if opening {
            OperationResult::Opened {
                document_id: d.doc.id.0.to_string(),
                revision: d.revision,
                source_size: [d.doc.size.width, d.doc.size.height],
            }
        } else {
            OperationResult::Changed {
                revision: d.revision,
            }
        })
    }
}
impl EditorSession for DesktopSession {
    fn execute(
        &mut self,
        request: &ControlRequest,
    ) -> Result<Option<OperationResult>, EditorError> {
        let (started, opening) = match &request.operation {
            ControlOperation::Open {
                source_id,
                node_binding,
                bytes,
                format,
                ..
            } => {
                let filename = match format.as_str() {
                    "image/png" => "native-document.png",
                    "image/jpeg" | "image/jpg" => "native-document.jpg",
                    "image/webp" => "native-document.webp",
                    "application/x-photocraft"
                    | "application/vnd.photocraft.project"
                    | "pcraft" => "native-document.pcraft",
                    _ => {
                        return Err(EditorError::new(
                            ErrorCode::Unsupported,
                            "Unsupported source format",
                        ));
                    }
                };
                let started = self
                    .owner
                    .open(filename, Arc::new(bytes.clone()))
                    .map_err(error)?;
                self.opening_sources.insert(
                    request.request_id,
                    (source_id.clone(), node_binding.clone()),
                );
                (started, true)
            }
            ControlOperation::Command {
                document_id,
                expected_revision,
                command,
                parameters,
            } => {
                if parameters.len() > 64 * 1024 {
                    return Err(EditorError::new(
                        ErrorCode::BudgetExceeded,
                        "Command parameters exceed budget",
                    ));
                }
                let parameters: Value = serde_json::from_slice(parameters).map_err(|_| {
                    EditorError::new(ErrorCode::Unsupported, "Invalid command parameters")
                })?;
                #[cfg(feature = "native-ui")]
                if command == "simulate-renderer-failure" {
                    if !self.owner.engine.app.host_force_cpu_viewport(
                        "Injected compositor failure; asynchronous CPU viewport",
                    ) {
                        return Err(EditorError::new(
                            ErrorCode::Unavailable,
                            "Window GPU unavailable; project export remains available",
                        ));
                    }
                    return Ok(Some(OperationResult::Done));
                }
                #[cfg(feature = "native-ui")]
                if command == "native.restore-gpu-viewport" {
                    let renderer = self.renderer.as_mut().ok_or_else(|| {
                        EditorError::new(
                            ErrorCode::DeviceLost,
                            "A new window GPU generation is required",
                        )
                    })?;
                    renderer.restore_compositor(&mut self.owner.engine.app)?;
                    return Ok(Some(OperationResult::Done));
                }
                #[cfg(feature = "native-ui")]
                if command == "simulate-presentation-failure" {
                    self.device_lost();
                    return Ok(Some(OperationResult::Done));
                }
                if command == "native.ack-document-request" {
                    #[cfg(feature = "native-ui")]
                    if let (Some(renderer), Some(id)) = (
                        &mut self.renderer,
                        parameters.get("nativeRequestId").and_then(Value::as_u64),
                    ) {
                        renderer.acknowledge_request_id(id);
                        return Ok(Some(OperationResult::Done));
                    }
                    return Err(error(AdapterError::Unsupported));
                }
                (
                    self.owner
                        .start_command(id(document_id)?, *expected_revision, command, parameters)
                        .map_err(error)?,
                    false,
                )
            }
            ControlOperation::CancelJob { job_id } => {
                if !if *job_id & (1 << 63) != 0 {
                    self.owner.exports.cancel(*job_id & !(1 << 63))
                } else {
                    self.owner.cancel(JobId(*job_id))
                } {
                    return Err(EditorError::new(ErrorCode::Unsupported, "Unknown job"));
                }
                return Ok(Some(OperationResult::Done));
            }
            ControlOperation::Export {
                document_id,
                expected_revision,
                format,
            } => {
                let doc = id(document_id)?;
                let state = self
                    .owner
                    .engine()
                    .documents()
                    .iter()
                    .find(|d| d.doc.id.0 == doc)
                    .ok_or_else(|| error(AdapterError::UnknownDocument))?;
                if state.revision != *expected_revision {
                    return Err(error(AdapterError::StaleRevision));
                }
                let format = match format.as_str() {
                    "png" | "image/png" => ExportFormat::Png,
                    "pcraft" | "project" => ExportFormat::Project,
                    _ => return Err(error(AdapterError::Unsupported)),
                };
                let job = self
                    .owner
                    .start_export(doc, *expected_revision, format)
                    .map_err(export_error)?;
                self.exports
                    .insert(job, (request.request_id, request.generation));
                return Ok(None);
            }
            ControlOperation::MarkSaved {
                document_id,
                expected_revision,
            } => {
                let document = id(document_id)?;
                if !self.exported.contains(&(document, *expected_revision)) {
                    return Err(EditorError::new(
                        ErrorCode::StaleRevision,
                        "No successful export for this document revision",
                    ));
                }
                self.owner
                    .mark_saved(document, *expected_revision)
                    .map_err(error)?;
                return Ok(Some(OperationResult::Done));
            }
            ControlOperation::Show => {
                self.owner.show(true);
                return Ok(Some(OperationResult::Done));
            }
            ControlOperation::Hide => {
                self.owner.show(false);
                return Ok(Some(OperationResult::Done));
            }
            ControlOperation::Activate { document_id } => {
                #[cfg(feature = "native-ui")]
                if let Some(renderer) = &mut self.renderer {
                    renderer.acknowledge_document_request(document_id);
                }
                self.owner.activate(id(document_id)?).map_err(error)?;
                return Ok(Some(OperationResult::Done));
            }
            ControlOperation::Close {
                document_id,
                expected_revision,
                discard,
            } => {
                #[cfg(feature = "native-ui")]
                if let Some(renderer) = &mut self.renderer {
                    renderer.acknowledge_document_request(document_id);
                }
                self.owner.activate(id(document_id)?).map_err(error)?;
                if self.owner.engine().active().unwrap().revision != *expected_revision {
                    return Err(error(AdapterError::StaleRevision));
                }
                match self.owner.close(id(document_id)?, *discard) {
                    Ok(()) => {
                        let closed = id(document_id)?;
                        self.sources.remove(&closed);
                        self.exported.retain(|(doc, _)| *doc != closed);
                        return Ok(Some(OperationResult::Done));
                    }
                    Err(AdapterError::NeedsSettlement) => {
                        return Ok(Some(OperationResult::NeedsSettlement {
                            document_id: document_id.clone(),
                        }));
                    }
                    Err(e) => return Err(error(e)),
                }
            }
            _ => {
                return Err(EditorError::new(
                    ErrorCode::Unsupported,
                    "Native export/save is not implemented",
                ));
            }
        };
        match started {
            Started::Done(_) => self.result(opening, None).map(Some),
            Started::Job(job) => {
                self.pending
                    .insert(job.0, (request.request_id, request.generation, opening));
                self.job_started.insert(job.0, std::time::Instant::now());
                Ok(None)
            }
        }
    }
    fn poll_completions(&mut self) -> Vec<CompletionReceipt> {
        let mut events = std::mem::take(&mut self.completed);
        events.extend(self.owner.poll());
        let mut receipts = Vec::new();
        for event in events {
            let Some((request_id, generation, opening)) = self.pending.remove(&event.id.0) else {
                continue;
            };
            if let Some(start) = self.job_started.remove(&event.id.0) {
                self.last_job_elapsed = Some((request_id, start.elapsed().as_secs_f64() * 1000.));
                #[cfg(feature = "native-ui")]
                if opening {
                    bevy::log::info!(target: "photocraft_preparation", stage="host_open_job_finished", request_id, elapsed_ms=start.elapsed().as_secs_f64()*1000.);
                }
            }
            let source = self.opening_sources.remove(&request_id);
            let result = match event.outcome {
                JobOutcome::Done(mut value) => {
                    // Host Open has no modal-answer round trip and is deliberately
                    // hidden until its receipt. Apply the Session's configured color
                    // policy to a held import instead of reporting a nonexistent doc.
                    // Ordinary native UI opens still use the official profile prompt.
                    if opening {
                        if let Some(held) = value.get("held").and_then(Value::as_u64) {
                            if let Some((doc, read_only)) = self.owner.engine.take_held_open(held) {
                                self.owner.engine.open_document(doc, None);
                                let admitted = self
                                    .owner
                                    .engine
                                    .active_mut()
                                    .expect("open_document activates the admitted document");
                                admitted.source_read_only = read_only;
                                value["docId"] = serde_json::json!(admitted.doc.id.0);
                            }
                        }
                    }
                    let document = if opening {
                        value.get("docId").and_then(Value::as_u64)
                    } else {
                        event.document.map(|d| d.0)
                    };
                    if opening {
                        if let (Some(document), Some(source)) = (document, source) {
                            self.sources.insert(document, source);
                        }
                    }
                    self.result(opening, document)
                }
                JobOutcome::Cancelled => {
                    Err(EditorError::new(ErrorCode::Cancelled, "Job cancelled"))
                }
                JobOutcome::Failed(message) => {
                    Err(EditorError::new(ErrorCode::InternalError, message))
                }
            };
            receipts.push(CompletionReceipt {
                request_id,
                generation,
                result,
            });
        }
        if let Some(mut export) = self.owner.exports.poll() {
            export.result = bound_export_result(export.result);
            if export.result.is_ok() {
                self.exported.insert((export.document, export.revision));
                while self.exported.len() > 256 {
                    self.exported.pop_first();
                }
            }
            if let Some((request_id, generation)) = self.exports.remove(&export.job_id) {
                receipts.push(CompletionReceipt {
                    request_id,
                    generation,
                    result: export
                        .result
                        .map(|bytes| OperationResult::Exported {
                            bytes,
                            revision: export.revision,
                        })
                        .map_err(export_error),
                });
            }
        }
        receipts
    }
    #[cfg(feature = "native-ui")]
    fn render_frame(
        &mut self,
        context: EditorFrameContext,
    ) -> Result<Option<EditorFrame>, EditorError> {
        if !self.owner.visible() {
            return Ok(None);
        }
        let Some(renderer) = self.renderer.as_mut() else {
            return Err(EditorError::new(
                ErrorCode::DeviceLost,
                "GPU resources unavailable",
            ));
        };
        let input = super::native_input::raw(&context);
        let mut frame = renderer.draw(
            &mut self.owner.engine.app,
            input,
            context.physical_size,
            context.scale_factor as f32,
        )?;
        self.completed.extend(frame.jobs);
        if let Some((request, elapsed)) = self.last_job_elapsed {
            frame.snapshot["metrics"]["job_start_to_receipt_ms"] = serde_json::json!(elapsed);
            frame.snapshot["metrics"]["job_request_id"] = serde_json::json!(request);
        }
        let Some(doc) = self.owner.engine().active() else {
            return Ok(None);
        };
        Ok(Some(EditorFrame {
            device_generation: renderer.generation(),
            layout_generation: context.layout_generation,
            document_id: doc.doc.id.0.to_string(),
            document_revision: doc.revision,
            ui_texture: Some(frame.ui),
            document_texture: Some(frame.document),
            document_rect_css: frame.rect,
            snapshot: frame.snapshot,
        }))
    }
    #[cfg(feature = "native-ui")]
    fn cancel_input(&mut self) {
        if let Some(renderer) = &self.renderer {
            self.owner.engine.app.host_cancel_input(&renderer.context);
        }
    }
    #[cfg(feature = "native-ui")]
    fn device_lost(&mut self) {
        self.owner.engine.app.host_release_gpu();
        self.renderer = None;
    }
    #[cfg(feature = "native-ui")]
    fn recover_gpu(&mut self, gpu: GpuContext) -> Result<(), EditorError> {
        let mut renderer = super::renderer::NativeRenderer::new(&gpu, &mut self.owner.engine.app)?;
        renderer.install_fonts(&mut self.owner.engine.app, self.assets.as_ref());
        self.owner.job_context = renderer.context.clone();
        self.renderer = Some(renderer);
        Ok(())
    }
    fn document_states(&self) -> Option<Vec<DocumentState>> {
        Some(
            self.owner
                .engine()
                .documents()
                .iter()
                .map(|d| {
                    let (source_id, node_binding) = self
                        .sources
                        .get(&d.doc.id.0)
                        .cloned()
                        .unwrap_or_else(|| (format!("native-local:{}", d.doc.id.0), None));
                    DocumentState {
                        document_id: d.doc.id.0.to_string(),
                        source_id,
                        node_binding,
                        revision: d.revision,
                        saved_revision: d.saved_revision,
                        source_size: [d.doc.size.width, d.doc.size.height],
                    }
                })
                .collect(),
        )
    }
    fn shutdown(&mut self) -> Result<(), EditorError> {
        self.owner.shutdown();
        Ok(())
    }
}

fn export_error(error: ExportError) -> EditorError {
    let code = match error {
        ExportError::Busy => ErrorCode::Busy,
        ExportError::BudgetExceeded => ErrorCode::BudgetExceeded,
        ExportError::Cancelled => ErrorCode::Cancelled,
        ExportError::Failed(_) => ErrorCode::InternalError,
    };
    EditorError::new(code, format!("{error:?}"))
}

fn bound_export_result(result: Result<Vec<u8>, ExportError>) -> Result<Vec<u8>, ExportError> {
    match result {
        Ok(bytes) if bytes.len() > 64 * 1024 * 1024 => Err(ExportError::BudgetExceeded),
        other => other,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_export_becomes_terminal_budget_error_before_blob_publication() {
        assert_eq!(
            bound_export_result(Ok(vec![0; 64 * 1024 * 1024 + 1])),
            Err(ExportError::BudgetExceeded)
        );
        assert_eq!(bound_export_result(Ok(vec![1, 2, 3])), Ok(vec![1, 2, 3]));
        assert_eq!(
            bound_export_result(Err(ExportError::Cancelled)),
            Err(ExportError::Cancelled)
        );
    }
}

#[cfg(all(test, feature = "native-ui"))]
mod factory_font_regression {
    use super::*;
    use bevy::prelude::*;
    struct RuntimeAssets(std::path::PathBuf);
    impl RuntimeAssetResolver for RuntimeAssets {
        fn resolve(&self, name: &str, max: usize) -> Result<Vec<u8>, EditorError> {
            let bytes = std::fs::read(self.0.join(name))
                .map_err(|e| EditorError::new(ErrorCode::Unavailable, e.to_string()))?;
            if bytes.len() > max {
                return Err(EditorError::new(
                    ErrorCode::BudgetExceeded,
                    "test asset exceeds budget",
                ));
            }
            Ok(bytes)
        }
    }
    #[test]
    #[ignore = "real GPU + explicit WOOHAA_TEST_ASSET_ROOT containing packaged fonts required"]
    fn factory_with_delivered_fonts_opens_and_renders_first_image() {
        let assets = std::path::PathBuf::from(
            std::env::var_os("WOOHAA_TEST_ASSET_ROOT").expect("explicit packaged asset root"),
        );
        assert!(assets.join("fonts/NotoSansSC-Regular.otf").is_file());
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
        let device = world
            .resource::<bevy::render::renderer::RenderDevice>()
            .clone();
        let gpu = GpuContext {
            adapter: world
                .resource::<bevy::render::renderer::RenderAdapter>()
                .clone(),
            instance: world
                .resource::<bevy::render::renderer::RenderInstance>()
                .clone(),
            queue: world
                .resource::<bevy::render::renderer::RenderQueue>()
                .clone(),
            max_texture_dimension_2d: device.limits().max_texture_dimension_2d,
            device,
            device_generation: 1,
            budget_bytes: 512 * 1024 * 1024,
            color_space: "srgb".into(),
        };
        let mut source = photocraft_engine::Session::new();
        source
            .execute("file.new", serde_json::json!({"width":32,"height":32}))
            .unwrap();
        source
            .execute(
                "edit.assignProfile",
                serde_json::json!({"profile":"display-p3"}),
            )
            .unwrap();
        let bytes = photocraft_io::export(
            &source.active().unwrap().doc,
            "test.png",
            &Default::default(),
        )
        .unwrap()
        .bytes;
        for round in 0..2 {
            let scale = (round + 1) as f64;
            let size = [960 * (round + 1), 640 * (round + 1)];
            let editor = PhotoCraftFactory
                .create(EditorCreateContext {
                    gpu: gpu.clone(),
                    physical_size: size,
                    scale_factor: scale,
                    assets: Arc::new(RuntimeAssets(assets.clone())),
                })
                .unwrap();
            let request = |request_id, operation| ControlRequest {
                session_id: "font-regression".into(),
                generation: 1,
                request_id,
                operation,
            };
            let mut coordinator = EditorCoordinator::new(
                "font-regression".into(),
                1,
                editor,
                PhotoCraftFactory.descriptor().formats,
                64 * 1024 * 1024,
            );
            coordinator
                .enqueue(request(1, ControlOperation::Hide))
                .unwrap();
            coordinator.pump();
            coordinator
                .enqueue(request(
                    2,
                    ControlOperation::Open {
                        source_id: "image".into(),
                        node_binding: Some("node".into()),
                        format: "image/png".into(),
                        bytes: bytes.clone(),
                    },
                ))
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let document_id = loop {
                coordinator.advance_frame(0.).unwrap();
                if let Some(receipt) = coordinator
                    .poll_events()
                    .into_iter()
                    .find(|r| r.request_id == 2)
                {
                    match receipt.result.unwrap() {
                        OperationResult::Opened { document_id, .. } => break document_id,
                        result => panic!("unexpected open result: {result:?}"),
                    }
                }
                assert!(std::time::Instant::now() < deadline, "decode timed out");
                std::thread::sleep(std::time::Duration::from_millis(5));
            };
            coordinator
                .enqueue(request(3, ControlOperation::Hide))
                .unwrap();
            coordinator.pump();
            coordinator
                .enqueue(request(
                    4,
                    ControlOperation::Activate {
                        document_id: document_id.clone(),
                    },
                ))
                .unwrap();
            coordinator.pump();
            assert!(
                coordinator
                    .poll_events()
                    .into_iter()
                    .find(|r| r.request_id == 4)
                    .unwrap()
                    .result
                    .is_ok()
            );
            coordinator
                .set_layout(EditorLayout {
                    physical_size: size,
                    scale_factor: scale,
                    layout_generation: 1,
                    viewport_origin_css: [0., 0.],
                })
                .unwrap();
            coordinator
                .bind_initial_device_generation(gpu.device_generation)
                .unwrap();
            coordinator
                .enqueue(request(5, ControlOperation::Show))
                .unwrap();
            coordinator.pump();
            let mut ready = false;
            let mut first_ready_reports = 0;
            let mut before_zoom = 0.;
            let mut zoom_position = [0., 0.];
            for frame in 0..6 {
                let frame = coordinator
                    .advance_frame(frame as f64 / 60.)
                    .unwrap()
                    .expect("official native frame");
                assert_eq!(frame.snapshot["fontStatus"], "available", "round {round}");
                let preparation = &frame.snapshot["preparation"];
                if preparation["first_ready"] == true {
                    first_ready_reports += 1;
                }
                if frame.snapshot["preparation"].is_object() {
                    for stage in [
                        "input_ms",
                        "logic_ms",
                        "ui_ms",
                        "app_ui_ms",
                        "egui_overhead_ms",
                        "targets_ms",
                        "renderer_lock_ms",
                        "texture_upload_ms",
                        "tessellate_ms",
                        "buffers_ms",
                        "paint_ms",
                        "submit_ms",
                    ] {
                        assert!(
                            preparation[stage]
                                .as_f64()
                                .is_some_and(|n| n.is_finite() && n >= 0.),
                            "missing preparation stage {stage}"
                        );
                    }
                } else if frame.snapshot["preparationFrame"].as_u64() == Some(1) {
                    panic!("first frame must contain preparation timings");
                }
                assert!(frame.snapshot["preparationFrame"].as_u64().is_some());
                assert!(frame.ui_texture.is_some() && frame.document_texture.is_some());
                ready |= frame.snapshot["viewReady"] == true;
                if let Some(zoom) = frame.snapshot["documentView"]["zoom"].as_f64() {
                    before_zoom = zoom;
                }
                zoom_position = [
                    frame.document_rect_css[0] + frame.document_rect_css[2] / 2.,
                    frame.document_rect_css[1] + frame.document_rect_css[3] / 2.,
                ];
            }
            assert_eq!(
                first_ready_reports, 1,
                "one first-ready marker per document"
            );
            assert!(ready, "first image must reach ready state");
            coordinator
                .enqueue_input(NativeEditorInput {
                    sequence: 1,
                    layout_generation: 1,
                    time_seconds: 0.15,
                    event: NativeInputEvent::Zoom {
                        position_css: zoom_position,
                        factor: 1.25,
                    },
                })
                .unwrap();
            let zoomed = coordinator.advance_frame(0.2).unwrap().unwrap();
            let after_zoom = zoomed.snapshot["documentView"]["zoom"].as_f64().unwrap();
            assert!(
                before_zoom > 0. && (after_zoom / before_zoom - 1.25).abs() < 0.001,
                "native pinch must change actual PhotoCraft view zoom: {before_zoom} -> {after_zoom}"
            );
            coordinator
                .enqueue(request(
                    6,
                    ControlOperation::Export {
                        document_id: document_id.clone(),
                        expected_revision: coordinator.documents()[&document_id].revision,
                        format: "png".into(),
                    },
                ))
                .unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                coordinator.pump();
                if let Some(receipt) = coordinator
                    .poll_events()
                    .into_iter()
                    .find(|r| r.request_id == 6)
                {
                    let OperationResult::Exported { bytes, .. } = receipt.result.unwrap() else {
                        panic!("export expected")
                    };
                    let exported = photocraft_io::import("export.png", &bytes)
                        .unwrap()
                        .document;
                    assert_eq!(
                        exported.icc_profile,
                        source.active().unwrap().doc.icc_profile,
                        "host import must preserve the configured embedded profile"
                    );
                    break;
                }
                assert!(std::time::Instant::now() < deadline, "export timed out");
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            coordinator
                .enqueue(request(
                    7,
                    ControlOperation::Close {
                        document_id,
                        expected_revision: coordinator
                            .documents()
                            .values()
                            .next()
                            .unwrap()
                            .revision,
                        discard: true,
                    },
                ))
                .unwrap();
            coordinator.pump();
            for receipt in coordinator.poll_events() {
                coordinator.acknowledge(receipt.request_id);
            }
            coordinator.shutdown().unwrap();
        }
    }
}
