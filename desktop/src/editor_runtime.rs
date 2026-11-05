//! Per-window native editor composition. Defaults to an empty provider registry.
use crate::document_editor::*;
use bevy::render::renderer::{RenderAdapter, RenderDevice, RenderInstance, RenderQueue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::Read,
    path::{Component, PathBuf},
    sync::Arc,
};

const CONTROL_BUDGET: usize = 64 * 1024 * 1024;
const GPU_BUDGET: u64 = 512 * 1024 * 1024;
thread_local! { static RUNTIME: RefCell<Runtime> = RefCell::new(Runtime::default()); }
#[derive(Default)]
struct Runtime {
    providers: BTreeMap<String, Arc<dyn NativeDocumentEditorFactory>>,
    gpu: Option<GpuContext>,
    assets: Option<Arc<dyn RuntimeAssetResolver>>,
    editor: Option<EditorCoordinator>,
    device_generation: u64,
    frame_snapshot: Option<Value>,
    last_presentation: Option<&'static str>,
    clock: Option<std::time::Instant>,
    oldest_input: Option<std::time::Instant>,
    last_job_request: Option<u64>,
}

struct EditorMetricSpan {
    metric: &'static str,
    stage: &'static str,
    started: std::time::Instant,
    request: Option<(u64, u64)>,
}
impl EditorMetricSpan {
    fn new(metric: &'static str, stage: &'static str, request: Option<(u64, u64)>) -> Self {
        Self {
            metric,
            stage,
            started: std::time::Instant::now(),
            request,
        }
    }
}
impl Drop for EditorMetricSpan {
    fn drop(&mut self) {
        let elapsed = self.started.elapsed();
        crate::metrics::sample(self.metric, elapsed);
        crate::performance_capture::native_span(self.stage, elapsed, self.request);
    }
}

struct DirectoryAssets(PathBuf);
impl RuntimeAssetResolver for DirectoryAssets {
    fn resolve(&self, identity: &str, max_bytes: usize) -> Result<Vec<u8>, EditorError> {
        let relative = std::path::Path::new(identity);
        if identity.is_empty()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "invalid runtime asset identity",
            ));
        }
        let base = self
            .0
            .canonicalize()
            .map_err(|_| EditorError::new(ErrorCode::Unavailable, "runtime assets unavailable"))?;
        let file = base
            .join(relative)
            .canonicalize()
            .map_err(|_| EditorError::new(ErrorCode::Unavailable, "runtime asset missing"))?;
        if !file.starts_with(&base) {
            return Err(EditorError::new(
                ErrorCode::Unsupported,
                "runtime asset escapes root",
            ));
        }
        if max_bytes > CONTROL_BUDGET {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "runtime asset budget too large",
            ));
        }
        let file = std::fs::File::open(file)
            .map_err(|_| EditorError::new(ErrorCode::Unavailable, "runtime asset unreadable"))?;
        let mut bytes = Vec::new();
        file.take(max_bytes as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| EditorError::new(ErrorCode::Unavailable, "runtime asset read failed"))?;
        if bytes.len() > max_bytes {
            return Err(EditorError::new(
                ErrorCode::BudgetExceeded,
                "runtime asset exceeds budget",
            ));
        }
        Ok(bytes)
    }
}

/// Call before run_host on the thread that will own the Tauri window.
pub fn register(factories: Vec<Arc<dyn NativeDocumentEditorFactory>>) -> Result<(), EditorError> {
    if factories.len() > 32 {
        return Err(EditorError::new(
            ErrorCode::BudgetExceeded,
            "too many editor providers",
        ));
    }
    let mut next = BTreeMap::new();
    for factory in factories {
        let descriptor = factory.descriptor();
        if descriptor.provider_id.is_empty()
            || descriptor.provider_id.len() > 128
            || next.insert(descriptor.provider_id, factory).is_some()
        {
            return Err(EditorError::new(
                ErrorCode::Incompatible,
                "invalid or duplicate editor provider",
            ));
        }
    }
    RUNTIME.with(|state| {
        let mut state = state.borrow_mut();
        if state.editor.is_some() {
            return Err(EditorError::new(
                ErrorCode::Busy,
                "close editor workspace before replacing providers",
            ));
        }
        state.providers = next;
        Ok(())
    })
}

pub(crate) fn install_gpu(
    device: RenderDevice,
    queue: RenderQueue,
    adapter: RenderAdapter,
    instance: RenderInstance,
    assets: PathBuf,
) {
    RUNTIME.with(|state| {
        let mut state = state.borrow_mut();
        state.device_generation = state.device_generation.saturating_add(1);
        let generation = state.device_generation;
        let max_texture_dimension_2d = device.limits().max_texture_dimension_2d;
        let gpu = GpuContext {
            adapter,
            instance,
            device,
            queue,
            device_generation: generation,
            max_texture_dimension_2d,
            budget_bytes: GPU_BUDGET,
            color_space: "srgb-premultiplied".into(),
        };
        let recovered = state
            .editor
            .as_mut()
            .map_or(Ok(()), |editor| editor.recover_gpu(gpu.clone()));
        state.gpu = recovered.is_ok().then_some(gpu);
        state.assets = Some(Arc::new(DirectoryAssets(assets)));
    });
}

pub(crate) fn detach_gpu() {
    RUNTIME.with(|state| {
        let mut state = state.borrow_mut();
        if let Some(editor) = state.editor.as_mut() {
            editor.device_lost();
        }
        state.gpu = None;
        state.assets = None;
    });
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateRequest {
    provider_id: String,
    session_id: String,
    generation: u64,
    project_protocol: u32,
    browser_protocol: u32,
    capabilities: Vec<String>,
    physical_size: [u32; 2],
    scale_factor: f64,
}

/// Parsing and serializing these DTOs belongs to the bounded IPC worker, never the UI owner.
pub(crate) enum PreparedControl {
    Capabilities,
    Create(CreateRequest),
    Enqueue(ControlRequest, Option<String>),
    Poll,
    Layout(EditorLayout),
    Input(Vec<NativeEditorInput>),
    Ack(u64),
    Shutdown,
}
pub(crate) fn prepare(method: &str, argument: Option<&str>) -> Result<PreparedControl, String> {
    let _span = EditorMetricSpan::new("native_editor.control_parse_ms", "control-parse", None);
    fn parse<T: serde::de::DeserializeOwned>(argument: Option<&str>) -> Result<T, String> {
        serde_json::from_str(argument.ok_or("missing native editor argument")?)
            .map_err(|e| e.to_string())
    }
    Ok(match method {
        "document_editor_capabilities" => PreparedControl::Capabilities,
        "document_editor_create" => PreparedControl::Create(parse(argument)?),
        "document_editor_enqueue" => {
            let mut wire: Value = parse(argument)?;
            let blob = wire
                .get_mut("operation")
                .and_then(Value::as_object_mut)
                .and_then(|op| op.remove("bytes_blob_id"));
            let upload = if let Some(blob) = blob {
                let ticket = blob
                    .as_str()
                    .filter(|s| s.len() <= 64)
                    .ok_or("invalid editor upload ticket")?
                    .to_string();
                let op = wire
                    .get_mut("operation")
                    .and_then(Value::as_object_mut)
                    .ok_or("missing editor operation")?;
                if op.get("kind").and_then(Value::as_str) != Some("open")
                    || op.contains_key("bytes")
                {
                    return Err("binary ticket requires Open without inline bytes".into());
                }
                op.insert("bytes".into(), json!([]));
                Some(ticket)
            } else {
                None
            };
            let mut request: ControlRequest =
                serde_json::from_value(wire).map_err(|e| e.to_string())?;
            if let (Some(ticket), ControlOperation::Open { bytes, .. }) =
                (&upload, &mut request.operation)
            {
                *bytes = crate::editor_blobs::source(ticket)?.as_ref().clone();
            }
            PreparedControl::Enqueue(request, upload)
        }
        "document_editor_poll" => PreparedControl::Poll,
        "document_editor_layout" => PreparedControl::Layout(parse(argument)?),
        "document_editor_input" => {
            let events: Vec<NativeEditorInput> = parse(argument)?;
            if events.len() > 256 {
                return Err("native editor input batch exceeds budget".into());
            }
            PreparedControl::Input(events)
        }
        "document_editor_ack" => PreparedControl::Ack(parse(argument)?),
        "document_editor_shutdown" => PreparedControl::Shutdown,
        _ => return Err("unsupported editor operation".into()),
    })
}
#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum ControlReply {
    Small(Value),
    Poll(PollReply),
}
#[derive(Serialize)]
pub(crate) struct PollReply {
    receipts: SharedReceipts,
    state: Vec<EditorStateEvent>,
    documents: BTreeMap<String, DocumentState>,
    visible: bool,
    frame: Option<Value>,
}
struct SharedReceipts(Vec<Arc<CompletionReceipt>>);
impl Serialize for SharedReceipts {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for receipt in &self.0 {
            match &receipt.result {
                Ok(OperationResult::Exported { revision, .. }) => {
                    let ticket =
                        crate::editor_blobs::output(receipt).map_err(serde::ser::Error::custom)?;
                    let wire = json!({"request_id":receipt.request_id,"generation":receipt.generation,
                        "result":{"Ok":{"kind":"exported","bytes_blob_id":ticket,"revision":revision}}});
                    sequence.serialize_element(&wire)?;
                }
                _ => sequence.serialize_element(receipt.as_ref())?,
            }
        }
        sequence.end()
    }
}
/// Compatibility entry for internal callers/tests. The URI bridge uses prepare off-thread.
#[cfg(test)]
pub(crate) fn control(method: &str, argument: Option<&str>) -> Result<Value, String> {
    serde_json::to_value(control_prepared(prepare(method, argument)?)?).map_err(|e| e.to_string())
}

pub(crate) fn control_prepared(request: PreparedControl) -> Result<ControlReply, String> {
    let correlation = match &request {
        PreparedControl::Enqueue(r, _) => Some((r.request_id, r.generation)),
        _ => None,
    };
    let _span = EditorMetricSpan::new(
        "native_editor.control_owner_ms",
        "control-owner",
        correlation,
    );
    RUNTIME.with(|state| {
        let mut state = state.borrow_mut();
        let error = |e: EditorError| serde_json::to_string(&e).unwrap_or_else(|_| "native editor error".into());
        match request {
            PreparedControl::Capabilities => Ok(ControlReply::Small(json!({"providers":state.providers.values().map(|f| f.descriptor()).collect::<Vec<_>>(),"gpu_ready":state.gpu.is_some(),"workspace_open":state.editor.is_some()}))),
            PreparedControl::Create(request) => {
                if state.editor.is_some() { return Err(error(EditorError::new(ErrorCode::Busy, "editor workspace already exists"))); }
                if request.session_id.is_empty() || request.session_id.len() > 128 || request.generation == 0 || request.capabilities.len() > 32
                    || !request.scale_factor.is_finite() || request.scale_factor <= 0.0 || request.scale_factor > 8.0 {
                    return Err(error(EditorError::new(ErrorCode::Incompatible, "invalid workspace metadata")));
                }
                let factory = state.providers.get(&request.provider_id).cloned();
                let descriptor = factory.as_ref().map(|f| f.descriptor());
                admit_provider(descriptor.as_ref(), &AdmissionRequirements { project_protocol: request.project_protocol,
                    browser_protocol: request.browser_protocol, capabilities: request.capabilities }).map_err(error)?;
                let factory = factory.ok_or_else(|| error(EditorError::new(ErrorCode::Unavailable, "provider absent")))?;
                let gpu = state.gpu.clone().ok_or_else(|| error(EditorError::new(ErrorCode::Unavailable, "native GPU not ready")))?;
                if request.physical_size.iter().any(|&n| n == 0 || n > gpu.max_texture_dimension_2d) {
                    return Err(error(EditorError::new(ErrorCode::BudgetExceeded, "editor viewport exceeds GPU limits")));
                }
                let assets = state.assets.clone().ok_or("runtime assets unavailable")?;
                let device_generation = gpu.device_generation;
                let provider = factory.create(EditorCreateContext { gpu, physical_size: request.physical_size, scale_factor: request.scale_factor, assets }).map_err(error)?;
                let formats = descriptor.map_or_else(Vec::new, |d| d.formats);
                let mut editor = EditorCoordinator::new(request.session_id, request.generation, provider, formats, CONTROL_BUDGET);
                editor.bind_initial_device_generation(device_generation).map_err(error)?;
                crate::shell_log::info(&format!("Native document editor created: provider={} gpu_generation={}",request.provider_id,device_generation));
                state.last_presentation=None;
                state.editor = Some(editor);
                Ok(ControlReply::Small(json!({"ok":true})))
            }
            PreparedControl::Enqueue(request,_) => {
                state.editor.as_mut().ok_or("native editor workspace unavailable")?.enqueue(request).map_err(error)?;
                Ok(ControlReply::Small(json!({"ok":true})))
            }
            PreparedControl::Poll => {
                let editor = state.editor.as_ref().ok_or("native editor workspace unavailable")?;
                Ok(ControlReply::Poll(PollReply { receipts: SharedReceipts(editor.poll_shared_events()), state: editor.state_events(), documents: editor.documents().clone(), visible: editor.visible(), frame: state.frame_snapshot.clone() }))
            }
            PreparedControl::Layout(layout) => {
                state.editor.as_mut().ok_or("native editor workspace unavailable")?.set_layout(layout).map_err(error)?;
                Ok(ControlReply::Small(json!({"ok":true})))
            }
            PreparedControl::Input(events) => {
                if events.len() > 256 { return Err("native editor input batch exceeds budget".into()); }
                let accepted_any=!events.is_empty();
                let editor=state.editor.as_mut().ok_or("native editor workspace unavailable")?;
                for event in events { editor.enqueue_input(event).map_err(&error)?; }
                if accepted_any {state.oldest_input.get_or_insert_with(std::time::Instant::now);}
                Ok(ControlReply::Small(json!({"ok":true})))
            }
            PreparedControl::Ack(id) => {
                let editor=state.editor.as_mut().ok_or("native editor workspace unavailable")?;
                let retained=editor.poll_shared_events().into_iter().find(|receipt|receipt.request_id==id);
                let acknowledged=editor.acknowledge(id);
                if let Some(receipt)=retained {if acknowledged {crate::editor_blobs::revoke(&receipt);}}
                Ok(ControlReply::Small(json!({"ok":acknowledged})))
            }
            PreparedControl::Shutdown => {
                if let Some(editor) = state.editor.as_mut() { editor.shutdown().map_err(error)?; }
                state.editor = None;
                Ok(ControlReply::Small(json!({"ok":true})))
            }
        }
    })
}
pub(crate) fn owns_presentation() -> bool {
    RUNTIME.with(|state| state.borrow().editor.as_ref().is_some_and(|editor| editor.visible()))
}
pub(crate) fn tick(app: &mut bevy::prelude::App) {
    RUNTIME.with(|state| {
        let mut state = state.borrow_mut();
        let time = state
            .clock
            .get_or_insert_with(std::time::Instant::now)
            .elapsed()
            .as_secs_f64();
        let Some(editor) = state.editor.as_mut() else {
            crate::editor_compositor::release(app);
            return;
        };
        let _span = editor
            .visible()
            .then(|| EditorMetricSpan::new("native_editor.ui_frame_ms", "ui-frame", None));
        let pump = std::time::Instant::now();
        let layout = editor.layout().cloned();
        let render_started = std::time::Instant::now();
        let frame = editor.advance_frame(time);
        crate::metrics::sample("native_editor.owner_cycle_ms", pump.elapsed());
        let visible=editor.visible();
        if visible { if let Some(layout) = &layout { crate::canvas_suspension::sync_window(app, layout); } }
        if visible && layout.is_some() {
            if let Some(accepted) = state.oldest_input.take() {
                crate::metrics::sample(
                    "native_editor.input_owner_queue_age_ms",
                    render_started.saturating_duration_since(accepted),
                );
            }
        }
        let node_binding=frame.as_ref().ok().and_then(|frame|frame.as_ref()).and_then(|frame|state.editor.as_ref()?.documents().get(&frame.document_id)?.node_binding.clone());
        match frame {
            Ok(Some(frame)) => {
                // Provider phase durations are reported after the frame. Keep them
                // in the numeric log/snapshot rather than inventing trace positions.
                if frame.snapshot.get("preparation").is_some_and(Value::is_object) {
                    crate::shell_log::info(&format!("Native preparation accepted: document={} frame={} view_ready={}", frame.document_id, frame.snapshot["preparationFrame"], frame.snapshot["viewReady"]));
                }
                if let Some(metrics) = frame.snapshot.get("metrics") {
                    for (key, metric, stage) in [
                        (
                            "provider_frame_cpu_wall_ms",
                            "native_editor.provider_frame_cpu_wall_ms",
                            "provider-frame",
                        ),
                        (
                            "gpu_command_encode_cpu_ms",
                            "native_editor.gpu_command_encode_cpu_ms",
                            "gpu-encode-cpu",
                        ),
                        (
                            "gpu_queue_submit_cpu_ms",
                            "native_editor.gpu_queue_submit_cpu_ms",
                            "gpu-submit-cpu",
                        ),
                    ] {
                        if let Some(ms) = metrics
                            .get(key)
                            .and_then(Value::as_f64)
                            .filter(|ms| ms.is_finite() && (0.0..=3_600_000.0).contains(ms))
                        {
                            let duration = std::time::Duration::from_secs_f64(ms / 1000.0);
                            crate::metrics::sample(metric, duration);
                            crate::performance_capture::native_span(stage, duration, None);
                        }
                    }
                    if let Some(id) = metrics.get("job_request_id").and_then(Value::as_u64) {
                        if state.last_job_request != Some(id) {
                            if let Some(ms) = metrics
                                .get("job_start_to_receipt_ms")
                                .and_then(Value::as_f64)
                                .filter(|ms| ms.is_finite() && (0.0..=3_600_000.0).contains(ms))
                            {
                                crate::metrics::sample(
                                    "native_editor.job_start_to_receipt_ms",
                                    std::time::Duration::from_secs_f64(ms / 1000.0),
                                );
                                state.last_job_request = Some(id);
                            }
                        }
                    }
                }
                let path=match frame.snapshot.get("renderPath").and_then(Value::as_str) {
                    Some("shared-gpu")=>Some("shared-gpu"),
                    Some("native-cpu-viewport")=>Some("native-cpu-viewport"),_=>None,
                };
                if path!=state.last_presentation {
                    if let Some(path)=path {
                        crate::performance_capture::native_presentation(path);
                        crate::shell_log::info(&format!("Native editor presentation: {path}"));
                    }
                    state.last_presentation=path;
                }
                state.frame_snapshot = Some(frame.snapshot.clone());
                app.world_mut().resource_mut::<woohaa_bevy_canvas::document_editor_visibility::NativeEditorTarget>().0=node_binding;
                if let Some(layout) = layout {
                    let _composite = EditorMetricSpan::new(
                        "native_editor.composite_handoff_ms",
                        "composite-handoff",
                        None,
                    );
                    crate::editor_compositor::present(
                        app,
                        Some(frame),
                        layout.viewport_origin_css,
                        layout.scale_factor,
                    );
                }
            }
            Ok(None) if !visible => crate::editor_compositor::present(app, None, [0., 0.], 1.),
            Err(error) => {
                let snapshot=state.frame_snapshot.get_or_insert_with(||json!({}));
                snapshot["viewReady"]=json!(false);
                snapshot["renderStatus"]=json!("paused");
                snapshot["renderError"]=json!(error.message);
                log::debug!("native editor frame deferred: {:?}", error.code);
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_host_is_explicitly_unavailable_and_no_workspace_is_created() {
        register(Vec::new()).unwrap();
        let capabilities = control("document_editor_capabilities", None).unwrap();
        assert_eq!(capabilities["providers"], json!([]));
        assert_eq!(capabilities["workspace_open"], false);
        let request = json!({"provider_id":"absent","session_id":"test","generation":1,"project_protocol":1,"browser_protocol":1,"capabilities":[],"physical_size":[100,100],"scale_factor":1});
        assert!(
            control("document_editor_create", Some(&request.to_string()))
                .unwrap_err()
                .contains("unavailable")
        );
    }
    #[test]
    fn typed_control_parse_is_independent_of_owner_thread_and_preserves_bytes() {
        let request=serde_json::json!({"session_id":"test","request_id":1,"generation":1,
            "operation":{"kind":"open","source_id":"image","node_binding":null,"format":"image/png","bytes":[1,2,3,255]}}).to_string();
        let parsed = std::thread::spawn(move || prepare("document_editor_enqueue", Some(&request)))
            .join()
            .unwrap()
            .unwrap();
        let PreparedControl::Enqueue(parsed, _) = parsed else {
            panic!("expected typed enqueue");
        };
        let ControlOperation::Open { bytes, .. } = parsed.operation else {
            panic!("expected open");
        };
        assert_eq!(bytes, vec![1, 2, 3, 255]);
    }
    #[test]
    fn shared_export_receipts_serialize_without_cloning_payload_on_owner() {
        let receipt = Arc::new(CompletionReceipt {
            request_id: 7,
            generation: 2,
            result: Ok(OperationResult::Exported {
                bytes: vec![3, 4, 255],
                revision: 9,
            }),
        });
        let encoded = serde_json::to_value(SharedReceipts(vec![receipt.clone()])).unwrap();
        assert!(encoded[0]["result"]["Ok"]["bytes_blob_id"].is_string());
        assert!(encoded[0]["result"]["Ok"].get("bytes").is_none());
        assert_eq!(
            serde_json::to_value(receipt.as_ref()).unwrap()["result"]["Ok"]["bytes"],
            json!([3, 4, 255])
        );
        assert_eq!(Arc::strong_count(&receipt), 1);
    }
    #[test]
    fn runtime_assets_reject_paths_outside_the_injected_root() {
        let assets = DirectoryAssets(std::env::temp_dir());
        for path in ["../secrets", "/etc/passwd", "a/../../secrets", ""] {
            assert_eq!(
                assets.resolve(path, 100).unwrap_err().code,
                ErrorCode::Unsupported
            );
        }
    }
}
