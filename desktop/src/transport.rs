//! Native boundary for the existing synchronous renderer facade.
//! All state access is dispatched onto the Tauri main thread. Texture bodies are
//! bounded raw bytes, never JSON pixel arrays. This development bridge preserves
//! exact query coordinates while the controller still uses synchronous queries.
use crate::notifications;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::Manager;
use woohaa_bevy_canvas as canvas;

/// 控制消息上限：与浏览器侧模型资源 payload（16MB）一致，容纳含法线/UV/顶点色的 GLB Scene IR
/// （change: 2026-10-28-support-glb-model-nodes）。
const MAX_CONTROL_BYTES: usize = 16 * 1024 * 1024;
/// 单次纹理上传的 RGBA 字节上限：按最大纹理边长（`woohaa_media_image::MAX_EDGE` = 4096，
/// 与 Bevy `MAX_TEXTURE_EDGE` 一致）的正方形计，否则 4096 档的纹理在传输层先被拒绝。
const MAX_TEXTURE_BYTES: usize =
    woohaa_media_image::MAX_EDGE as usize * woohaa_media_image::MAX_EDGE as usize * 4;
// Two bounded IPC workers isolate editor byte parsing/encoding from Tauri's UI loop.
type EditorIpcJob = Box<dyn FnOnce() + Send + 'static>;
fn editor_ipc_workers() -> &'static std::sync::mpsc::SyncSender<EditorIpcJob> {
    static WORKERS: std::sync::OnceLock<std::sync::mpsc::SyncSender<EditorIpcJob>> = std::sync::OnceLock::new();
    WORKERS.get_or_init(|| {
        let (tx,rx) = std::sync::mpsc::sync_channel::<EditorIpcJob>(256);
        let receiver=std::sync::Arc::new(std::sync::Mutex::new(rx));
        for _ in 0..2 { let receiver=receiver.clone(); std::thread::spawn(move || loop {
            let job=receiver.lock().unwrap_or_else(|p|p.into_inner()).recv();
            match job { Ok(job) => { let _=std::panic::catch_unwind(std::panic::AssertUnwindSafe(job)); }, Err(_) => break }
        }); }
        tx
    })
}
#[derive(serde::Serialize)]
struct EditorIpcEnvelope {
    ok: bool,
    #[serde(skip_serializing_if="Option::is_none")]
    value: Option<crate::editor_runtime::ControlReply>,
    #[serde(skip_serializing_if="Option::is_none")]
    error: Option<String>,
}
fn editor_ipc_envelope(result: Result<crate::editor_runtime::ControlReply,String>) -> Vec<u8> {
    let started=std::time::Instant::now();
    let envelope=match result { Ok(value)=>EditorIpcEnvelope {ok:true,value:Some(value),error:None},
        Err(error)=>EditorIpcEnvelope {ok:false,value:None,error:Some(error)} };
    let bytes=serde_json::to_vec(&envelope).unwrap_or_else(|_| br#"{"ok":false,"error":"editor response encoding failed"}"#.to_vec());
    crate::metrics::sample("native_editor.ipc_encode_ms",started.elapsed());
    crate::performance_capture::native_span("ipc-encode",started.elapsed(),None);
    bytes
}
thread_local! {
    // 最近一次 full 基线、导航序号及真实接受代数；仅宿主主线程访问。
    static VIEWPORT_SEQUENCE: std::cell::Cell<(u32, u64, u32)> = const { std::cell::Cell::new((0, 0, 0)) };
}

fn sequenced_viewport(json: &str, sequence: u64) -> Result<u32, String> {
    if sequence == 0 || sequence > 9_007_199_254_740_991 {
        return Err("Invalid viewport sequence".into());
    }
    let input: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let base = input
        .get("baseSceneGeneration")
        .and_then(Value::as_u64)
        .ok_or("Invalid viewport base")?;
    let current = canvas::base_scene_generation();
    if base == 0 || base != u64::from(current) {
        return Err("Stale viewport base".into());
    }
    VIEWPORT_SEQUENCE.with(|state| {
        let (previous_base, previous_sequence, generation) = state.get();
        if previous_base == current && sequence <= previous_sequence {
            return Ok(generation);
        }
        let accepted = canvas::set_viewport(json).map_err(|e| e.to_string())?;
        state.set((current, sequence, accepted));
        crate::metrics::navigation();
        Ok(accepted)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_viewports_cannot_overwrite_a_barrier_or_a_new_full_scene() {
        let mut theme: Value = serde_json::from_str(include_str!(
            "../../web/contracts/src/theme/app-theme.default.json"
        ))
        .unwrap();
        theme["fingerprint"] = json!("abcd");
        let scene =
            json!({"version":canvas::scene_capability(),"theme":theme,"nodes":[],"edges":[]});
        let full = || {
            control(
                &serde_json::to_vec(&json!({"method":"set_scene","args":[scene.to_string()]}))
                    .unwrap(),
            )
            .unwrap()
        };
        let base = full().as_u64().unwrap();
        let view = |base: u64, x: i32| {
            json!({"version":canvas::viewport_capability(),"baseSceneGeneration":base,
            "viewport":{"x":x,"y":0,"zoom":1}})
            .to_string()
        };
        let accepted = sequenced_viewport(&view(base, 90), 3).unwrap();
        assert_eq!(sequenced_viewport(&view(base, 10), 1).unwrap(), accepted);
        assert!(sequenced_viewport(&view(base, 10), 0).is_err());
        assert!(sequenced_viewport(&view(base, 10), u64::MAX).is_err());
        let new_base = full().as_u64().unwrap();
        assert!(sequenced_viewport(&view(base, 20), 4).is_err());
        assert!(sequenced_viewport(&view(new_base, 30), 1).unwrap() > accepted);
    }
    #[test]
    fn version_dots_hit_inside_card_and_hide_for_single_version() {
        let mut theme: Value = serde_json::from_str(include_str!(
            "../../web/contracts/src/theme/app-theme.default.json"
        ))
        .unwrap();
        theme["fingerprint"] = json!("abcd");
        let mut scene = json!({"version":canvas::scene_capability(),"theme":theme,"edges":[],
            "nodes":[{"id":"n","type":"image","x":100,"y":200,"width":248,"height":232,
                "historyStrip":{"dots":[{"state":"succeeded","current":true},{"state":"succeeded","current":false}],"truncated":0}}]});
        let accept = |scene: &Value| {
            control(
                &serde_json::to_vec(&json!({"method":"set_scene","args":[scene.to_string()]}))
                    .unwrap(),
            )
            .unwrap()
        };
        let query = |generation: &Value, y: f64| -> Value {
            serde_json::from_str(&canvas::query_point_hit(
                &json!({"generation":generation,"x":220,"y":y,"zoom":1}).to_string(),
            ))
            .unwrap()
        };
        let generation = accept(&scene);
        assert_eq!(query(&generation, 420.0)["hit"]["kind"], "history");
        assert!(query(&generation, 447.0)["hit"].is_null());
        scene["nodes"][0]["historyStrip"]["dots"] = json!([{"state":"succeeded","current":true}]);
        let generation = accept(&scene);
        assert_eq!(query(&generation, 420.0)["hit"]["kind"], "node");
    }
    #[test]
    fn malformed_or_unknown_control_requests_are_rejected() {
        assert!(control(b"not json").is_err());
        assert!(control(br#"{"method":"execute_arbitrary_code"}"#).is_err());
        assert!(control(br#"{"method":"layout","args":[0,0,-1,100]}"#).is_err());
        assert!(control(br#"{"method":"set_scene","args":["{}"]}"#).is_err());
    }
    #[test]
    fn raw_texture_boundary_validates_metadata_and_byte_length() {
        assert!(texture(r#"{"id":"a","width":2,"height":2,"plane":false}"#, vec![0; 4]).is_err());
        assert!(texture(r#"{"id":"","width":1,"height":1,"plane":false}"#, vec![0; 4]).is_err());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    method: String,
    #[serde(default)]
    args: Vec<Value>,
}

fn arg<'a>(request: &'a Request, index: usize) -> Result<&'a str, String> {
    request
        .args
        .get(index)
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing string argument".into())
}

pub fn control(body: &[u8]) -> Result<Value, String> {
    if body.len() > MAX_CONTROL_BYTES {
        return Err("Control payload exceeds budget".into());
    }
    let req: Request = serde_json::from_slice(body).map_err(|e| e.to_string())?;
    static OPERATION: std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(1);
    let trace=matches!(req.method.as_str(),"set_scene"|"prepare_and_register_model_resource");
    let operation=OPERATION.fetch_add(u64::from(trace),std::sync::atomic::Ordering::Relaxed);
    let started=std::time::Instant::now();
    if trace {crate::diagnostics::event("native-bridge","operation-start",json!({"method":req.method,"operation":operation}));}
    let result = match req.method.as_str() {
        method if method.starts_with("document_editor_") => {
            return Err("Native editor calls require isolated /editor-rpc transport".into());
        }
        "client_metrics" => {
            crate::metrics::client_with_work(
                req.args.first().ok_or("Missing metrics")?,
                req.args.get(1).unwrap_or(&Value::Null),
            )?;
            Value::Null
        }
        "is_ready" => json!(canvas::is_ready()),
        "rendered_revision" => json!(canvas::rendered_revision()),
        "base_scene_generation" => json!(canvas::base_scene_generation()),
        "viewport_capability" => json!(canvas::viewport_capability()),
        "observer_capability" => json!(canvas::observer_capability()),
        "scene_capability" => json!(canvas::scene_capability()),
        "position_capability" => json!(canvas::position_capability()),
        "set_resource_states" => json!(canvas::set_resource_states(arg(&req, 0)?).map_err(|e|e.to_string())?),
        "poll_texture_receipts" => json!(canvas::poll_texture_receipts()),
        "runtime_health" => json!(canvas::runtime_health()),
        "seed_runtime_generation" => {
            canvas::seed_runtime_generation(
                req.args.first().and_then(Value::as_u64).unwrap_or(0) as u32
            );
            Value::Null
        }
        "canvas_work_diagnostics" => json!(canvas::canvas_work_diagnostics()),
        // 系统通知（change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.2）：
        // 独立版本能力 + 权限查询/申请 + 发送；请求体仍是同一 token/来源受限的边界，
        // 不开放通用 IPC，native 层也不是任务状态源。
        "notification_capability" => json!(notifications::capability()),
        "notification_permission" => {
            notifications::sink(|sink| notifications::permission_value(&*sink))
        }
        "notification_request_permission" => {
            notifications::sink(notifications::request_permission_value)
        }
        "notification_show" => {
            let body = arg(&req, 0)?.as_bytes().to_vec();
            notifications::sink(|sink| notifications::handle(sink, &body))
                .map_err(|error| error.message())?
        }
        // 任务 8.4：窗口重新获得焦点后取走最近一次通知点击（取走即清空）。
        "notification_take_click" => json!(notifications::take_pending_click()),
        "model_asset_diagnostics" => json!(canvas::model_asset_diagnostics()),
        "shot_diagnostics" => json!(canvas::shot_diagnostics()),
        "set_scene" => {
            let accepted = canvas::set_scene(arg(&req, 0)?).map_err(|e| e.to_string())?;
            crate::metrics::navigation();
            json!(accepted)
        }
        "set_viewport" => {
            let accepted = canvas::set_viewport(arg(&req, 0)?).map_err(|e| e.to_string())?;
            crate::metrics::navigation();
            json!(accepted)
        }
        "set_observer" => {
            let accepted = canvas::set_observer(arg(&req, 0)?).map_err(|e| e.to_string())?;
            crate::metrics::navigation();
            json!(accepted)
        }
        "set_viewport_sequenced" => {
            let sequence = req
                .args
                .get(1)
                .and_then(Value::as_u64)
                .ok_or("Invalid viewport sequence")?;
            json!(sequenced_viewport(arg(&req, 0)?, sequence)?)
        }
        "set_positions" => {
            let accepted = canvas::set_positions(arg(&req, 0)?).map_err(|e| e.to_string())?;
            crate::metrics::navigation();
            json!(accepted)
        }
        "prepare_and_register_model_resource" => json!(
            canvas::prepare_and_register_model_resource(arg(&req, 0)?).map_err(|e| e.to_string())?
        ),
        "declare_model_resource" => json!(
            canvas::declare_model_resource(arg(&req, 0)?).map_err(|e| e.to_string())?
        ),
        "set_model_payload_leases" => json!(
            canvas::set_model_payload_leases(arg(&req, 0)?).map_err(|e| e.to_string())?
        ),
        "query_point_hit" => json!(canvas::query_point_hit(arg(&req, 0)?)),
        "query_marquee" => json!(canvas::query_marquee(arg(&req, 0)?)),
        "query_probe" => json!(canvas::query_probe(arg(&req, 0)?)),
        "query_drop_target" => json!(canvas::query_drop_target(arg(&req, 0)?)),
        "query_model_pick" => json!(canvas::query_model_pick(arg(&req, 0)?)),
        "query_gizmo_hit" => json!(canvas::query_gizmo_hit(arg(&req, 0)?)),
        "request_shot_capture" => {
            canvas::request_shot_capture(arg(&req, 0)?).map_err(|e| e.to_string())?;
            Value::Null
        }
        "layout" => {
            let v = &req.args;
            let number = |i: usize| {
                v.get(i)
                    .and_then(Value::as_f64)
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .ok_or("Invalid layout")
            };
            let (x, y, w, h) = (number(0)?, number(1)?, number(2)?, number(3)?);
            #[cfg(target_os = "macos")]
            crate::macos_view::layout(x, y, w, h);
            let _ = (x, y, w, h);
            Value::Null
        }
        _ => return Err(format!("Unsupported native method: {}", req.method)),
    };
    if trace {crate::diagnostics::event("native-bridge","operation-end",json!({"method":req.method,"operation":operation,"durationMs":started.elapsed().as_millis() as u64}));}
    Ok(result)
}

pub fn texture(header: &str, bytes: Vec<u8>) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Texture {
        id: String,
        width: u32,
        height: u32,
        plane: bool,
        /// 稳定内容身份：Rust 侧按内容+尺寸共享同一 GPU 纹理
        /// （change: 2026-10-23-scale-canvas-media-residency，design D4 / 任务 4.4）。
        #[serde(default)]
        content: String,
    }
    if bytes.len() > MAX_TEXTURE_BYTES {
        return Err("Texture payload exceeds budget".into());
    }
    let meta: Texture = serde_json::from_str(header).map_err(|e| e.to_string())?;
    if meta.id.is_empty() || meta.id.len() > 1024 {
        return Err("Invalid texture id".into());
    }
    if meta.content.len() > 4096 {
        return Err("Texture content identity too large".into());
    }
    let result = if meta.plane {
        canvas::set_model_media_texture_owned(&meta.id, meta.width, meta.height, bytes)
    } else {
        canvas::set_texture_owned(&meta.id, meta.width, meta.height, bytes, &meta.content)
    };
    result.map_err(|e| e.to_string())
}

pub fn capture(request_id: f64, generation: f64) -> Vec<u8> {
    canvas::poll_shot_capture(request_id, generation)
}

/// 安装 native 边界协议。
///
/// `origin` 由宿主在 `setup` 里确定（打包默认值可能来自 bundle 资源，此时 WebView 源在构建
/// builder 之前还不可知），因此用 `RwLock` 传入：宿主重启后端口变化时同步更新，启动前使用
/// 内置前端资源的源。
pub fn install(
    builder: tauri::Builder<tauri::Wry>,
    token: String,
    origin: std::sync::Arc<std::sync::RwLock<String>>,
) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        "woohaa-native",
        move |ctx, request, responder| {
            let origin = origin.clone();
            let respond = move |body: Vec<u8>, mime: &str| {
                let allowed = origin
                    .read()
                    .ok()
                    .map(|value| value.clone())
                    .unwrap_or_else(|| "tauri://localhost".to_owned());
                responder.respond(
                    tauri::http::Response::builder()
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", allowed)
                        .header(
                            "Access-Control-Allow-Headers",
                            "Content-Type, X-Woohaa-Token",
                        )
                        .header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
                        .header("Cache-Control", "no-store")
                        .body(body)
                        .expect("native response"),
                );
            };
            if request.method() == tauri::http::Method::OPTIONS {
                respond(Vec::new(), "text/plain");
                return;
            }
            if ctx.webview_label() != "main"
                || request
                    .headers()
                    .get("X-Woohaa-Token")
                    .and_then(|h| h.to_str().ok())
                    != Some(token.as_str())
            {
                respond(
                    br#"{"ok":false,"error":"Unauthorized native boundary"}"#.to_vec(),
                    "application/json",
                );
                return;
            }
            // Diagnostics must remain usable when the renderer/main thread is blocked.
            if request.uri().path() == "/performance-clock" {
                let value = if request.method() == tauri::http::Method::GET {
                    crate::performance_capture::clock_pair()
                } else {
                    json!({"ok":false,"error":"Timing clock requires GET"})
                };
                respond(serde_json::to_vec(&value).unwrap(), "application/json");
                return;
            }
            if request.uri().path() == "/performance" {
                let result = if request.method() == tauri::http::Method::POST {
                    crate::performance_capture::ingest(request.body())
                } else { Err("Timing capture requires POST".into()) };
                respond(serde_json::to_vec(&match result {
                    Ok(()) => json!({"ok":true}),
                    Err(error) => json!({"ok":false,"error":error}),
                }).unwrap(), "application/json");
                return;
            }
            if request.uri().path() == "/diagnostics" {
                let result = if request.method() == tauri::http::Method::POST {
                    crate::diagnostics::ingest(request.body())
                } else {
                    Err("Diagnostics require POST".into())
                };
                respond(
                    serde_json::to_vec(&match result {
                        Ok(()) => json!({"ok":true}),
                        Err(error) => json!({"ok":false,"error":error}),
                    })
                    .unwrap(),
                    "application/json",
                );
                return;
            }
            if request.body().len() > if request.uri().path() == "/image-register" { woohaa_media_image::MAX_COMPRESSED_BYTES } else if request.uri().path()=="/editor-blob" { crate::editor_blobs::MAX_BLOB_BYTES } else { MAX_TEXTURE_BYTES } {
                respond(
                    br#"{"ok":false,"error":"Native request exceeds budget"}"#.to_vec(),
                    "application/json",
                );
                return;
            }
            // 资源栏「Pinterest」的内嵌页（见 pinterest_window.rs）。
            //
            // **必须在主线程之外处理**：它要 `add_child` 建子 webview，而 Tauri 文档明确写着
            // Windows 上在同步命令/事件处理器（= 主线程）里创建 webview 会死锁
            // （https://github.com/tauri-apps/wry/issues/583）。放进下面的 `run_on_main_thread`
            // 就是这样 —— 实测表现为点开 Pinterest 后主窗口网页整个卡死，没有任何报错。
            // 从独立线程调用时 Tauri 会自己把创建动作调度到主线程并等结果，主线程是空闲的。
            //
            // 协议响应器本来就是异步的，可以在任何线程应答。token 与 label 校验已经在上面做过。
            if request.uri().path() == "/pinterest" {
                let app = ctx.app_handle().clone();
                let is_post = request.method() == tauri::http::Method::POST;
                let body = request.body().to_vec();
                std::thread::spawn(move || {
                    let result = if is_post {
                        crate::pinterest_window::control(&app, &body)
                    } else {
                        Err("Pinterest actions require POST".into())
                    };
                    let envelope = match result {
                        Ok(value) => json!({"ok":true,"value":value}),
                        Err(error) => {
                            crate::diagnostics::event("native-bridge", "pinterest-failed", json!({"error":error}));
                            json!({"ok":false,"error":error})
                        }
                    };
                    respond(serde_json::to_vec(&envelope).expect("response JSON"), "application/json");
                });
                return;
            }
            // Pinterest 窗口右键保存：主窗口来取暂存的图（**取走即删**），以及回报结果给 Pinterest 窗口弹提示。
            // 与 `/pinterest` 同一条规则 —— 在 `run_on_main_thread` 之前、独立线程里处理；
            // 这两个不建窗口，但不该占用主线程去拷几 MB 的图片字节。
            // token 与 `webview_label() == "main"` 的校验已经在上面做过：Pinterest 窗口调不了这两条。
            if request.uri().path() == "/pinterest-blob" || request.uri().path() == "/pinterest-result" {
                let app = ctx.app_handle().clone();
                let path = request.uri().path().to_owned();
                let query = request.uri().query().unwrap_or("").to_owned();
                let body = request.body().to_vec();
                std::thread::spawn(move || {
                    if path == "/pinterest-blob" {
                        let id = crate::pinterest_window::query_param(&query, "id");
                        match id.as_deref().and_then(crate::pinterest_save::take) {
                            Some((bytes, mime)) => respond(bytes, mime),
                            None => respond(
                                r#"{"ok":false,"error":"图片已过期或不存在"}"#.as_bytes().to_vec(),
                                "application/json",
                            ),
                        }
                    } else {
                        let envelope = match crate::pinterest_window::report(&app, &body) {
                            Ok(()) => json!({"ok":true}),
                            Err(error) => json!({"ok":false,"error":error}),
                        };
                        respond(serde_json::to_vec(&envelope).expect("response JSON"), "application/json");
                    }
                });
                return;
            }
            // The callback may run on a WebKit IO thread. Queue the request; never
            // touch the App, AppKit views, bridge TLS or query indexes from that thread.
            let reservation = match crate::document_editor::transport::reserve_control(request.body().len()) {
                Ok(reservation) => reservation,
                Err(error) => {
                    respond(serde_json::to_vec(&json!({"ok":false,"error":error.message,"code":error.code})).unwrap(), "application/json");
                    return;
                }
            };
            if request.uri().path()=="/editor-blob" {
                let job:EditorIpcJob=Box::new(move || {
                    let _reservation=reservation;
                    if request.method()==tauri::http::Method::POST {
                        let result=crate::editor_blobs::upload(request.into_body());
                        let envelope=match result {Ok(ticket)=>json!({"ok":true,"value":{"ticket":ticket}}),Err(error)=>json!({"ok":false,"error":error})};
                        respond(serde_json::to_vec(&envelope).unwrap(),"application/json");
                    } else if request.method()==tauri::http::Method::GET {
                        let result=(|| {
                            let uri=tauri::Url::parse(&request.uri().to_string()).map_err(|_|"invalid editor binary URL")?;
                            let ticket=uri.query_pairs().find(|(key,_)|key=="id").map(|(_,value)|value.into_owned()).ok_or("missing editor export ticket")?;
                            if ticket.len()>64 {return Err("invalid editor export ticket".to_string());}
                            crate::editor_blobs::download(&ticket)
                        })();
                        match result {
                            Ok(receipt)=>if let Ok(crate::document_editor::OperationResult::Exported {bytes,..})=&receipt.result { respond(bytes.clone(),"application/octet-stream"); },
                            Err(error)=>respond(serde_json::to_vec(&json!({"ok":false,"error":error})).unwrap(),"application/json"),
                        }
                    } else if request.method()==tauri::http::Method::DELETE {
                        let result=(|| {
                            let uri=tauri::Url::parse(&request.uri().to_string()).map_err(|_|"invalid editor binary URL")?;
                            let ticket=uri.query_pairs().find(|(key,_)|key=="id").map(|(_,value)|value.into_owned()).ok_or("missing editor upload ticket")?;
                            if ticket.len()>64 {return Err("invalid editor upload ticket");}
                            crate::editor_blobs::admitted(&ticket);
                            Ok(())
                        })();
                        let value=match result {Ok(())=>json!({"ok":true}),Err(error)=>json!({"ok":false,"error":error})};
                        respond(serde_json::to_vec(&value).unwrap(),"application/json");
                    } else {respond(br#"{"ok":false,"error":"Editor binary transfer requires POST, GET or DELETE"}"#.to_vec(),"application/json");}
                });
                if let Err(std::sync::mpsc::TrySendError::Full(job) | std::sync::mpsc::TrySendError::Disconnected(job))=editor_ipc_workers().try_send(job) {std::thread::spawn(job);}
                return;
            }
            if request.uri().path() == "/editor-rpc" {
                let app=ctx.app_handle().clone();
                let reservation=std::sync::Arc::new(reservation);
                let job: EditorIpcJob=Box::new(move || {
                    let _reservation=reservation.clone();
                    let prepared=(|| {
                        if request.method()!=tauri::http::Method::POST { return Err("Editor RPC requires POST".into()); }
                        let request:Request=serde_json::from_slice(request.body()).map_err(|e|e.to_string())?;
                        crate::editor_runtime::prepare(&request.method,request.args.first().and_then(Value::as_str))
                    })();
                    // Release the raw JSON before queueing the decoded request.
                    drop(request);
                    let result=match prepared {
                        Err(error)=>Err(error),
                        Ok(prepared)=>{
                            let upload=match &prepared {crate::editor_runtime::PreparedControl::Enqueue(_,upload)=>upload.clone(),_=>None};
                            let (tx,rx)=std::sync::mpsc::sync_channel(1);
                            let held=reservation.clone();
                            let queued=std::time::Instant::now();
                            let result=match app.run_on_main_thread(move || {
                                crate::metrics::sample("native_editor.control_dispatch_ms",queued.elapsed());
                                crate::performance_capture::native_span("control-dispatch",queued.elapsed(),None);
                                let _held=held;
                                let _=tx.send(crate::editor_runtime::control_prepared(prepared));
                            }) {
                                Ok(())=>rx.recv().unwrap_or_else(|_|Err("Editor owner disconnected".into())),
                                Err(_)=>Err("Editor owner unavailable".into()),
                            };
                            if result.is_ok() {if let Some(ticket)=upload {crate::editor_blobs::admitted(&ticket);}}
                            result
                        }
                    };
                    respond(editor_ipc_envelope(result),"application/json");
                });
                // The reservation also bounds the rare fallback if the worker queue is unavailable.
                if let Err(std::sync::mpsc::TrySendError::Full(job) | std::sync::mpsc::TrySendError::Disconnected(job))=editor_ipc_workers().try_send(job) {
                    // Reservation still bounds this fallback; parsing never runs on the caller.
                    std::thread::spawn(job);
                }
                return;
            }
            let queued = std::time::Instant::now();
            let app = ctx.app_handle().clone();
            let _ = ctx.app_handle().run_on_main_thread(move || {
                let _reservation = reservation;
                crate::metrics::sample("rpc.dispatch_wait_ms", queued.elapsed());
                let service = std::time::Instant::now();
                let uri = tauri::Url::parse(&request.uri().to_string()).expect("scheme URL");
                let params: std::collections::HashMap<_, _> = uri
                    .query_pairs()
                    .map(|(k, v)| (k.into_owned(), v.into_owned()))
                    .collect();
                if uri.path() == "/capture" {
                    let id = params
                        .get("requestId")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0.0);
                    let generation = params
                        .get("generation")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0.0);
                    respond(capture(id, generation), "application/octet-stream");
                    return;
                }
                let result = if uri.path() == "/window" {
                    if request.method() != tauri::http::Method::POST {
                        Err("Window actions require POST".into())
                    } else {
                        app.get_webview_window("main")
                            .ok_or_else(|| "Desktop window unavailable".to_owned())
                            .and_then(|window| {
                                crate::window_controls::control(&window, request.body())
                            })
                    }
                } else if uri.path() == "/image-register" {
                    let edge = params.get("edge").and_then(|v|v.parse().ok()).unwrap_or(1024);
                    woohaa_media_image::jobs::native_jobs().register(request.into_body(), edge).map(|handle| json!({"handle":handle}))
                } else if uri.path() == "/image-poll" {
                    let handle = params.get("handle").map(String::as_str).unwrap_or("");
                    woohaa_media_image::jobs::native_jobs().poll(handle).map(|s| match s {
                        woohaa_media_image::jobs::Snapshot::Pending => json!({"status":"pending"}),
                        woohaa_media_image::jobs::Snapshot::Draining => json!({"status":"draining"}),
                        woohaa_media_image::jobs::Snapshot::Released => json!({"status":"released"}),
                        woohaa_media_image::jobs::Snapshot::Failed(error) => json!({"status":"failed","error":error}),
                        woohaa_media_image::jobs::Snapshot::Ready { width,height,source_width,source_height } => json!({"status":"ready","width":width,"height":height,"sourceWidth":source_width,"sourceHeight":source_height}),
                    })
                } else if uri.path() == "/image-release" {
                    let handle = params.get("handle").map(String::as_str).unwrap_or("");
                    let draining = woohaa_media_image::jobs::native_jobs().release(handle);
                    Ok(json!({"draining":draining}))
                } else if uri.path() == "/image-apply" {
                    let handle = params.get("handle").map(String::as_str).unwrap_or("");
                    let id = params.get("id").map(String::as_str).unwrap_or("");
                    let content = params.get("content").map(String::as_str).unwrap_or("");
                    if id.is_empty() || id.len()>256 || content.len()>4096 {
                        return respond(br#"{"ok":false,"error":"Invalid native image target"}"#.to_vec(), "application/json");
                    }
                    woohaa_media_image::jobs::native_jobs().image(handle).and_then(|image| {
                        if params.get("plane").is_some_and(|v|v=="1") {
                            canvas::set_model_media_texture_owned(id,image.width,image.height,image.pixels()).map_err(|e|e.to_string())
                        } else {
                            canvas::set_texture_owned(id,image.width,image.height,image.pixels(),content).map_err(|e|e.to_string())
                        }
                    }).map(|_|Value::Null)
                } else if uri.path() == "/texture" {
                    texture(
                        params.get("meta").map(String::as_str).unwrap_or(""),
                        request.into_body(),
                    )
                    .map(|_| Value::Null)
                } else {
                    control(request.body())
                };
                let envelope = match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => {
                        crate::shell_log::warn(&format!(
                            "native bridge request failed: {}",
                            crate::shell_log::clip(&error, 240)
                        ));
                        crate::diagnostics::event("native-bridge","request-failed",json!({"error":&error}));
                        json!({"ok":false,"error":error})
                    },
                };
                crate::metrics::sample("rpc.service_ms", service.elapsed());
                respond(
                    serde_json::to_vec(&envelope).expect("response JSON"),
                    "application/json",
                );
            });
        },
    )
}
