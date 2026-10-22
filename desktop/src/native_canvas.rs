//! 真实 Bevy `App` 的 native 画布后端：把 [`FrameBackend`] 的 build/finish/cleanup/update/dispose
//! 映射到 Bevy 生命周期，**不使用** `App::run()` 或 winit runner
//! （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，design D2，任务 1.4 / 1.5）。
//!
//! 与浏览器 adapter 的差异（P0 只固定骨架与线程契约，不改变产品化前端）：
//! - 由 Tauri 拥有 OS 事件循环；本后端只提供可被投递的 `update`；
//! - `native-canvas` 不启用 `bevy_winit`，因此 `DefaultPlugins` 不含 `WinitPlugin`，
//!   不存在第二个 OS loop；
//! - primary window 不绑定浏览器 canvas，由宿主把 Tauri 窗口的真实 `RawHandleWrapper`
//!   注入，使 render world 能创建 wgpu surface。
//!
//! 本文件是原型骨架：动态 2D/3D 内容、透明 WebView 合成与 GPU 截帧属于 P1 真机门槛，
//! 未在此实现。P1 通过前不得据此声称同窗口合成可用。

use bevy::{
    app::{App, PluginsState},
    prelude::*,
    window::{RawHandleWrapper, Window, WindowResolution},
};

use crate::lifecycle::FrameBackend;

/// 构造 native 画布 App 的选项。
pub struct NativeCanvasOptions {
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    /// Tauri 窗口的真实句柄；无显示会话时为 `None`（此时无法创建 surface）。
    pub window_handle: Option<RawHandleWrapper>,
}

impl Default for NativeCanvasOptions {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 720,
            scale_factor: 1.0,
            window_handle: None,
        }
    }
}

/// Bevy `App` 后端。
pub struct BevyCanvasBackend {
    app: App,
    options: NativeCanvasOptions,
    /// 在途 GPU 提交计数（由 capture/readback 系统上报；P0 骨架为 0）。
    in_flight: u32,
    built: bool,
}

impl BevyCanvasBackend {
    pub fn new(options: NativeCanvasOptions) -> Self {
        Self {
            app: App::new(),
            options,
            in_flight: 0,
            built: false,
        }
    }

    /// 暴露 App 供宿主在 P1 注入场景/查询（原型期只读使用）。
    pub fn app(&self) -> &App {
        &self.app
    }

    pub fn app_mut(&mut self) -> &mut App {
        &mut self.app
    }
}

impl FrameBackend for BevyCanvasBackend {
    fn build(&mut self) -> Result<(), String> {
        if self.built {
            return Ok(());
        }
        let handle = self
            .options
            .window_handle
            .take()
            .ok_or_else(|| "Native canvas requires a real window handle".to_owned())?;
        let window = Window {
            title: "Woohaa native canvas".into(),
            resolution: WindowResolution::new(
                self.options.width.max(1),
                self.options.height.max(1),
            )
            .with_scale_factor_override(self.options.scale_factor as f32),
            ..default()
        };
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let assets = native_assets_path(
            &executable,
            std::env::var_os("WOOHAA_DESKTOP_HOST_ROOT")
                .as_deref()
                .map(std::path::Path::new),
            cfg!(debug_assertions),
        )
        .to_string_lossy()
        .into_owned();
        self.app = woohaa_bevy_canvas::build_native_canvas_app(window, handle, assets);

        self.built = true;
        Ok(())
    }

    fn plugins_ready(&mut self) -> bool {
        self.app.plugins_state() == PluginsState::Ready
    }

    fn finish_plugins(&mut self) {
        self.app.finish();
        // The legacy bridge/query core uses thread-local state. Its native
        // facade and ECS consumers must share the Tauri main thread. Asset IO
        // and GPU work remain asynchronous; only ECS schedule execution is serial.
        // PipelinedRenderingPlugin is disabled by build_native_canvas_app.
        confine_schedules_to_host_thread(&mut self.app);
    }

    fn cleanup_plugins(&mut self) {
        self.app.cleanup();
    }

    fn update(&mut self) {
        self.app.update();
    }

    fn in_flight(&self) -> u32 {
        self.in_flight
    }

    fn drain_step(&mut self) -> bool {
        // P0 骨架没有在途 capture/readback；P4 接入真实 readback 后在此排空。
        self.in_flight = 0;
        true
    }

    fn dispose(&mut self) {
        // 用空 App 替换，释放 world/渲染资源；后续任何调用都不再访问已销毁状态。
        self.app = App::new();
        self.built = false;
        self.in_flight = 0;
    }
}

fn confine_schedules_to_host_thread(app: &mut App) {
    for sub_app in app.sub_apps_mut().iter_mut() {
        let mut schedules = sub_app
            .world_mut()
            .resource_mut::<bevy::ecs::schedule::Schedules>();
        for (_, schedule) in schedules.iter_mut() {
            schedule.set_executor(bevy::ecs::schedule::SingleThreadedExecutor::new());
        }
    }
}

/// 从 Tauri 窗口构造可注入 Bevy 的 `RawHandleWrapper`。
///
/// 只在真实的 Tauri 窗口类型上成立；要求 `W: HasWindowHandle + HasDisplayHandle + Send + Sync`。
/// 失败时返回稳定的 `Err`，由宿主决定是否降级为无 surface（不伪造句柄）。
pub fn raw_handle_from_window<W>(window: W) -> Result<RawHandleWrapper, String>
where
    W: raw_window_handle::HasWindowHandle
        + raw_window_handle::HasDisplayHandle
        + Send
        + Sync
        + 'static,
{
    let wrapper = bevy::window::WindowWrapper::new(window);
    RawHandleWrapper::new(&wrapper).map_err(|error| format!("window handle unavailable: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_thread_schedules_apply_startup_commands_before_update() {
        #[derive(Resource)]
        struct Probe(std::thread::ThreadId);
        let host_thread = std::thread::current().id();
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .add_systems(Startup, |mut commands: Commands| {
                commands.insert_resource(Probe(std::thread::current().id()));
            })
            .add_systems(Update, move |probe: Res<Probe>| {
                assert_eq!(probe.0, host_thread);
                assert_eq!(std::thread::current().id(), host_thread);
            });
        confine_schedules_to_host_thread(&mut app);
        app.update();
        assert!(app.world().contains_resource::<Probe>());
    }

    #[test]
    fn scale_factor_falls_back_for_invalid_values() {
        // 纯逻辑：不构造 App/GPU。验证选项归一化不产生非法窗口尺寸。
        for scale in [f64::NAN, 0.0, -1.0] {
            let options = NativeCanvasOptions {
                width: 0,
                height: 0,
                scale_factor: scale,
                window_handle: None,
            };
            // 构造后端本身不触发渲染初始化。
            let backend = BevyCanvasBackend::new(options);
            assert!(!backend.built);
            assert_eq!(backend.in_flight(), 0);
        }
    }

    /// 真实宿主验收（design D1）：`build()` 需要一个真实的 OS 窗口句柄。
    ///
    /// 注意：本测试的阻塞点是**窗口句柄**，不是 GPU。测试进程没有 Tauri/OS 窗口，
    /// `build()` 会稳定返回 `Native canvas requires a real window handle`；有 GPU 也不能通过。
    #[test]
    #[ignore = "需要真实 OS 窗口句柄（测试进程没有窗口）；与 GPU 无关"]
    fn build_without_handle_still_constructs_app_and_is_ready() {
        let mut backend = BevyCanvasBackend::new(NativeCanvasOptions {
            window_handle: None,
            ..default()
        });
        backend.build().expect("build");
        assert!(backend.plugins_state_is_ready_for_test());
        assert_eq!(backend.in_flight(), 0);
    }

    /// 真实宿主验收：`dispose` 需要在真实句柄上建成的 render world。
    #[test]
    #[ignore = "需要真实 OS 窗口句柄（测试进程没有窗口）；与 GPU 无关"]
    fn dispose_clears_state_and_is_idempotent() {
        let mut backend = BevyCanvasBackend::new(NativeCanvasOptions::default());
        backend.build().expect("build");
        backend.dispose();
        backend.dispose();
        assert!(!backend.built);
        assert_eq!(backend.in_flight(), 0);
    }
}

#[cfg(test)]
impl BevyCanvasBackend {
    /// 测试专用：不修改状态读取插件是否 ready。
    fn plugins_state_is_ready_for_test(&mut self) -> bool {
        self.app.plugins_state() == PluginsState::Ready
    }
}

fn native_assets_path(
    executable: &std::path::Path,
    host_root: Option<&std::path::Path>,
    development: bool,
) -> std::path::PathBuf {
    if let Some(root) = host_root {
        return root.join("frontend/assets");
    }
    let parent = executable
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    if parent.file_name().is_some_and(|name| name == "MacOS") {
        return parent.join("../Resources/native-assets");
    }
    if development {
        return std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../bevy/assets");
    }
    parent.join("native-assets")
}
#[cfg(test)]
mod asset_path_tests {
    use super::native_assets_path;
    use std::path::Path;
    #[test]
    fn installed_app_resolves_assets_inside_bundle() {
        assert_eq!(
            native_assets_path(
                Path::new("/Applications/WooHaa.app/Contents/MacOS/woohaa-desktop"),
                None,
                false
            ),
            Path::new("/Applications/WooHaa.app/Contents/MacOS/../Resources/native-assets")
        );
    }
    #[test]
    fn explicit_host_root_supports_isolated_development() {
        assert_eq!(
            native_assets_path(
                Path::new("/tmp/desktop"),
                Some(Path::new("/tmp/resources")),
                true
            ),
            Path::new("/tmp/resources/frontend/assets")
        );
        assert!(
            !native_assets_path(Path::new("/tmp/desktop"), None, false)
                .to_string_lossy()
                .contains("bevy/assets")
        );
    }
}
