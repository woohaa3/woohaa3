//! 壳层日志出口（change: unify-host-client-logging，design D7）。
//!
//! **这里只做装配，不自研轮转。** 文件写入、平台日志目录、级别过滤、轮转策略都由官方
//! `tauri-plugin-log` 提供：
//!
//! - `TargetKind::LogDir` → macOS `~/Library/Logs/com.woohaa.desktop`、
//!   Linux `$XDG_DATA_HOME/com.woohaa.desktop/logs`、Windows `%LOCALAPPDATA%\com.woohaa.desktop\logs`；
//! - `RotationStrategy::KeepSome` 限制历史文件数；
//! - 级别过滤把 `debug` 挡在生产构建之外。调试构建的文件出口同样收到 `debug`。
//!   `log::Level` 的序是 `Error < Warn < Info < Debug < Trace`，比较用 `level <= max`。
//!
//! 文件出口是旁路：官方目录可能因权限/安全软件不可写（Windows 上确有其事）。此时依次
//! 降级到宿主日志目录（`WOOHAA3_LOG_DIR` / 数据目录下的 `.woohaa3/logs`）、本次运行目录、
//! 数据目录、临时目录；全部失败就只保留 stderr/stdout，绝不让日志初始化阻断桌面壳启动。
//!
//! **它不替代 `diagnostics`**：那边保存的是"本次运行的会话账本"（run 隔离、崩溃恢复、
//! incidents、上传 spool），语义是会话而不是连续日志。两者互补：
//! 连续日志回答"最近发生了什么"，run journal 回答"那次崩溃前发生了什么"。
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// 壳自己的连续日志目标。依赖库的 `debug` 仍走各自 target；
/// 事后定位先看这里的 `info` / `warn` / `error`。
pub const TARGET: &str = "woohaa_shell";

pub fn info(message: &str) {
    log::info!(target: TARGET, "{message}");
}

pub fn warn(message: &str) {
    log::warn!(target: TARGET, "{message}");
}

pub fn error(message: &str) {
    log::error!(target: TARGET, "{message}");
}

pub fn record(level: log::Level, message: &str) {
    match level {
        log::Level::Error => error(message),
        log::Level::Warn => warn(message),
        log::Level::Info => info(message),
        log::Level::Debug => log::debug!(target: TARGET, "{message}"),
        log::Level::Trace => log::trace!(target: TARGET, "{message}"),
    }
}

/// WebView 诊断里值得进入连续日志的级别。普通 `info` / `debug` 留在 run journal。
pub fn webview_level(event: &str, level: &str) -> Option<log::Level> {
    match event {
        "error" | "unhandledrejection" | "resource-error" | "request-failed" => {
            Some(log::Level::Error)
        }
        _ if level == "error" => Some(log::Level::Error),
        _ if level == "warn" => Some(log::Level::Warn),
        _ => None,
    }
}

/// 连续日志只留一段摘要；完整文本仍在 run journal。
pub fn clip(message: &str, max: usize) -> &str {
    let mut end = message.len().min(max);
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    &message[..end]
}

/** 壳日志文件名（不含扩展名；插件按平台补 `.log`）。 */
const SHELL_LOG_FILE: &str = "shell";
/** 保留的历史分段数：够回溯几次启动，又不会无限增长。 */
const KEEP_SEGMENTS: usize = 10;

/// 文件出口是否收下这条记录。调试构建最高到 `debug`，发行构建最高到 `info`。
fn file_accepts(level: log::Level, debug_build: bool) -> bool {
    let max = if debug_build { log::Level::Debug } else { log::Level::Info };
    level <= max
}

/// 宿主日志目录约定：`WOOHAA3_LOG_DIR`，否则数据目录下的 `.woohaa3/logs`。
fn host_log_dir() -> Option<std::path::PathBuf> {
    let data = crate::diagnostics::data_directory();
    if let Some(raw) = std::env::var_os("WOOHAA3_LOG_DIR") {
        let raw = std::path::PathBuf::from(raw);
        if raw.as_os_str().is_empty() {
            return None;
        }
        return Some(if raw.is_absolute() {
            raw
        } else {
            data?.join(raw)
        });
    }
    data.map(|data| data.join(".woohaa3").join("logs"))
}

/// 文件出口候选，按优先级排列：官方目录 → 宿主 `.woohaa3` 日志 → 本次运行目录 →
/// 数据目录 → 临时目录。
fn file_targets() -> Vec<(&'static str, TargetKind)> {
    let file_name = Some(SHELL_LOG_FILE.to_owned());
    let mut targets = vec![(
        "app_log_dir",
        TargetKind::LogDir {
            file_name: file_name.clone(),
        },
    )];
    let mut seen = Vec::new();
    let mut push_folder = |label: &'static str, path: std::path::PathBuf| {
        if !seen.contains(&path) {
            targets.push((
                label,
                TargetKind::Folder {
                    path: path.clone(),
                    file_name: file_name.clone(),
                },
            ));
            seen.push(path);
        }
    };
    if let Some(dir) = host_log_dir() {
        push_folder("host_log_dir", dir);
    }
    if let Some(run) = crate::diagnostics::run_dir() {
        push_folder("run_dir", run.to_path_buf());
    }
    if let Some(data) = crate::diagnostics::data_directory() {
        push_folder("data_dir", data.join("logs"));
    }
    push_folder(
        "temp_dir",
        std::env::temp_dir().join("woohaa-desktop").join("logs"),
    );
    targets
}

/// 只构造 logger，不注册；注册失败（已有全局 logger）由调用方处理。
fn build_logger(
    app: &tauri::AppHandle,
    kind: TargetKind,
    debug_build: bool,
) -> Result<(log::LevelFilter, Box<dyn log::Log>), String> {
    let level = if debug_build {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    let (_, max_level, logger) = tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(kind)
                .filter(move |metadata| file_accepts(metadata.level(), debug_build)),
        ])
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_SEGMENTS))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(level)
        .split(app)
        .map_err(|error| error.to_string())?;
    Ok((max_level, logger))
}

/// 构造插件。文件出口不可用时逐级降级，绝不阻断桌面壳启动。
///
/// 发行构建只记 `info` 及以上；调试构建放开到 `debug`。
pub fn plugin() -> TauriPlugin<tauri::Wry> {
    let debug_build = cfg!(debug_assertions);
    PluginBuilder::new("log")
        .setup(move |app, _api| {
            let mut last_error = String::new();
            for (label, kind) in file_targets() {
                match build_logger(app, kind, debug_build) {
                    Ok((max_level, logger)) => {
                        if let Err(error) = tauri_plugin_log::attach_logger(max_level, logger) {
                            // 已有全局 logger：保留既有出口，不再追加文件出口。
                            eprintln!("[shell-log] 全局 logger 已存在，保留现有出口：{error}");
                            return Ok(());
                        }
                        if label != "app_log_dir" {
                            eprintln!("[shell-log] 文件日志降级到 {label}：{last_error}");
                        }
                        return Ok(());
                    }
                    Err(error) => {
                        last_error = format!("{label}: {error}");
                        eprintln!("[shell-log] 文件日志落点不可用：{last_error}");
                    }
                }
            }
            eprintln!("[shell-log] 文件日志已关闭，仅保留 stderr/stdout：{last_error}");
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{clip, file_accepts, webview_level};

    #[test]
    fn debug_file_keeps_debug_and_drops_trace() {
        assert!(file_accepts(log::Level::Error, true));
        assert!(file_accepts(log::Level::Warn, true));
        assert!(file_accepts(log::Level::Info, true));
        assert!(file_accepts(log::Level::Debug, true));
        assert!(!file_accepts(log::Level::Trace, true));
    }

    #[test]
    fn webview_failures_enter_the_shell_log() {
        assert_eq!(webview_level("unhandledrejection", "info"), Some(log::Level::Error));
        assert_eq!(webview_level("resource-error", "warn"), Some(log::Level::Error));
        assert_eq!(webview_level("console", "error"), Some(log::Level::Error));
        assert_eq!(webview_level("console", "warn"), Some(log::Level::Warn));
        assert_eq!(webview_level("console", "info"), None);
        assert_eq!(webview_level("pageshow", "info"), None);
    }

    #[test]
    fn clip_keeps_a_char_boundary() {
        assert_eq!(clip("abc", 2), "ab");
        assert_eq!(clip("你", 1), "");
        assert_eq!(clip("你a", 4), "你a");
    }

    #[test]
    fn release_file_drops_debug() {
        assert!(file_accepts(log::Level::Error, false));
        assert!(file_accepts(log::Level::Warn, false));
        assert!(file_accepts(log::Level::Info, false));
        assert!(!file_accepts(log::Level::Debug, false));
        assert!(!file_accepts(log::Level::Trace, false));
    }
}
