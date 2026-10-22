//! Native boundary for the existing synchronous renderer facade.
//! All state access is dispatched onto the Tauri main thread. Texture bodies are
//! bounded raw bytes, never JSON pixel arrays. This development bridge preserves
//! exact query coordinates while the controller still uses synchronous queries.
use crate::notifications;
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::Manager;
use woohaa_bevy_canvas as canvas;

const MAX_CONTROL_BYTES: usize = 8 * 1024 * 1024;
const MAX_TEXTURE_BYTES: usize = 2048 * 2048 * 4;
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
        assert!(texture(r#"{"id":"a","width":2,"height":2,"plane":false}"#, &[0; 4]).is_err());
        assert!(texture(r#"{"id":"","width":1,"height":1,"plane":false}"#, &[0; 4]).is_err());
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
    let result = match req.method.as_str() {
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
        "query_point_hit" => json!(canvas::query_point_hit(arg(&req, 0)?)),
        "query_marquee" => json!(canvas::query_marquee(arg(&req, 0)?)),
        "query_probe" => json!(canvas::query_probe(arg(&req, 0)?)),
        "query_drop_target" => json!(canvas::query_drop_target(arg(&req, 0)?)),
        "query_composite_asset_scopes" => {
            json!(canvas::query_composite_asset_scopes(arg(&req, 0)?))
        }
        "query_model_pick" => json!(canvas::query_model_pick(arg(&req, 0)?)),
        "query_composite_asset_item_pick" => {
            json!(canvas::query_composite_asset_item_pick(arg(&req, 0)?))
        }
        "query_composite_asset_item_bounds" => {
            json!(canvas::query_composite_asset_item_bounds(arg(&req, 0)?))
        }
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
    Ok(result)
}

pub fn texture(header: &str, bytes: &[u8]) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Texture {
        id: String,
        width: u32,
        height: u32,
        plane: bool,
    }
    if bytes.len() > MAX_TEXTURE_BYTES {
        return Err("Texture payload exceeds budget".into());
    }
    let meta: Texture = serde_json::from_str(header).map_err(|e| e.to_string())?;
    if meta.id.is_empty() || meta.id.len() > 1024 {
        return Err("Invalid texture id".into());
    }
    let result = if meta.plane {
        canvas::set_model_media_texture(&meta.id, meta.width, meta.height, bytes)
    } else {
        canvas::set_texture(&meta.id, meta.width, meta.height, bytes)
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
                        .header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
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
            if request.body().len() > MAX_TEXTURE_BYTES {
                respond(
                    br#"{"ok":false,"error":"Native request exceeds budget"}"#.to_vec(),
                    "application/json",
                );
                return;
            }
            // The callback may run on a WebKit IO thread. Queue the request; never
            // touch the App, AppKit views, bridge TLS or query indexes from that thread.
            let queued = std::time::Instant::now();
            let app = ctx.app_handle().clone();
            let _ = ctx.app_handle().run_on_main_thread(move || {
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
                } else if uri.path() == "/texture" {
                    texture(
                        params.get("meta").map(String::as_str).unwrap_or(""),
                        request.body(),
                    )
                    .map(|_| Value::Null)
                } else {
                    control(request.body())
                };
                let envelope = match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
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
