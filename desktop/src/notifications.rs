//! 系统通知能力（change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.1/8.2 / design D9）。
//!
//! 通过**既有受 token/来源限制**的 `woohaa-native` 协议暴露最小操作：
//! - `notification_capability`：独立版本的能力标识（不靠 UA/窗口能力推断）；
//! - `notification_permission`：查询真实权限（不触发申请）；
//! - `notification_request_permission`：**仅用户主动开启时**由前端调用；
//! - `notification_show`：发送业务通知或测试通知。
//!
//! 硬约束：
//! - 不开放通用 IPC，也不让 native 层成为任务状态源；
//! - 请求字段白名单 + 长度预算；只允许安全摘要与稳定任务目标，
//!   拒绝任意 URL、完整 prompt、凭据与媒体字节；
//! - 失败返回安全错误，不改写任务事实，也不自动重试成通知风暴。

use serde::{Deserialize, Serialize};

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;

/// 通知能力版本（与该协议其它能力一样独立演进）。
pub const NOTIFICATION_CAPABILITY_VERSION: u64 = 1;

/// 单个通知请求的字节上限（远小于通用控制请求预算）。
pub const NOTIFICATION_BUDGET_BYTES: usize = 2 * 1024;
/// 标题/正文长度上限。
pub const NOTIFICATION_TITLE_MAX: usize = 120;
pub const NOTIFICATION_BODY_MAX: usize = 240;
/// 单次批量计数的上限（超出视为异常请求）。
pub const NOTIFICATION_COUNT_MAX: u32 = 999;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotificationCapability {
    pub version: u64,
    /// 是否支持点击回调定位任务历史（按平台真实能力，不夸称）。
    pub click_restore: bool,
    pub platforms: &'static [&'static str],
}

pub fn capability() -> NotificationCapability {
    NotificationCapability {
        version: NOTIFICATION_CAPABILITY_VERSION,
        // 任务 8.4：桌面 sink 注册插件 `on_action` 点击回调（macOS/Windows 走
        // `wait_for_response`，Linux 走通知服务器信号），点击后恢复/聚焦窗口并回传稳定目标。
        click_restore: true,
        platforms: &["linux", "macos", "windows"],
    }
}

/// 点击目标在通知 `extra` 里的键。插件把自身元数据原样带回 `on_action`，
/// 不经过 OS 载荷，因此这里只放已校验的稳定身份。
const CLICK_EXTRA_KEY: &str = "woohaa";

/// 一次点击的稳定语义：测试通知不导航；合并通知无单任务目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationClick {
    pub test: bool,
    pub target: Option<NotificationTarget>,
}

/// 目标必须整份通过稳定 ID 校验；未知字段/URL/超长一律降级为「无目标」。
fn valid_target(target: &NotificationTarget) -> bool {
    is_stable_id(&target.task_key)
        && [target.canvas_id.as_deref(), target.node_id.as_deref()]
            .into_iter()
            .flatten()
            .all(is_stable_id)
}

/// 写入通知元数据（插件回传，不进入 OS 载荷）。
pub fn click_extra(content: &NotificationContent) -> serde_json::Value {
    serde_json::json!({ "test": content.test, "target": content.target })
}

/// 解析点击元数据：缺失/非法都退化为「无目标」，绝不猜测归属。
pub fn decode_click(extra: Option<&serde_json::Value>) -> NotificationClick {
    let test = extra
        .and_then(|value| value.get("test"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let target = extra
        .and_then(|value| value.get("target"))
        .and_then(|value| serde_json::from_value::<NotificationTarget>(value.clone()).ok())
        .filter(valid_target);
    NotificationClick { test, target }
}

/// 待前端消费的点击（进程内单例；只保存最近一次点击的稳定身份）。
static PENDING_CLICK: std::sync::Mutex<Option<NotificationClick>> = std::sync::Mutex::new(None);

pub fn record_click(click: NotificationClick) {
    if let Ok(mut slot) = PENDING_CLICK.lock() {
        *slot = Some(click);
    }
}

/// 前端在窗口重新获得焦点时取一次；取走即清空，避免重复导航。
pub fn take_pending_click() -> serde_json::Value {
    let click = PENDING_CLICK.lock().ok().and_then(|mut slot| slot.take());
    match click {
        Some(click) => serde_json::json!({
            "clicked": true,
            "test": click.test,
            "target": click.target,
        }),
        None => serde_json::json!({ "clicked": false, "test": false, "target": null }),
    }
}

/// 稳定任务目标：只有身份，没有 prompt/参数/媒体/任意外部地址。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NotificationTarget {
    pub task_key: String,
    #[serde(default)]
    pub canvas_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct NotificationRequest {
    /// 业务通知或用户主动测试（测试不写入任务事实）。
    #[serde(default)]
    pub test: bool,
    #[serde(default)]
    pub succeeded: u32,
    #[serde(default)]
    pub failed: u32,
    #[serde(default)]
    pub target: Option<NotificationTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotificationError {
    /// 请求体超出预算。
    BudgetExceeded,
    /// 字段非法/未知字段/可疑载荷。
    InvalidRequest(String),
    /// 平台不支持或插件不可用。
    Unsupported(String),
    /// 权限未授予。
    PermissionDenied,
    /// 发送失败（安全文案）。
    DeliveryFailed(String),
}

impl NotificationError {
    pub fn message(&self) -> String {
        match self {
            Self::BudgetExceeded => "Native notification request exceeds budget".into(),
            Self::InvalidRequest(detail) => format!("Invalid native notification request: {detail}"),
            Self::Unsupported(detail) => format!("Native notifications unsupported: {detail}"),
            Self::PermissionDenied => "Native notification permission denied".into(),
            Self::DeliveryFailed(detail) => format!("Native notification delivery failed: {detail}"),
        }
    }
}

/// 是否像 URL/外部地址（拒绝任意跳转）。
fn looks_like_url(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.contains("://")
        || lowered.starts_with("//")
        || lowered.starts_with("www.")
        || lowered.starts_with("javascript:")
        || lowered.starts_with("data:")
}

/// 目标只允许稳定 ID 形状（无空白、无 URL 特征、有长度上界）。
fn is_stable_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// 解析并校验请求：先预算，再字段白名单，最后语义约束。
pub fn decode_request(body: &[u8]) -> Result<NotificationRequest, NotificationError> {
    if body.len() > NOTIFICATION_BUDGET_BYTES {
        return Err(NotificationError::BudgetExceeded);
    }
    let request: NotificationRequest = serde_json::from_slice(body)
        .map_err(|error| NotificationError::InvalidRequest(error.to_string()))?;
    if request.succeeded > NOTIFICATION_COUNT_MAX || request.failed > NOTIFICATION_COUNT_MAX {
        return Err(NotificationError::InvalidRequest("count out of range".into()));
    }
    if request.target.is_some() && (request.succeeded + request.failed) > 1 {
        // 合并通知不带单任务目标，避免把批量结果错误归到某一任务。
        return Err(NotificationError::InvalidRequest(
            "merged notifications must not carry a target".into(),
        ));
    }
    if let Some(target) = &request.target {
        if !is_stable_id(&target.task_key) {
            return Err(NotificationError::InvalidRequest("invalid task target".into()));
        }
        for value in [target.canvas_id.as_deref(), target.node_id.as_deref()].into_iter().flatten() {
            if !is_stable_id(value) {
                return Err(NotificationError::InvalidRequest("invalid target identity".into()));
            }
        }
    }
    if request.test && request.target.is_some() {
        return Err(NotificationError::InvalidRequest(
            "test notification must not carry a task target".into(),
        ));
    }
    Ok(request)
}

/// 已校验、可直接交给平台层的内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationContent {
    pub title: String,
    pub body: String,
    pub test: bool,
    pub target: Option<NotificationTarget>,
}

/// 渲染最终文案：合并保留失败数，不暴露任务内容。
pub fn render_content(request: &NotificationRequest) -> NotificationContent {
    let title = if request.test {
        "测试通知".to_string()
    } else if request.failed > 0 {
        format!(
            "{} 项任务完成，{} 项失败",
            request.succeeded, request.failed
        )
    } else {
        format!("{} 项任务完成", request.succeeded)
    };
    let body = if request.test {
        "这是来自设置的通知测试，不会写入任务历史。".to_string()
    } else if let Some(target) = &request.target {
        format!("任务 {} 已完成。", target.task_key)
    } else {
        "点击查看任务历史。".to_string()
    };
    let title = clip(title, NOTIFICATION_TITLE_MAX);
    let body = clip(body, NOTIFICATION_BODY_MAX);
    NotificationContent {
        title,
        body,
        test: request.test,
        target: request.target.clone(),
    }
}

fn clip(value: String, max: usize) -> String {
    if value.chars().count() <= max {
        return value;
    }
    value.chars().take(max).collect()
}

/// 平台发送端口（测试可注入替身；生产由 notification 插件实现）。
pub trait NotificationSink {
    fn permission(&self) -> NotificationPermissionState;
    fn request_permission(&mut self) -> NotificationPermissionState;
    fn send(&mut self, content: &NotificationContent) -> Result<(), NotificationError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationPermissionState {
    Unknown,
    Prompt,
    Granted,
    Denied,
    Unsupported,
}

impl NotificationPermissionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::Prompt => "prompt",
            Self::Granted => "granted",
            Self::Denied => "denied",
            Self::Unsupported => "unsupported",
        }
    }
}

/// 完整的处理入口：前端只可能经此路径触发发送。
pub fn handle(
    sink: &mut dyn NotificationSink,
    body: &[u8],
) -> Result<serde_json::Value, NotificationError> {
    let request = decode_request(body)?;
    if sink.permission() != NotificationPermissionState::Granted {
        return Err(NotificationError::PermissionDenied);
    }
    let content = render_content(&request);
    sink.send(&content)?;
    Ok(serde_json::json!({
        "delivered": true,
        "test": content.test,
        // 只回稳定目标，便于前端定位；不含标题正文以外的信息。
        "target": content.target,
    }))
}

/// 权限查询（不触发申请）。
pub fn permission_value(sink: &dyn NotificationSink) -> serde_json::Value {
    serde_json::json!({
        "version": NOTIFICATION_CAPABILITY_VERSION,
        "permission": sink.permission().as_str(),
    })
}

/// 用户主动申请。
pub fn request_permission_value(sink: &mut dyn NotificationSink) -> serde_json::Value {
    let state = sink.request_permission();
    serde_json::json!({
        "version": NOTIFICATION_CAPABILITY_VERSION,
        "permission": state.as_str(),
    })
}

/// 判断一段文本是否像外部地址（供前端/诊断复用；纯函数）。
pub fn is_external_url(value: &str) -> bool {
    looks_like_url(value)
}

// ---------------------------------------------------------------------------
// 生产 sink（tauri-plugin-notification）
// ---------------------------------------------------------------------------

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod platform {
    use super::{
        NotificationContent, NotificationError, NotificationPermissionState, NotificationSink,
    };
    use tauri_plugin_notification::NotificationExt;

    /// 插件 sink：所有调用都经 `tauri-plugin-notification` 的 Rust API。
    ///
    /// 不通过 JS 插件权限，因此前端无法绕过本模块的字段校验与预算。
    pub struct PluginSink {
        app: tauri::AppHandle,
    }

    impl PluginSink {
        pub fn new(app: tauri::AppHandle) -> Self {
            Self { app }
        }

        fn map_permission(
            state: &tauri_plugin_notification::PermissionState,
        ) -> NotificationPermissionState {
            use tauri_plugin_notification::PermissionState as P;
            match state {
                P::Granted => NotificationPermissionState::Granted,
                P::Denied => NotificationPermissionState::Denied,
                P::Prompt => NotificationPermissionState::Prompt,
                // PromptWithRationale 也是「尚未决定」，按 Prompt 处理，不夸大权限状态。
                P::PromptWithRationale => NotificationPermissionState::Prompt,
            }
        }
    }

    impl NotificationSink for PluginSink {
        fn permission(&self) -> NotificationPermissionState {
            match self.app.notification().permission_state() {
                Ok(state) => Self::map_permission(&state),
                // 查询失败不能当作已授权。
                Err(_) => NotificationPermissionState::Unsupported,
            }
        }

        fn request_permission(&mut self) -> NotificationPermissionState {
            match self.app.notification().request_permission() {
                Ok(state) => Self::map_permission(&state),
                Err(_) => NotificationPermissionState::Unsupported,
            }
        }

        fn send(&mut self, content: &NotificationContent) -> Result<(), NotificationError> {
            self.app
                .notification()
                .builder()
                .title(content.title.clone())
                .body(content.body.clone())
                // 任务 8.4：把稳定目标写进插件元数据，点击回调原样带回。
                .extra(super::CLICK_EXTRA_KEY, super::click_extra(content))
                .show()
                .map_err(|error| NotificationError::DeliveryFailed(error.to_string()))
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub use platform::PluginSink;

/// 全局 sink 持有者（进程内单例；native 层只做转发，不保存任务状态）。
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod registry {
    use super::{NotificationContent, NotificationError, NotificationSink};
    use std::sync::Mutex;

    static SINK: Mutex<Option<Box<dyn NotificationSink + Send>>> = Mutex::new(None);

    pub fn install(sink: Box<dyn NotificationSink + Send>) {
        if let Ok(mut slot) = SINK.lock() {
            *slot = Some(sink);
        }
    }

    /// 未安装（非桌面/插件缺失）时退化为「不支持」，不伪造权限。
    struct Unavailable;

    impl NotificationSink for Unavailable {
        fn permission(&self) -> super::NotificationPermissionState {
            super::NotificationPermissionState::Unsupported
        }
        fn request_permission(&mut self) -> super::NotificationPermissionState {
            super::NotificationPermissionState::Unsupported
        }
        fn send(&mut self, _content: &NotificationContent) -> Result<(), NotificationError> {
            Err(NotificationError::Unsupported("notification sink 未安装".into()))
        }
    }

    pub fn with<R>(f: impl FnOnce(&mut dyn NotificationSink) -> R) -> R {
        match SINK.lock() {
            Ok(mut slot) => match slot.as_deref_mut() {
                Some(sink) => f(sink),
                None => f(&mut Unavailable),
            },
            // 锁中毒：退化为不支持，绝不 panic 到协议线程。
            Err(_) => f(&mut Unavailable),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn install_plugin_sink(app: tauri::AppHandle) {
    registry::install(Box::new(PluginSink::new(app.clone())));
    // 任务 8.4：注册点击回调。插件只有在存在监听者时才会上报点击
    // （macOS/Windows 用 `wait_for_response`，Linux 用通知服务器信号），
    // 因此这里注册后能力才真正成立。回调在后台线程运行。
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if !matches!(performed.action_id(), "tap" | "default") {
            return;
        }
        let click = decode_click(
            performed
                .notification()
                .and_then(|notification| notification.extra().get(CLICK_EXTRA_KEY)),
        );
        record_click(click);
        focus_main_window(handle.clone());
    });
}

/// 去掉最小化并聚焦主窗口。回调线程不能直接碰窗口，统一回主线程执行。
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn focus_main_window(app: tauri::AppHandle) {
    use tauri::Manager;
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    });
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn sink<R>(f: impl FnOnce(&mut dyn NotificationSink) -> R) -> R {
    registry::with(f)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeSink {
        permission: NotificationPermissionState,
        sent: Vec<NotificationContent>,
    }

    impl FakeSink {
        fn new(permission: NotificationPermissionState) -> Self {
            Self { permission, sent: Vec::new() }
        }
    }

    impl NotificationSink for FakeSink {
        fn permission(&self) -> NotificationPermissionState {
            self.permission
        }
        fn request_permission(&mut self) -> NotificationPermissionState {
            self.permission = NotificationPermissionState::Granted;
            self.permission
        }
        fn send(&mut self, content: &NotificationContent) -> Result<(), NotificationError> {
            self.sent.push(content.clone());
            Ok(())
        }
    }

    #[test]
    fn capability_is_versioned_and_claims_click_only_where_implemented() {
        let capability = capability();
        assert_eq!(capability.version, NOTIFICATION_CAPABILITY_VERSION);
        // 任务 8.4 已接入插件点击回调，能力必须与实际实现一致。
        assert!(capability.click_restore);
        assert_eq!(capability.platforms, &["linux", "macos", "windows"]);
    }

    #[test]
    fn click_extra_round_trips_stable_target_only() {
        let request = decode_request(br#"{"succeeded":1,"target":{"task_key":"t1","canvas_id":"c1"}}"#)
            .expect("valid");
        let content = render_content(&request);
        let click = decode_click(Some(&click_extra(&content)));
        assert!(!click.test);
        assert_eq!(click.target.map(|target| target.task_key), Some("t1".into()));

        // 合并通知没有单任务目标，点击落到历史列表。
        let merged = render_content(&decode_request(br#"{"succeeded":2,"failed":1}"#).expect("valid"));
        assert_eq!(decode_click(Some(&click_extra(&merged))), NotificationClick { test: false, target: None });

        // 测试通知被标记，点击不导航。
        let test = render_content(&decode_request(br#"{"test":true}"#).expect("valid"));
        assert_eq!(decode_click(Some(&click_extra(&test))), NotificationClick { test: true, target: None });
    }

    #[test]
    fn click_metadata_with_url_or_unknown_fields_degrades_to_no_target() {
        let url = serde_json::json!({ "test": false, "target": { "task_key": "https://evil.example/x" } });
        assert_eq!(decode_click(Some(&url)).target, None);
        let unknown = serde_json::json!({ "test": false, "target": { "task_key": "t1", "url": "https://evil.example" } });
        assert_eq!(decode_click(Some(&unknown)).target, None);
        // 缺失/非对象一律无目标。
        assert_eq!(decode_click(None).target, None);
        assert_eq!(decode_click(Some(&serde_json::json!("nope"))).target, None);
    }

    #[test]
    fn pending_click_is_taken_once() {
        // 没有点击时明确为 false，前端不会误导航。
        let idle = take_pending_click();
        assert_eq!(idle["clicked"], serde_json::json!(false));
        record_click(NotificationClick {
            test: false,
            target: Some(NotificationTarget { task_key: "t1".into(), canvas_id: Some("c1".into()), node_id: None }),
        });
        let taken = take_pending_click();
        assert_eq!(taken["clicked"], serde_json::json!(true));
        assert_eq!(taken["target"]["task_key"], serde_json::json!("t1"));
        // 取走即清空。
        assert_eq!(take_pending_click()["clicked"], serde_json::json!(false));
    }

    #[test]
    fn rejects_oversized_budget_and_unknown_fields() {
        let oversized = vec![b' '; NOTIFICATION_BUDGET_BYTES + 1];
        assert_eq!(decode_request(&oversized), Err(NotificationError::BudgetExceeded));

        let unknown = br#"{"succeeded":1,"url":"https://evil.example"}"#;
        assert!(matches!(decode_request(unknown), Err(NotificationError::InvalidRequest(_))));
    }

    #[test]
    fn rejects_arbitrary_url_and_credential_like_targets() {
        // 目标里的 URL 特征被拒。
        let url_target = br#"{"succeeded":1,"target":{"task_key":"https://evil.example/x"}}"#;
        assert!(matches!(decode_request(url_target), Err(NotificationError::InvalidRequest(_))));
        // 过长/含空白的 ID 被拒。
        let spaced = br#"{"succeeded":1,"target":{"task_key":"task key with spaces"}}"#;
        assert!(matches!(decode_request(spaced), Err(NotificationError::InvalidRequest(_))));
    }

    #[test]
    fn merged_notifications_must_not_target_a_single_task() {
        let merged = br#"{"succeeded":2,"failed":1,"target":{"task_key":"t1"}}"#;
        assert!(matches!(decode_request(merged), Err(NotificationError::InvalidRequest(_))));
        // 单任务可以带目标。
        let single = br#"{"succeeded":1,"target":{"task_key":"t1","canvas_id":"c1","node_id":"n1"}}"#;
        assert!(decode_request(single).is_ok());
    }

    #[test]
    fn test_notification_cannot_carry_task_target() {
        let request = br#"{"test":true,"target":{"task_key":"t1"}}"#;
        assert!(matches!(decode_request(request), Err(NotificationError::InvalidRequest(_))));
    }

    #[test]
    fn rendering_keeps_failed_count_and_hides_prompt_content() {
        let request = decode_request(br#"{"succeeded":3,"failed":1}"#).expect("valid");
        let content = render_content(&request);
        assert!(content.title.contains("3"));
        assert!(content.title.contains("1"));
        assert!(content.body.contains("任务历史"));
        // 只包含计数与稳定身份，不含任意内容。
        assert!(!content.body.contains("prompt"));
    }

    #[test]
    fn denies_send_without_permission_and_does_not_send() {
        let mut sink = FakeSink::new(NotificationPermissionState::Denied);
        let result = handle(&mut sink, br#"{"succeeded":1}"#);
        assert_eq!(result, Err(NotificationError::PermissionDenied));
        assert!(sink.sent.is_empty());
    }

    #[test]
    fn sends_when_permission_granted_and_returns_stable_target() {
        let mut sink = FakeSink::new(NotificationPermissionState::Granted);
        let result = handle(
            &mut sink,
            br#"{"succeeded":1,"target":{"task_key":"t1","canvas_id":"c1"}}"#,
        )
        .expect("sent");
        assert_eq!(sink.sent.len(), 1);
        assert_eq!(sink.sent[0].test, false);
        assert_eq!(result["delivered"], serde_json::json!(true));
        assert_eq!(result["target"]["task_key"], serde_json::json!("t1"));
    }

    #[test]
    fn test_notification_is_labelled_and_allowed_in_foreground() {
        let mut sink = FakeSink::new(NotificationPermissionState::Granted);
        let result = handle(&mut sink, br#"{"test":true}"#).expect("sent");
        assert_eq!(sink.sent[0].title, "测试通知");
        assert_eq!(result["test"], serde_json::json!(true));
    }

    #[test]
    fn permission_query_does_not_request() {
        let mut sink = FakeSink::new(NotificationPermissionState::Prompt);
        let value = permission_value(&sink);
        assert_eq!(value["permission"], serde_json::json!("prompt"));
        // 查询不改状态。
        assert_eq!(sink.permission(), NotificationPermissionState::Prompt);
        let requested = request_permission_value(&mut sink);
        assert_eq!(requested["permission"], serde_json::json!("granted"));
    }

    #[test]
    fn url_detection_helper() {
        assert!(is_external_url("https://evil.example"));
        assert!(is_external_url("javascript:alert(1)"));
        assert!(is_external_url("data:text/html,x"));
        assert!(!is_external_url("task-1"));
    }
}
