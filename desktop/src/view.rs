//! Linux/macOS/Windows 原生 view：从 Tauri 窗口取得真实句柄事实，供 Bevy/wgpu 创建 surface
//! （change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，design D1 / D5，任务 1.4）。
//!
//! 本模块**只负责句柄/坐标/装配事实的归类与探测**，不证明 GPU surface 能在同窗口正确合成。
//! 实际 GTK 容器装配与同窗口合成属于 P1 真机门槛（见 `notes/prototype-gate.md`）；在没有
//! 真实显示会话的机器上，`probe_desktop_session()` 返回无会话且不创建任何窗口。
//!
//! 关键事实（P0 锁定，见 `notes/dependency-lock.md`）：
//! - Tauri 在 Linux 用 `tao`（GTK 事件循环）拥有窗口，默认子控件是 `gtk::Box`
//!   （`WebviewWindow::default_vbox()`），WebView 由 wry 挂在该容器下；
//! - 真实 window handle 走 `raw-window-handle 0.6`，X11 下为 `XlibWindowHandle { window: xid }`；
//! - 后续 native view 必须在 WebView 之下的同一窗口层次中组合，而不是另开顶层窗口。

use std::fmt;

/// 原生 view 在一个共同窗口中的位置（逻辑像素，相对窗口客户区原点）。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ViewBounds {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl ViewBounds {
    pub const fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    /// 是否为零尺寸（零尺寸期间不提交 surface，design D2）。
    pub fn is_zero_sized(&self) -> bool {
        self.width <= 0.0 || self.height <= 0.0
    }

    /// 按 OS scale 换算物理像素尺寸，并对上限取整（design D5）。
    pub fn physical_size(&self, scale: f64, max_dimension: u32) -> (u32, u32) {
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let width = ((self.width as f64 * scale).round() as i64).clamp(0, max_dimension as i64);
        let height = ((self.height as f64 * scale).round() as i64).clamp(0, max_dimension as i64);
        (width as u32, height as u32)
    }
}

/// 原生 view 从窗口/WebView 拿到的原始句柄事实。
///
/// 仅记录句柄种类与数值，供 wgpu surface 创建与证据记录；不在这里创建 surface。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeHandleKind {
    /// X11：窗口 id（XID）。
    Xlib(u64),
    /// Wayland：`wl_surface` 指针（作为整数记录；不假设可自由嵌入）。
    Wayland(u64),
    /// 无可用句柄（没有显示会话 / 后端不支持）。
    Unavailable,
    /// macOS AppKit NSView pointer.
    AppKit(u64),
    /// Windows HWND（顶层窗口客户区；WebView2 是它的子窗口）。
    Win32(u64),
}

impl fmt::Display for NativeHandleKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Xlib(id) => write!(f, "xlib:{id:#x}"),
            Self::Wayland(ptr) => write!(f, "wayland:{ptr:#x}"),
            Self::AppKit(ptr) => write!(f, "appkit:{ptr:#x}"),
            Self::Win32(hwnd) => write!(f, "win32:{hwnd:#x}"),
            Self::Unavailable => f.write_str("unavailable"),
        }
    }
}

impl NativeHandleKind {
    /// 是否是可用句柄。
    pub const fn is_available(self) -> bool {
        !matches!(self, Self::Unavailable)
    }
}

/// 从 `raw_window_handle` 的窗口 handle 归类平台后端。
pub fn classify_window_handle(
    handle: Result<raw_window_handle::RawWindowHandle, raw_window_handle::HandleError>,
) -> NativeHandleKind {
    match handle {
        Ok(raw_window_handle::RawWindowHandle::Xlib(handle)) => {
            NativeHandleKind::Xlib(handle.window as u64)
        }
        Ok(raw_window_handle::RawWindowHandle::Xcb(handle)) => {
            NativeHandleKind::Xlib(handle.window.get() as u64)
        }
        Ok(raw_window_handle::RawWindowHandle::Wayland(handle)) => {
            NativeHandleKind::Wayland(handle.surface.as_ptr() as u64)
        }
        Ok(raw_window_handle::RawWindowHandle::AppKit(handle)) => {
            NativeHandleKind::AppKit(handle.ns_view.as_ptr() as u64)
        }
        Ok(raw_window_handle::RawWindowHandle::Win32(handle)) => {
            NativeHandleKind::Win32(handle.hwnd.get() as u64)
        }
        _ => NativeHandleKind::Unavailable,
    }
}

/// 同一窗口中的层次装配决策。
///
/// P1 需要在真机确认哪种装配真的让 wgpu surface 与透明 WebView 合成；这里只固定枚举与
/// 命名，避免用「GTK 控件排列成功」冒充 GPU 合成成功（design D1）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompositionMode {
    /// 叠加：下层 native view + 上层透明 WebView（目标形态）。
    Overlay,
    /// 仅 native：关闭 WebView，只画 native 画布（截帧调试入口）。
    NativeOnly,
}

/// 同窗口合成装配的诊断事实。**不是**合成成功的证明。
#[derive(Clone, Debug, PartialEq)]
pub struct CompositionFacts {
    pub mode: CompositionMode,
    pub window_handle: NativeHandleKind,
    /// WebView 是否已挂到同一窗口容器。
    pub webview_attached: bool,
    /// native view 的 bounds。
    pub view_bounds: ViewBounds,
    /// 实际使用的 API/容器（供证据记录）。
    pub container_api: &'static str,
}

impl CompositionFacts {
    /// 报告用的 JSON 片段；可用于 sidecar 与 P1 证据。
    pub fn to_json(&self) -> String {
        format!(
            "{{\"mode\":\"{}\",\"windowHandle\":\"{}\",\"webviewAttached\":{},\"containerApi\":\"{}\",\"view\":{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}}}",
            match self.mode {
                CompositionMode::Overlay => "overlay",
                CompositionMode::NativeOnly => "native-only",
            },
            self.window_handle,
            self.webview_attached,
            self.container_api,
            self.view_bounds.x,
            self.view_bounds.y,
            self.view_bounds.width,
            self.view_bounds.height,
        )
    }
}

/// 桌面会话探测结果（无需打开 display）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DesktopSession {
    /// 是否存在桌面会话（Linux 环境变量 / macOS WindowServer 会话）。
    pub has_session_env: bool,
    /// 推断后端：`x11` / `wayland` / `appkit` / `none`。
    pub backend: &'static str,
}

/// 探测当前进程是否具备可用的桌面会话（不创建窗口）。
///
/// Linux 读取 display 环境变量；macOS 查询 WindowServer 会话；Windows 查询进程窗口站
/// 的 `WSF_VISIBLE` 标志。均不创建窗口或 GPU 资源。
pub fn probe_desktop_session() -> DesktopSession {
    #[cfg(target_os = "macos")]
    {
        let available = macos_has_session();
        return DesktopSession {
            has_session_env: available,
            backend: if available { "appkit" } else { "none" },
        };
    }
    #[cfg(target_os = "windows")]
    {
        let available = windows_has_session();
        return DesktopSession {
            has_session_env: available,
            backend: if available { "win32" } else { "none" },
        };
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    linux_session_from_env()
}

#[cfg(target_os = "windows")]
fn windows_has_session() -> bool {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    struct UserObjectFlags {
        inherit: i32,
        reserved: i32,
        flags: u32,
    }

    const UOI_FLAGS: i32 = 1;
    const WSF_VISIBLE: u32 = 0x0001;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetProcessWindowStation() -> *mut c_void;
        fn GetUserObjectInformationW(
            object: *mut c_void,
            index: i32,
            info: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }

    // 服务/非交互会话的窗口站不可见；此时创建 WebView 只会得到不可见的窗口。
    let station = unsafe { GetProcessWindowStation() };
    if station.is_null() {
        return false;
    }
    let mut flags = UserObjectFlags::default();
    let ok = unsafe {
        GetUserObjectInformationW(
            station,
            UOI_FLAGS,
            &mut flags as *mut UserObjectFlags as *mut c_void,
            std::mem::size_of::<UserObjectFlags>() as u32,
            std::ptr::null_mut(),
        )
    };
    ok != 0 && flags.flags & WSF_VISIBLE != 0
}

#[cfg(target_os = "macos")]
fn macos_has_session() -> bool {
    use std::ffi::c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }
    // The Copy API returns an owned dictionary, or null without a WindowServer session.
    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            false
        } else {
            CFRelease(session);
            true
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn linux_session_from_env() -> DesktopSession {
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    let x11 = std::env::var_os("DISPLAY").is_some();
    match (wayland, x11) {
        (true, _) => DesktopSession {
            has_session_env: true,
            backend: "wayland",
        },
        (false, true) => DesktopSession {
            has_session_env: true,
            backend: "x11",
        },
        (false, false) => DesktopSession {
            has_session_env: false,
            backend: "none",
        },
    }
}

/// 生成给 P1 证据用的一行 JSON，明确当前机器能否进入同窗口原型。
pub fn desktop_support_report() -> String {
    let session = probe_desktop_session();
    format!(
        "{{\"prototype\":\"{}\",\"gtkLinked\":{},\"sessionEnv\":{},\"backend\":\"{}\"}}",
        crate::PROTOTYPE_VERSION,
        cfg!(target_os = "linux"),
        session.has_session_env,
        session.backend,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_sized_bounds_suppress_surface() {
        assert!(ViewBounds::new(0.0, 0.0, 0.0, 480.0).is_zero_sized());
        assert!(ViewBounds::new(0.0, 0.0, 640.0, 0.0).is_zero_sized());
        // 负尺寸同样视为不可提交。
        assert!(ViewBounds::new(0.0, 0.0, -1.0, 480.0).is_zero_sized());
        assert!(!ViewBounds::new(0.0, 0.0, 640.0, 480.0).is_zero_sized());
    }

    #[test]
    fn physical_size_applies_scale_and_clamps() {
        let bounds = ViewBounds::new(0.0, 0.0, 640.0, 480.0);
        assert_eq!(bounds.physical_size(2.0, 8192), (1280, 960));
        // 分数 scale 四舍五入。
        assert_eq!(bounds.physical_size(1.5, 8192), (960, 720));
        // 上限收敛。
        assert_eq!(bounds.physical_size(10.0, 8192), (6400, 4800));
        assert_eq!(
            ViewBounds::new(0.0, 0.0, 5000.0, 5000.0).physical_size(4.0, 8192),
            (8192, 8192)
        );
        // 非法 scale 回退 1.0。
        assert_eq!(bounds.physical_size(f64::NAN, 8192), (640, 480));
        assert_eq!(bounds.physical_size(0.0, 8192), (640, 480));
    }

    #[test]
    fn appkit_handle_is_classified() {
        let view = std::ptr::NonNull::<u8>::dangling().cast();
        let raw = raw_window_handle::AppKitWindowHandle::new(view);
        let kind = classify_window_handle(Ok(raw_window_handle::RawWindowHandle::AppKit(raw)));
        assert_eq!(kind, NativeHandleKind::AppKit(view.as_ptr() as u64));
        assert!(kind.is_available());
        assert!(kind.to_string().starts_with("appkit:"));
    }

    #[test]
    fn win32_handle_is_classified() {
        let hwnd = std::num::NonZeroIsize::new(0x1234).unwrap();
        let raw = raw_window_handle::Win32WindowHandle::new(hwnd);
        let kind = classify_window_handle(Ok(raw_window_handle::RawWindowHandle::Win32(raw)));
        assert_eq!(kind, NativeHandleKind::Win32(0x1234));
        assert!(kind.is_available());
        assert!(kind.to_string().starts_with("win32:"));
    }

    #[test]
    fn unavailable_handle_is_not_available() {
        assert!(!NativeHandleKind::Unavailable.is_available());
        assert!(NativeHandleKind::Xlib(0x1200).is_available());
    }

    #[test]
    fn composition_facts_json_reports_mode_and_handle() {
        let facts = CompositionFacts {
            mode: CompositionMode::Overlay,
            window_handle: NativeHandleKind::Xlib(0x4000),
            webview_attached: true,
            view_bounds: ViewBounds::new(0.0, 0.0, 800.0, 600.0),
            container_api: "gtk::Box",
        };
        let json = facts.to_json();
        assert!(json.contains("\"mode\":\"overlay\""));
        assert!(json.contains("\"webviewAttached\":true"));
        assert!(json.contains("\"containerApi\":\"gtk::Box\""));
        assert!(json.contains("\"width\":800"));
    }

    #[test]
    fn probe_reports_none_without_session_env() {
        // 该测试不修改进程环境；只断言函数在当前环境下的自洽性。
        let session = probe_desktop_session();
        match session.backend {
            "none" => assert!(!session.has_session_env),
            "x11" | "wayland" | "appkit" | "win32" => assert!(session.has_session_env),
            other => panic!("意外后端 {other}"),
        }
    }

    #[test]
    fn support_report_is_json_with_prototype_version() {
        let report = desktop_support_report();
        assert!(report.contains(crate::PROTOTYPE_VERSION));
        assert!(report.contains(&format!("\"gtkLinked\":{}", cfg!(target_os = "linux"))));
    }
}
