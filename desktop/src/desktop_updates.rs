//! Startup update gate. Discovery failures permit offline use; a discovered update never does.
//!
//! The update channel is either an explicit HTTPS endpoint (self-hosted CDN) or a GitHub
//! Release asset; resolution and validation live in `crate::update_channel`. Both must be
//! signed: the endpoint only supplies an index, the public key still gates installation.
use serde::Deserialize;
use std::{path::Path, time::Duration};
use tauri_plugin_updater::UpdaterExt;

use crate::update_channel::GithubRef;

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    pub host_archive_sha256: Option<String>,
    pub updater: Option<UpdateChannel>,
}

/// 更新通道：显式 endpoint 与 GitHub Release 二选一（同时配置会被拒绝）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannel {
    #[serde(default)]
    pub endpoint: Option<String>,
    pub public_key: String,
    #[serde(default)]
    pub github: Option<GithubChannel>,
}

/// GitHub Release 通道：仓库 + 平台索引资产名；`release` 缺省跟随最新正式发布。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubChannel {
    pub repo: String,
    pub asset: String,
    #[serde(default)]
    pub release: Option<String>,
}
pub fn read_config(resources: &Path) -> Result<RuntimeConfig, String> {
    let path = resources.join("desktop-runtime.json");
    if !path.exists() {
        return Ok(RuntimeConfig::default());
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub fn startup(
    app: &tauri::AppHandle,
    resources: &Path,
    required: &std::sync::atomic::AtomicBool,
    status: impl Fn(&str),
) -> Result<bool, String> {
    let config = read_config(resources)?;
    let Some(channel) = config.updater else {
        return unconfigured(required, &status, "更新通道未配置，正在启动当前版本…");
    };
    let endpoint = crate::update_channel::resolve(
        channel.endpoint.as_deref(),
        channel.github.as_ref().map(|github| GithubRef {
            repo: &github.repo,
            asset: &github.asset,
            release: github.release.as_deref().unwrap_or_default(),
        }),
    )
    .map_err(|error| format!("更新通道配置无效：{error}"))?;
    let Some(endpoint) = endpoint else {
        return unconfigured(required, &status, "更新通道未配置，正在启动当前版本…");
    };
    if channel.public_key.trim().is_empty() {
        return Err("更新通道必须配置签名公钥".into());
    }
    let url = tauri::Url::parse(&endpoint).map_err(|e| format!("更新地址无效: {e}"))?;
    if url.scheme() != "https" {
        return Err("更新通道必须配置 HTTPS 地址和签名公钥".into());
    }
    tauri::async_runtime::block_on(async {
        status("正在检查更新…");
        let updater = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .pubkey(channel.public_key)
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        let update = match updater.check().await {
            Ok(update) => update,
            Err(error) => {
                crate::diagnostics::stderr(format_args!(
                    "desktop updater check failed: {error} (endpoint: {endpoint})"
                ));
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
            return Ok(true);
        }
        if required.load(std::sync::atomic::Ordering::Acquire) {
            return Err("必须完成已发现的更新".into());
        }
        Ok(false)
    })
}

/// 没有可用通道：已发现的更新仍必须完成，否则允许按当前版本启动。
fn unconfigured(
    required: &std::sync::atomic::AtomicBool,
    status: &impl Fn(&str),
    message: &str,
) -> Result<bool, String> {
    status(message);
    crate::diagnostics::stderr(format_args!("desktop updater: unconfigured"));
    if required.load(std::sync::atomic::Ordering::Acquire) {
        return Err("必须完成已发现的更新".into());
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(
            channel.endpoint.as_deref(),
            Some("https://cdn.example/update.json")
        );
        assert_eq!(channel.public_key, "test-public-key");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn runtime_channel_reads_github_release_asset() {
        let root = std::env::temp_dir().join(format!("woohaa-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("desktop-runtime.json"),
            br#"{"updater":{"publicKey":"k","github":{"repo":"acme/woohaa","asset":"latest-darwin-aarch64.json"}}}"#,
        )
        .unwrap();
        let channel = read_config(&root).unwrap().updater.unwrap();
        let github = channel.github.unwrap();
        assert_eq!(github.repo, "acme/woohaa");
        let endpoint = crate::update_channel::resolve(
            None,
            Some(GithubRef {
                repo: &github.repo,
                asset: &github.asset,
                release: github.release.as_deref().unwrap_or_default(),
            }),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            endpoint,
            "https://github.com/acme/woohaa/releases/latest/download/latest-darwin-aarch64.json"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn conflicting_channels_are_rejected_at_resolution() {
        let github = GithubRef {
            repo: "acme/woohaa",
            asset: "latest.json",
            release: "latest",
        };
        assert!(
            crate::update_channel::resolve(Some("https://cdn.example/latest.json"), Some(github))
                .is_err()
        );
    }
}
