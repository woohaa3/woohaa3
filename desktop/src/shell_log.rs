//! 壳层日志出口（change: unify-host-client-logging，design D7）。
//!
//! **这里只做装配，不自研轮转。** 文件写入、平台日志目录、级别过滤、轮转策略都由官方
//! `tauri-plugin-log` 提供：
//!
//! - `TargetKind::LogDir` → macOS `~/Library/Logs/com.woohaa.desktop`、
//!   Linux `$XDG_DATA_HOME/com.woohaa.desktop/logs`、Windows `%LOCALAPPDATA%\com.woohaa.desktop\logs`；
//! - `RotationStrategy::KeepSome` 限制历史文件数；
//! - 级别过滤把 `debug` 挡在生产构建之外。
//!
//! **它不替代 `diagnostics`**：那边保存的是"本次运行的会话账本"（run 隔离、崩溃恢复、
//! incidents、上传 spool），语义是会话而不是连续日志。两者互补：
//! 连续日志回答"最近发生了什么"，run journal 回答"那次崩溃前发生了什么"。
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/** 壳日志文件名（不含扩展名；插件按平台补 `.log`）。 */
const SHELL_LOG_FILE: &str = "shell";
/** 保留的历史分段数：够回溯几次启动，又不会无限增长。 */
const KEEP_SEGMENTS: usize = 10;

/// 构造插件。发行构建只记 `info` 及以上；调试构建放开到 `debug`。
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::new()
        .targets([
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir {
                file_name: Some(SHELL_LOG_FILE.to_owned())
            })
            .filter(|metadata| metadata.level() <= log::Level::Info)
        ])
        .rotation_strategy(RotationStrategy::KeepSome(KEEP_SEGMENTS))
        .timezone_strategy(TimezoneStrategy::UseLocal)
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Debug
        } else {
            log::LevelFilter::Info
        })
        .build()
}
