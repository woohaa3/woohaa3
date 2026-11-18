//! Startup update gate. Discovery failures permit offline use; a discovered update never does.
//!
//! 通道（change: 2026-11-18-add-desktop-update-channels）：本安装包能查哪些 feed 由构建期写入
//! `desktop-runtime.json` 的 `updater.endpoints` 决定；本次查哪个由用户设置决定。stable 安装包
//! 根本没有 alpha 地址，因此普通用户在产物层面就够不到开发者版本。
use crate::update_channel::{self, ChannelState};
use serde::Deserialize;
use std::{path::Path, time::Duration};
use tauri_plugin_updater::UpdaterExt;
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub host_archive_sha256: Option<String>,
    pub updater: Option<UpdateChannel>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannel {
    /// 本安装包自身的通道（`stable` / `alpha`）；旧产物没有该字段。
    #[serde(default)]
    pub channel: Option<String>,
    /// 通道 → feed 地址。旧产物只有单字符串 `endpoint`，此时该映射为空。
    #[serde(default)]
    pub endpoints: Option<std::collections::BTreeMap<String, String>>,
    /// 旧产物的单一 feed 地址；仅在没有 `endpoints` 时使用。
    #[serde(default)]
    pub endpoint: Option<String>,
    pub public_key: String,
}
pub fn read_config(resources: &Path) -> Result<RuntimeConfig, String> {
    let path = resources.join("desktop-runtime.json");
    if !path.exists() {
        return Ok(RuntimeConfig::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

impl UpdateChannel {
    /// 本安装包可查询的通道名集合；旧产物等价于只有 `stable`。
    pub fn available(&self) -> Vec<String> {
        match &self.endpoints {
            Some(endpoints) if !endpoints.is_empty() => endpoints.keys().cloned().collect(),
            _ => vec![update_channel::STABLE_CHANNEL.to_owned()],
        }
    }

    /// 指定通道的 feed 地址；只有旧产物会忽略通道名。
    pub fn endpoint_for(&self, channel: &str) -> Option<String> {
        match &self.endpoints {
            Some(endpoints) => endpoints.get(channel).cloned(),
            None => self
                .endpoint
                .clone()
                .filter(|_| channel == update_channel::STABLE_CHANNEL),
        }
    }
}

/// 一次启动检查的上下文：查哪个 feed、是否允许降级。
pub struct Decision {
    pub channel: String,
    pub endpoint: String,
    pub allow_downgrade: bool,
    /// 回退意图是否仍需在成功安装后清除。
    pub clear_rollback_after_install: bool,
}

/// 结合构建期可用集合与用户设置决定本次查询目标。
///
/// 返回 `Err` 只表示配置本身不可用（缺地址、缺公钥、非 HTTPS）；通道不匹配一律降级到
/// stable 而不是失败——用户换了安装包后残留的 alpha 选择不该让应用打不开。
pub fn decide(channel: &UpdateChannel, state: &ChannelState, current_version: &str) -> Result<Decision, String> {
    let available = channel.available();
    let (effective, fell_back) = update_channel::effective_channel(&state.channel, &available);
    if fell_back {
        crate::shell_log::warn(&format!(
            "update channel {} not provided by this build; using {}",
            state.channel, effective
        ));
    }
    let endpoint = channel
        .endpoint_for(effective)
        .ok_or_else(|| format!("缺少 {effective} 通道的更新地址"))?;
    if endpoint.trim().is_empty() || channel.public_key.trim().is_empty() {
        return Err("更新通道必须配置 HTTPS 地址和签名公钥".into());
    }
    // 只有「用户主动关回 stable」这一条路径允许降级，且要求当前确实是预发布版。
    let allow_downgrade = update_channel::allows_downgrade(state, current_version);
    Ok(Decision {
        channel: effective.to_owned(),
        endpoint,
        allow_downgrade,
        clear_rollback_after_install: allow_downgrade,
    })
}

pub fn startup(
    app: &tauri::AppHandle,
    resources: &Path,
    required: &std::sync::atomic::AtomicBool,
    status: impl Fn(&str),
) -> Result<bool, String> {
    let config = read_config(resources)?;
    let Some(channel) = config.updater else {
        status("更新通道未配置，正在启动当前版本…");
        crate::diagnostics::stderr(format_args!("desktop updater: unconfigured"));
        if required.load(std::sync::atomic::Ordering::Acquire) {
            return Err("必须完成已发现的更新".into());
        }
        return Ok(false);
    };
    let channel_file = crate::diagnostics::data_directory().map(|base| update_channel::channel_file(&base));
    let state = channel_file
        .as_deref()
        .map(update_channel::read_state)
        .unwrap_or_else(ChannelState::stable);
    let current_version = app.package_info().version.to_string();
    let decision = decide(&channel, &state, &current_version)?;
    let endpoint = tauri::Url::parse(&decision.endpoint).map_err(|e| e.to_string())?;
    if endpoint.scheme() != "https" {
        return Err("更新通道必须配置 HTTPS 地址和签名公钥".into());
    }
    crate::diagnostics::stderr(format_args!(
        "desktop updater: channel={} endpoint={} downgrade={}",
        decision.channel, endpoint, decision.allow_downgrade
    ));
    tauri::async_runtime::block_on(async {
        status("正在检查更新…");
        let builder = app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .pubkey(channel.public_key.clone())
            .timeout(Duration::from_secs(15));
        // 回退意图生效时换成「只要目标版本不同就升级」的比较器，否则保持默认的「必须更高」。
        let builder = if decision.allow_downgrade {
            builder.version_comparator(|current, release| release.version != current)
        } else {
            builder
        };
        let updater = builder.build().map_err(|e| e.to_string())?;
        let update = match updater.check().await {
            Ok(update) => update,
            Err(error) => {
                crate::diagnostics::stderr(format_args!("desktop updater check failed: {error}"));
                crate::shell_log::warn(&format!("desktop updater check failed: {error}"));
                if required.load(std::sync::atomic::Ordering::Acquire) {
                    return Err(format!("必须更新，但检查失败: {error}"));
                }
                status("检查更新失败，正在启动当前版本…");
                return Ok(false);
            }
        };
        if let Some(update) = update {
            required.store(true, std::sync::atomic::Ordering::Release);
            status("发现新版本，必须完成更新；正在下载并验证…");
            let bytes = update
                .download(|_, _| {}, || {})
                .await
                .map_err(|e| format!("必须更新，但下载失败: {e}"))?;
            // Startup gate runs before spawning the host: no database writer is alive.
            status("正在安装更新…");
            update
                .install(bytes)
                .map_err(|e| format!("必须更新，但安装失败: {e}"))?;
            // 降级成功后清掉一次性回退意图；失败路径在上面直接返回，意图自然保留给下次启动。
            if decision.clear_rollback_after_install {
                clear_rollback(channel_file.as_deref(), &state);
            }
            return Ok(true);
        }
        if required.load(std::sync::atomic::Ordering::Acquire) {
            return Err("必须完成已发现的更新".into());
        }
        // 有回退意图但当前已是正式版：没有可降级的目标，清掉意图避免一直挂着。
        if state.pending_rollback && !update_channel::is_prerelease(&current_version) {
            clear_rollback(channel_file.as_deref(), &state);
        }
        Ok(false)
    })
}

/// 清掉回退意图并保留用户选中的通道。
pub(crate) fn clear_rollback(file: Option<&Path>, state: &ChannelState) {
    let Some(file) = file else { return };
    let cleared = ChannelState { channel: state.channel.clone(), pending_rollback: false };
    if let Err(error) = update_channel::write_state(file, &cleared) {
        crate::shell_log::warn(&format!("update channel state not cleared: {error}"));
    }
}

/// 本安装包可查询的通道集合，供设置面展示选项。
///
/// 读不到随包配置时退化为只有 `stable`：设置面因此不会给用户一个查不到的通道。
pub fn available_channels(app: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    app.path()
        .resource_dir()
        .ok()
        .and_then(|resources| read_config(&resources).ok())
        .and_then(|config| config.updater)
        .map(|channel| channel.available())
        .unwrap_or_else(|| vec![update_channel::STABLE_CHANNEL.to_owned()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(endpoints: &[(&str, &str)]) -> UpdateChannel {
        UpdateChannel {
            channel: None,
            endpoints: Some(endpoints.iter().map(|(name, url)| ((*name).to_owned(), (*url).to_owned())).collect()),
            endpoint: None,
            public_key: "test-public-key".into(),
        }
    }

    #[test]
    fn missing_channel_is_explicitly_unconfigured() {
        let root = std::env::temp_dir().join(format!("woohaa-update-{}", uuid::Uuid::new_v4()));
        assert!(read_config(&root).unwrap().updater.is_none());
    }
    #[test]
    fn runtime_channel_reads_endpoint_and_signature_key() {
        let root = std::env::temp_dir().join(format!("woohaa-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("desktop-runtime.json"),br#"{"nodeVersion":"24.22.0","updater":{"endpoint":"https://cdn.example/update.json","publicKey":"test-public-key"}}"#).unwrap();
        let channel = read_config(&root).unwrap().updater.unwrap();
        assert_eq!(channel.endpoints, None);
        // 旧产物等价于只有 stable。
        assert_eq!(channel.available(), vec![update_channel::STABLE_CHANNEL.to_owned()]);
        assert_eq!(channel.endpoint_for("stable").as_deref(), Some("https://cdn.example/update.json"));
        assert_eq!(channel.endpoint_for("alpha"), None);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stable_build_cannot_reach_alpha_feed() {
        let channel = channel(&[("stable", "https://cdn.example/stable/latest.json")]);
        let decision = decide(&channel, &ChannelState::stable(), "0.1.26").unwrap();
        assert_eq!(decision.channel, "stable");
        assert_eq!(decision.endpoint, "https://cdn.example/stable/latest.json");
        assert!(!decision.allow_downgrade);
        // 即使设置里残留 alpha，这个包也没有 alpha 地址，回落到 stable。
        let stale = ChannelState { channel: "alpha".into(), pending_rollback: false };
        let decision = decide(&channel, &stale, "0.1.26").unwrap();
        assert_eq!(decision.channel, "stable");
    }
    #[test]
    fn alpha_build_queries_alpha_when_selected() {
        let channel = channel(&[
            ("stable", "https://cdn.example/stable/latest.json"),
            ("alpha", "https://cdn.example/alpha/latest.json"),
        ]);
        let alpha = ChannelState { channel: "alpha".into(), pending_rollback: false };
        let decision = decide(&channel, &alpha, "0.2.0-alpha.3").unwrap();
        assert_eq!(decision.channel, "alpha");
        assert_eq!(decision.endpoint, "https://cdn.example/alpha/latest.json");
        assert!(!decision.allow_downgrade);
        // 默认设置仍然查 stable。
        let decision = decide(&channel, &ChannelState::stable(), "0.2.0-alpha.3").unwrap();
        assert_eq!(decision.channel, "stable");
    }
    #[test]
    fn rollback_intent_enables_downgrade_only_from_prerelease() {
        let channel = channel(&[
            ("stable", "https://cdn.example/stable/latest.json"),
            ("alpha", "https://cdn.example/alpha/latest.json"),
        ]);
        let rollback = ChannelState { channel: "stable".into(), pending_rollback: true };
        let decision = decide(&channel, &rollback, "0.2.0-alpha.4").unwrap();
        assert!(decision.allow_downgrade);
        assert!(decision.clear_rollback_after_install);
        // 已经是正式版时不触发降级。
        let decision = decide(&channel, &rollback, "0.2.0").unwrap();
        assert!(!decision.allow_downgrade);
        assert!(!decision.clear_rollback_after_install);
    }
}
