//! 桌面更新通道的选择与一次性回退意图
//! （change: 2026-11-18-add-desktop-update-channels）。
//!
//! 通道有两段事实，必须分开：
//!
//! - **可用集合**来自构建期（`desktop-runtime.json` 的 `updater.endpoints`）：stable 安装包
//!   只带 stable 地址，因此它在**产物里**就查不到 alpha feed。这是「普通用户不会升级到开发者
//!   版本」的硬保证，不依赖运行期判断。
//! - **当前选择**来自用户设置，存在壳层自己的数据目录。启动期更新检查跑在宿主进程之前，
//!   宿主的设置库此刻还不存在，所以不能放在宿主侧。
//!
//! 读取失败一律按 `stable` 处理并允许覆盖写回：通道文件坏掉不该让应用打不开。

use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

/// 稳定通道名。任何安装包都必须能查它，否则用户回不到正式版。
pub const STABLE_CHANNEL: &str = "stable";

/// 通道选择文件名；与 `diagnostics::data_directory()` 同目录。
pub const CHANNEL_FILE: &str = "update-channel.json";

/// 持久化的通道状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelState {
    /// 用户选择的通道；缺省 `stable`。
    #[serde(default)]
    pub channel: String,
    /// 一次性回退意图：用户从 alpha 关回 stable 时置位，降级成功后清除。
    #[serde(default)]
    pub pending_rollback: bool,
}

impl ChannelState {
    pub fn stable() -> Self {
        Self { channel: STABLE_CHANNEL.to_owned(), pending_rollback: false }
    }
}

/// 通道文件的绝对路径；`base` 是壳层数据目录。
pub fn channel_file(base: &Path) -> PathBuf {
    base.join(CHANNEL_FILE)
}

/// 合法通道名：小写字母开头，与 release-cli 的 `--channel` 同形。
fn valid_channel_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

/// 读出通道状态；缺失、超长、非法 JSON 或非法通道名一律回落 `stable`。
///
/// 回落不是错误路径：用户换了安装包、文件被外部工具改坏、或从旧版本升上来都可能走到这里。
pub fn read_state(file: &Path) -> ChannelState {
    let Ok(raw) = fs::read_to_string(file) else {
        return ChannelState::stable();
    };
    if raw.len() > 4096 {
        return ChannelState::stable();
    }
    let Ok(parsed) = serde_json::from_str::<ChannelState>(&raw) else {
        return ChannelState::stable();
    };
    if !valid_channel_name(&parsed.channel) {
        return ChannelState::stable();
    }
    parsed
}

/// 原子写入通道状态（临时文件 + rename，Unix 0600）。
pub fn write_state(file: &Path, state: &ChannelState) -> Result<(), String> {
    if !valid_channel_name(&state.channel) {
        return Err(format!("非法更新通道：{}", state.channel));
    }
    let body = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = file.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut output = options.open(&temporary)?;
        output.write_all(body.as_bytes())?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

/// 解析出「本次实际查询哪个通道」：选中的通道不在可用集合内时回退 `stable`。
///
/// 返回 `(通道, 是否发生了回退)`，让调用方能记一条告警而不必重算。
pub fn effective_channel<'a>(requested: &'a str, available: &'a [String]) -> (&'a str, bool) {
    if available.iter().any(|name| name == requested) {
        (requested, false)
    } else {
        (STABLE_CHANNEL, requested != STABLE_CHANNEL)
    }
}

/// 本次检查是否允许安装低于当前版本的包。
///
/// 只有「存在回退意图 + 当前运行的是预发布版」这一条路径为真。其余情况一律拒绝降级，
/// 避免被降级攻击的 feed 把用户拉回旧版本（旧包签名仍然有效，签名校验拦不住）。
pub fn allows_downgrade(state: &ChannelState, current_version: &str) -> bool {
    state.pending_rollback && is_prerelease(current_version)
}

/// 版本是否带预发布后缀（`0.2.0-alpha.3` 是，`0.2.0` 不是，`0.2.0+build.7` 也不是）。
pub fn is_prerelease(version: &str) -> bool {
    let trimmed = version.trim();
    // 先去掉构建元数据（`+` 之后），它不表达先后关系。
    let without_build = trimmed.split('+').next().unwrap_or("");
    let Some((core, tag)) = without_build.split_once('-') else {
        return false;
    };
    if tag.is_empty() {
        return false;
    }
    let mut parts = core.split('.');
    let triple = (parts.next(), parts.next(), parts.next(), parts.next());
    match triple {
        (Some(major), Some(minor), Some(patch), None) => {
            [major, minor, patch]
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("woohaa-channel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_file_is_stable() {
        let dir = temp_dir();
        let state = read_state(&channel_file(&dir));
        assert_eq!(state, ChannelState::stable());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn corrupt_file_falls_back_to_stable() {
        let dir = temp_dir();
        let file = channel_file(&dir);
        fs::write(&file, b"{not json").unwrap();
        assert_eq!(read_state(&file), ChannelState::stable());
        // 非法通道名同样回落，而不是带着坏名字继续。
        fs::write(&file, br#"{"channel":"../evil","pendingRollback":false}"#).unwrap();
        assert_eq!(read_state(&file), ChannelState::stable());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn round_trip_preserves_rollback_intent() {
        let dir = temp_dir();
        let file = channel_file(&dir);
        let state = ChannelState { channel: "alpha".into(), pending_rollback: true };
        write_state(&file, &state).unwrap();
        assert_eq!(read_state(&file), state);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn channel_outside_available_set_falls_back_to_stable() {
        let available = vec!["stable".to_string()];
        assert_eq!(effective_channel("alpha", &available), ("stable", true));
        assert_eq!(effective_channel("stable", &available), ("stable", false));
        let both = vec!["stable".to_string(), "alpha".to_string()];
        assert_eq!(effective_channel("alpha", &both), ("alpha", false));
    }

    #[test]
    fn downgrade_only_when_rollback_pending_and_running_prerelease() {
        let pending = ChannelState { channel: STABLE_CHANNEL.into(), pending_rollback: true };
        assert!(allows_downgrade(&pending, "0.2.0-alpha.3"));
        // 已经是正式版：回退意图不该触发任何降级。
        assert!(!allows_downgrade(&pending, "0.2.0"));
        // 没有意图：通道内一律拒绝降级。
        assert!(!allows_downgrade(&ChannelState::stable(), "0.2.0-alpha.3"));
    }

    #[test]
    fn prerelease_detection() {
        assert!(is_prerelease("0.2.0-alpha.3"));
        assert!(is_prerelease("0.2.0-rc.1"));
        assert!(!is_prerelease("0.2.0"));
        assert!(!is_prerelease("0.2.0+build.7"));
        assert!(!is_prerelease(""));
    }
}
