//! Tauri 独占窗口/OS loop 的最小宿主原型
//! （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，design D2，任务 1.4 / 1.5 / 2.2）。
//!
//! 装配顺序（P0 只固定骨架）：
//! 1. `tauri::Builder` 建立 Tauri 窗口与 GTK OS 事件循环；
//! 2. `setup` 中取得窗口真实句柄（`raw-window-handle 0.6`）；
//! 3. 创建 `CanvasRuntimeHost` 实例并 build native 画布 App（不调用 `App::run()`）；
//! 4. Tauri 事件循环收到 `RunEvent::MainEventsCleared` 时投递一次**可取消 tick**，
//!    由宿主串行消费；最多一个未消费 tick（design D2）。
//!
//! 两种形态（design D1 / D8）：
//! - `OverlayHost`：透明 WebView 覆盖下层 native 画面（目标形态）；
//! - `NativeOnlyHost`：不创建 WebView，只保留 native 画布窗口（截帧调试入口）。
//!
//! 透明 WebView 与下层 native view 的同窗口合成、输入/IME、DPI、截帧属于 P1 真机门槛
//! （见 `notes/prototype-gate.md`），本机不采集。`--probe` 路径只报告环境事实。

use crate::lifecycle::{CanvasRuntimeHost, InstanceId};
use crate::native_canvas::{BevyCanvasBackend, NativeCanvasOptions};
use crate::view::{CompositionMode, ViewBounds};

/// 宿主配置。
#[derive(Clone, Debug)]
pub struct HostConfig {
    pub mode: CompositionMode,
    pub title: String,
    pub width: u32,
    pub height: u32,
}

impl HostConfig {
    /// overlay 形态：透明 WebView + 下层 native。
    pub fn overlay() -> Self {
        Self {
            mode: CompositionMode::Overlay,
            title: "WooHaa3".into(),
            width: 1280,
            height: 720,
        }
    }

    /// 关闭 WebView 的独立 native 画布形态。
    pub fn native_only() -> Self {
        Self {
            mode: CompositionMode::NativeOnly,
            title: "Woohaa native 画布".into(),
            width: 1280,
            height: 720,
        }
    }
}

impl Default for HostConfig {
    fn default() -> Self {
        Self::overlay()
    }
}

/// 已装配的 native 画布会话（持有实例与后端，绑定到唯一线程）。
///
/// 本结构不实现 `Send`：App/window handle 必须留在创建它的线程（design D2）。
pub struct NativeCanvasSession {
    host: CanvasRuntimeHost,
    instance: InstanceId,
    bounds: ViewBounds,
}

impl NativeCanvasSession {
    /// 创建 App 并初始化实例（build → finish → cleanup）。
    pub fn build(
        config: &HostConfig,
        handle: Option<bevy::window::RawHandleWrapper>,
    ) -> Result<Self, String> {
        let backend = BevyCanvasBackend::new(NativeCanvasOptions {
            width: config.width,
            height: config.height,
            scale_factor: 1.0,
            window_handle: handle,
        });
        Self::from_backend(config, Box::new(backend))
    }

    /// 以任意 [`crate::lifecycle::FrameBackend`] 装配会话；供无 GPU 的生命周期测试使用。
    pub fn from_backend(
        config: &HostConfig,
        backend: Box<dyn crate::lifecycle::FrameBackend>,
    ) -> Result<Self, String> {
        let mut host = CanvasRuntimeHost::new();
        let instance = host.create_instance(backend)?;
        host.resize(instance, config.width, config.height);
        Ok(Self {
            host,
            instance,
            bounds: ViewBounds::new(0.0, 0.0, config.width as f32, config.height as f32),
        })
    }

    pub fn instance(&self) -> InstanceId {
        self.instance
    }

    pub fn bounds(&self) -> ViewBounds {
        self.bounds
    }

    /// 更新内容矩形（侧栏/DPI 变化；design D5）。
    ///
    /// 零尺寸（最小化/折叠）原样传入，由生命周期停止 surface 提交；窗口分辨率下限由后端负责。
    pub fn set_bounds(&mut self, bounds: ViewBounds, scale: f64) {
        self.bounds = bounds;
        let (width, height) = bounds.physical_size(scale, 8192);
        self.host.resize(self.instance, width, height);
    }

    /// 投递一次 tick（已存在未消费 tick 时合并）。
    pub fn request_tick(&mut self) -> bool {
        self.host.request_tick(self.instance)
    }

    /// 投递并消费一帧（Tauri 在 `MainEventsCleared` 调用）。
    ///
    /// 先投递可取消 tick 再消费，最多一个未消费 tick；窗口事件（resize/close）可在两者之间
    /// 取消 pending tick。零尺寸/关闭中不执行 `update`。
    pub fn pump(&mut self) -> bool {
        self.request_tick();
        self.host.run_once(self.instance)
    }

    /// 关闭并推进 dispose；返回是否已完全销毁。
    pub fn close(&mut self, drain_budget: u32) -> bool {
        self.host.close(self.instance, drain_budget)
    }

    pub fn diagnostics(&self) -> String {
        self.host.diagnostics()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::FrameBackend;
    use std::cell::RefCell;
    use std::rc::Rc;

    struct CountingBackend {
        log: Rc<RefCell<Vec<String>>>,
    }

    impl FrameBackend for CountingBackend {
        fn build(&mut self) -> Result<(), String> {
            self.log.borrow_mut().push("build".into());
            Ok(())
        }
        fn plugins_ready(&mut self) -> bool {
            true
        }
        fn finish_plugins(&mut self) {}
        fn cleanup_plugins(&mut self) {}
        fn update(&mut self) {
            self.log.borrow_mut().push("update".into());
        }
        fn in_flight(&self) -> u32 {
            0
        }
        fn drain_step(&mut self) -> bool {
            true
        }
        fn dispose(&mut self) {
            self.log.borrow_mut().push("dispose".into());
        }
    }

    fn session() -> (NativeCanvasSession, Rc<RefCell<Vec<String>>>) {
        let log = Rc::new(RefCell::new(Vec::new()));
        let config = HostConfig::overlay();
        let session = NativeCanvasSession::from_backend(
            &config,
            Box::new(CountingBackend { log: log.clone() }),
        )
        .expect("session");
        (session, log)
    }

    #[test]
    fn pump_delivers_a_frame_without_external_tick() {
        let (mut session, log) = session();
        assert!(session.pump(), "pump 应投递并消费一帧");
        assert_eq!(log.borrow().as_slice(), ["build", "update"]);
    }

    #[test]
    fn zero_size_pump_does_not_update() {
        let (mut session, log) = session();
        session.set_bounds(ViewBounds::new(0.0, 0.0, 0.0, 480.0), 1.0);
        assert!(!session.pump(), "零尺寸不提交 surface");
        assert!(!log.borrow().iter().any(|event| event == "update"));
    }

    #[test]
    fn close_then_pump_is_noop_and_diagnostics_reports_terminated() {
        let (mut session, log) = session();
        assert!(session.close(4));
        assert!(!session.pump());
        assert!(session.diagnostics().contains("\"liveInstances\":0"));
        assert!(log.borrow().iter().any(|event| event == "dispose"));
    }

    #[test]
    fn bounds_update_rescales_physical_size() {
        let (mut session, _log) = session();
        let bounds = ViewBounds::new(0.0, 0.0, 640.0, 360.0);
        session.set_bounds(bounds, 2.0);
        assert_eq!(session.bounds(), bounds);
        // 物理尺寸 1280x720 不为零，pump 仍可推进。
        assert!(session.pump());
    }
}

/// 启动 overlay 形态 Tauri 宿主。
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn run_host() -> Result<(), String> {
    platform::run(HostConfig::overlay())
}

/// 启动关闭 WebView 的 native 画布宿主。
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn run_native_only_host() -> Result<(), String> {
    platform::run(HostConfig::native_only())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn run_host() -> Result<(), String> {
    Err("desktop host prototype currently targets Linux, macOS and Windows only".to_owned())
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn run_native_only_host() -> Result<(), String> {
    Err("desktop host prototype currently targets Linux, macOS and Windows only".to_owned())
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
mod platform {
    use std::cell::RefCell;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    use super::{HostConfig, NativeCanvasSession};
    use crate::native_canvas::raw_handle_from_window;
    use crate::view::{CompositionFacts, CompositionMode, classify_window_handle};
    use raw_window_handle::HasWindowHandle;
    use tauri::window::WindowBuilder;
    use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

    thread_local! {
        /// App/window handle 必须留在主线程：用 thread_local 独占持有（design D2）。
        static SESSION: RefCell<Option<NativeCanvasSession>> = const { RefCell::new(None) };
        /// setup 阶段填充的合成事实（供退出时打印，不进入权威状态）。
        static FACTS: RefCell<Option<CompositionFacts>> = const { RefCell::new(None) };
    }

    pub fn run(config: HostConfig) -> Result<(), String> {
        crate::metrics::initialize();
        // 上限 1 个未消费 tick（design D2：最多一个）。
        let pending = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let token = uuid::Uuid::new_v4().to_string();
        let args: Vec<String> = std::env::args().collect();
        let ui_url_override = args
            .windows(2)
            .find(|args| args[0] == "--ui-url")
            .map(|args| args[1].clone())
            .or_else(|| std::env::var("WOOHAA_DESKTOP_URL").ok());
        // 允许源取决于最终界面地址：`--ui-url`/环境变量此时已知，打包默认值要等 `setup` 读到
        // bundle 资源才确定，因此使用 RwLock，允许宿主恢复后更新 loopback origin。
        let origin = std::sync::Arc::new(std::sync::RwLock::new(String::from("tauri://localhost")));
        let bootstrap = format!(
            "window.__WOOHAA_NATIVE__ = {{ token: {0}, protocol: 'woohaa-native-v1', viewportAsync: true, platform: {1}, diagnosticsVerbose: {2} }};\
             window.__WOOHAA_DESKTOP__ = {{ token: {0}, protocol: 'woohaa-window-v1', platform: {1} }};",
            serde_json::to_string(&token).unwrap(),
            serde_json::to_string(std::env::consts::OS).unwrap(),
            std::env::var("WOOHAA_DIAGNOSTICS_VERBOSE").as_deref() == Ok("1"),
        );
        let bootstrap = format!("{}\n{}", bootstrap, include_str!("webview-diagnostics.js"));
        // 系统通知（change: 2026-10-17-move-settings-into-canvas-dialog，任务 8.1）：
        // 注册插件并在 setup 时安装受控 sink。通知失败不影响画布与任务。
        let builder = tauri::Builder::default()
            // 壳层日志走官方插件（change: unify-host-client-logging，design D7）：
            // 平台日志目录 + 轮转 + 级别过滤由插件提供；run journal 仍由 `diagnostics` 负责。
            .plugin(crate::shell_log::plugin())
            .plugin(tauri_plugin_single_instance::init(|app, _, _| {
                if let Some(window) = app
                    .get_webview_window("startup")
                    .filter(|w| w.is_visible().unwrap_or(false))
                    .or_else(|| app.get_webview_window("main"))
                {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }))
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_notification::init())
            .on_menu_event(|app, event| {
                crate::devtools::handle_menu_event(app, &event);
                crate::local_host::handle_menu(app, &event);
                crate::diagnostic_export::handle_menu(app, &event);
                crate::diagnostic_upload::handle_menu(app, &event);
            });
        let builder = crate::transport::install(builder, token, origin.clone());
        let setup_pending = pending.clone();
        let setup_stopped = stopped.clone();

        let probe = crate::view::probe_desktop_session();
        println!(
            "desktop prototype {} mode={:?} (backend={}, sessionEnv={})",
            crate::PROTOTYPE_VERSION,
            config.mode,
            probe.backend,
            probe.has_session_env
        );

        let setup_config = config.clone();
        let app = builder
            .setup(move |app| {
                crate::devtools::install(app.handle())?;
                crate::diagnostic_export::install(app.handle())?;
                crate::diagnostic_upload::install(app.handle())?;
                crate::diagnostics::start_heartbeat(app.handle().clone());
                // 安装通知 sink：只经既有 native 协议暴露最小操作，不开放通用 IPC。
                crate::notifications::install_plugin_sink(app.handle().clone());

                // 界面地址：命令行/环境变量优先，其次读打包注入的 bundle 默认值，最后回退到内置
                // 前端资源。允许源必须在创建 WebView 之前确定。
                let managed =
                    ui_url_override.is_none() && setup_config.mode != CompositionMode::NativeOnly;
                let ui_url = ui_url_override.or_else(|| {
                    if managed {
                        None
                    } else {
                        read_bundle_defaults(app)
                    }
                });
                *origin.write().unwrap() = ui_url
                    .as_deref()
                    .and_then(|url| tauri::Url::parse(url).ok())
                    .map(|url| url.origin().ascii_serialization())
                    .unwrap_or_else(|| "tauri://localhost".to_owned());
                let native_only = setup_config.mode == CompositionMode::NativeOnly;

                // native-only：不创建 WebView，只保留 native 画布窗口。
                // overlay：透明 WebView 覆盖下层 native 画面。
                let (raw, handle_kind, webview_attached, container_api) = if native_only {
                    let window = WindowBuilder::new(app, "main")
                        .title(setup_config.title.clone())
                        .background_color(woohaa_bevy_canvas::native_startup_background().into())
                        .inner_size(setup_config.width as f64, setup_config.height as f64)
                        .transparent(true)
                        .build()?;
                    let handle_kind = classify_window_handle(
                        window.window_handle().map(|handle| handle.as_raw()),
                    );
                    // `Window` 与 `Window` 的 `RawHandleWrapper` 互操作同 overlay。
                    let raw = raw_handle_from_window(window.clone())?;
                    (raw, handle_kind, false, "tauri::WindowBuilder")
                } else {
                    let target = ui_url
                        .as_deref()
                        .and_then(|url| tauri::Url::parse(url).ok())
                        .map(WebviewUrl::External)
                        .unwrap_or_else(|| WebviewUrl::App("index.html".into()));
                    let popup_app = app.handle().clone();
                    let window_builder = WebviewWindowBuilder::new(app, "main", target)
                        .on_page_load(|_window, payload| {
                            crate::diagnostics::stderr(format_args!(
                                "desktop main page {:?}: {}",
                                payload.event(),
                                payload.url()
                            ))
                        })
                        .on_new_window(move |url, features| {
                            crate::web_popups::create(&popup_app, url, features)
                        })
                        .initialization_script(&bootstrap)
                        .title(setup_config.title.clone())
                        .inner_size(setup_config.width as f64, setup_config.height as f64)
                        .min_inner_size(800.0, 500.0)
                        .visible(!managed)
                        .decorations(false)
                        .transparent(true);
                    // macOS ignores this for WKWebView and colors only NSWindow.
                    // Other platforms would also make the WebView opaque.
                    #[cfg(target_os = "macos")]
                    let window_builder = window_builder
                        .background_color(woohaa_bevy_canvas::native_startup_background().into());
                    let window = window_builder.build()?;
                    let handle_kind = classify_window_handle(
                        window.window_handle().map(|handle| handle.as_raw()),
                    );
                    #[cfg(target_os = "macos")]
                    let raw = crate::macos_view::attach(&window)?;
                    #[cfg(not(target_os = "macos"))]
                    let raw = raw_handle_from_window(window.clone())?;
                    (raw, handle_kind, true, "tauri::WebviewWindowBuilder")
                };

                match NativeCanvasSession::build(&setup_config, Some(raw)) {
                    Ok(session) => {
                        FACTS.with(|slot| {
                            *slot.borrow_mut() = Some(CompositionFacts {
                                mode: setup_config.mode,
                                window_handle: handle_kind,
                                webview_attached,
                                view_bounds: session.bounds(),
                                container_api,
                            });
                        });
                        SESSION.with(|slot| *slot.borrow_mut() = Some(session));
                    }
                    Err(error) => {
                        // 无 GPU/会话时这里是明确失败点，不能伪装成成功。
                        crate::shell_log::error(&format!("native canvas failed: {error}"));
                        return Err(std::io::Error::other(error).into());
                    }
                }
                #[cfg(target_os = "macos")]
                let display_link = {
                    let stopped = setup_stopped.clone();
                    crate::macos_view::start_frame_clock(Box::new(move || {
                        if !stopped.load(Ordering::Acquire) {
                            pump_session();
                        }
                    }))
                };
                #[cfg(not(target_os = "macos"))]
                let display_link = false;
                // Fallback for platforms without a view-bound display link.
                // Wake the Tauri loop independently of WebView rAF, with one
                // pending frame maximum. The worker never owns or touches App.
                let handle = app.handle().clone();
                let mut previous_frame = std::time::Instant::now();
                if !display_link {
                    std::thread::spawn(move || {
                        while !setup_stopped.load(Ordering::Acquire) {
                            if !setup_pending.swap(true, Ordering::AcqRel) {
                                let queued = std::time::Instant::now();
                                let pending = setup_pending.clone();
                                if handle
                                    .run_on_main_thread(move || {
                                        crate::metrics::sample(
                                            "frame.dispatch_wait_ms",
                                            queued.elapsed(),
                                        );
                                        pump_session();
                                        pending.store(false, Ordering::Release);
                                    })
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            crate::metrics::sample(
                                "driver.wake_interval_ms",
                                previous_frame.elapsed(),
                            );
                            previous_frame = std::time::Instant::now();
                            std::thread::sleep(std::time::Duration::from_millis(16));
                        }
                    });
                }
                if managed {
                    crate::local_host::install(app.handle(), origin.clone())?;
                }
                crate::shell_log::info(&format!(
                    "shell ready mode={:?} handle={handle_kind:?} webview={webview_attached} display_link={display_link}",
                    setup_config.mode
                ));
                Ok(())
            })
            .build(tauri::generate_context!())
            .map_err(|error| format!("failed to build tauri app: {error}"))?;

        app.run(move |app_handle, event| {
            if crate::local_host::handle_exit(app_handle, &event) { return; }
            match &event {
            RunEvent::WindowEvent {
                event:
                    tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. },
                ..
            } => {
                // 尺寸/DPI 变化占位：真实窗口物理尺寸、contentRect 与 layoutGeneration 作废
                // 属阶段 P1/P3（任务 2.5 / 4.9），需要真机才能验证；此处不伪造尺寸来源。
            }
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                if matches!(event, RunEvent::Exit) {
                    crate::shell_log::info("shell exiting");
                }
                stopped.store(true, Ordering::Release);
                #[cfg(target_os = "macos")]
                crate::macos_frame_clock::stop();
                SESSION.with(|slot| {
                    if let Some(session) = slot.borrow_mut().as_mut() {
                        // 受控关闭：有界 drain，不冻结 OS loop。
                        let _ = session.close(4);
                    }
                });
                #[cfg(target_os = "macos")]
                crate::macos_view::detach();
            }
            _ => {}
        }
        crate::diagnostics::handle_run_event(&event);
        });

        FACTS.with(|slot| {
            if let Some(facts) = slot.borrow().as_ref() {
                println!("composition facts: {}", facts.to_json());
            }
        });
        Ok(())
    }

    /// 读取打包注入的 bundle 默认值（`bundle.resources` 里的 `woohaa-desktop.defaults.json`）。
    ///
    /// 资源缺失或非法只打印诊断并回退到内置前端资源：配置错误不应让桌面壳起不来，也不能被
    /// 静默忽略成「地址正确」。
    fn read_bundle_defaults<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<String> {
        let path = match app.path().resolve(
            crate::packaging::DEFAULTS_RESOURCE,
            tauri::path::BaseDirectory::Resource,
        ) {
            Ok(path) => path,
            Err(error) => {
                crate::diagnostics::stderr(format_args!(
                    "desktop bundle defaults unavailable: {error}"
                ));
                return None;
            }
        };
        match crate::packaging::read_defaults(&path) {
            Ok(url) => url,
            Err(error) => {
                crate::diagnostics::stderr(format_args!(
                    "desktop bundle defaults rejected: {error}"
                ));
                None
            }
        }
    }

    fn pump_session() {
        let started = std::time::Instant::now();
        let navigation = crate::metrics::take_navigation();
        if let Some((first, latest)) = navigation {
            crate::metrics::sample("frame.first_accept_to_pump_start_ms", first.elapsed());
            crate::metrics::sample("frame.latest_accept_to_pump_start_ms", latest.elapsed());
        }
        SESSION.with(|slot| {
            if let Some(session) = slot.borrow_mut().as_mut() {
                session.pump();
                #[cfg(target_os = "macos")]
                if woohaa_bevy_canvas::native_frame_ready() {
                    crate::macos_view::mark_frame_ready();
                }
            }
        });
        let elapsed = started.elapsed();
        crate::metrics::sample("frame.pump_ms", elapsed);
        if let Some((_, latest)) = navigation {
            crate::metrics::sample("frame.latest_accept_to_pump_end_ms", latest.elapsed());
            crate::metrics::sample("frame.navigation_pump_ms", elapsed);
        }
    }
}
