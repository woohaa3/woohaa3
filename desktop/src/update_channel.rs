//! 更新通道解析：显式 HTTPS 地址，或 GitHub Release 上的更新索引资产。
//!
//! 只做纯字符串校验与 URL 拼接，不依赖 tauri/serde，因此可以用
//! `rustc --test desktop/src/update_channel.rs` 单独验证。配置反序列化留在
//! `desktop_updates`：那里把 `endpoint` / `github` 两个字段交给本模块解析。
//!
//! 约定的 GitHub 布局（与 `scripts/lib/desktop-release-index.mjs` 一致）：
//!
//! - 索引资产：`latest-<平台键>.json`，例如 `latest-darwin-aarch64.json`；
//!   `release = "latest"` 时经 `releases/latest/download/` 取最新正式发布，
//!   指定 tag 时经 `releases/download/<tag>/` 取该发布（预发布通道）。
//! - 安装包：`releases/download/<tag>/<归档名>`，URL 写在索引的平台条目里。

/// GitHub Release 通道的原始配置字段。
pub struct GithubRef<'a> {
    pub repo: &'a str,
    pub asset: &'a str,
    pub release: &'a str,
}

/// `release` 缺省值：跟随 GitHub 的“最新正式发布”。
pub const DEFAULT_RELEASE: &str = "latest";

/// 解析最终更新地址。
///
/// 返回 `Ok(None)` 表示两端都未配置——这是明确的“未配置”，调用方按离线启动处理，
/// 不当成错误。同时配置两种通道、或任一字段不合法时返回 `Err`。
pub fn resolve(
    endpoint: Option<&str>,
    github: Option<GithubRef<'_>>,
) -> Result<Option<String>, String> {
    let endpoint = endpoint.map(str::trim).filter(|value| !value.is_empty());
    if endpoint.is_some() && github.is_some() {
        return Err("更新通道只能配置一种：endpoint 或 github".into());
    }
    if let Some(endpoint) = endpoint {
        validate_https(endpoint)?;
        return Ok(Some(endpoint.to_string()));
    }
    let Some(github) = github else {
        return Ok(None);
    };
    let repo = validate_repo(github.repo)?;
    let asset = validate_segment(github.asset, "asset")?;
    let release = github.release.trim();
    let release = if release.is_empty() {
        DEFAULT_RELEASE
    } else {
        release
    };
    let url = if release == DEFAULT_RELEASE {
        format!("https://github.com/{repo}/releases/latest/download/{asset}")
    } else {
        let tag = validate_segment(release, "release")?;
        format!("https://github.com/{repo}/releases/download/{tag}/{asset}")
    };
    Ok(Some(url))
}

/// 更新索引必须是 HTTPS；只接受带主机名的绝对地址。
fn validate_https(endpoint: &str) -> Result<(), String> {
    let Some(rest) = endpoint.strip_prefix("https://") else {
        return Err("更新地址必须是 HTTPS".into());
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() || host.contains(' ') || rest.contains(char::is_whitespace) {
        return Err("更新地址缺少有效主机名".into());
    }
    Ok(())
}

/// `owner/name`：正好一个分隔符，两段都非空且只含安全字符。
fn validate_repo(repo: &str) -> Result<&str, String> {
    let repo = repo.trim();
    let mut parts = repo.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err("GitHub 仓库必须是 owner/name 形式".into());
    };
    for part in [owner, name] {
        if part.is_empty() || !part.chars().all(is_safe_char) || part == "." || part == ".." {
            return Err("GitHub 仓库名包含不支持的字符".into());
        }
    }
    Ok(repo)
}

/// 单段路径（资产名、tag）：不允许分隔符、空白、控制字符与 `..`。
fn validate_segment<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("GitHub {field} 不能为空"));
    }
    if !value.chars().all(is_safe_char) || value == "." || value == ".." || value.contains("..") {
        return Err(format!("GitHub {field} 包含不支持的字符"));
    }
    Ok(value)
}

fn is_safe_char(value: char) -> bool {
    value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-' | '+')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_https_endpoint_wins_and_is_returned_verbatim() {
        let endpoint = "https://updates.example.com/win/latest.json";
        assert_eq!(
            resolve(Some(endpoint), None).unwrap().as_deref(),
            Some(endpoint)
        );
    }

    #[test]
    fn nothing_configured_is_an_explicit_unconfigured_state() {
        assert_eq!(resolve(None, None).unwrap(), None);
        assert_eq!(resolve(Some("  "), None).unwrap(), None);
    }

    #[test]
    fn both_channels_at_once_is_rejected() {
        let github = GithubRef {
            repo: "acme/woohaa",
            asset: "latest-win.json",
            release: "latest",
        };
        let error = resolve(Some("https://example.com/latest.json"), Some(github)).unwrap_err();
        assert!(error.contains("只能配置一种"), "{}", error);
    }

    #[test]
    fn github_latest_points_at_the_stable_release_asset() {
        let github = GithubRef {
            repo: "acme/woohaa",
            asset: "latest-darwin-aarch64.json",
            release: "latest",
        };
        assert_eq!(
            resolve(None, Some(github)).unwrap().as_deref(),
            Some(
                "https://github.com/acme/woohaa/releases/latest/download/latest-darwin-aarch64.json"
            )
        );
    }

    #[test]
    fn github_prerelease_tag_points_at_that_release() {
        let github = GithubRef {
            repo: "acme/woohaa",
            asset: "latest-windows-x86_64.json",
            release: "v1.2.3-rc.1",
        };
        assert_eq!(
            resolve(None, Some(github)).unwrap().as_deref(),
            Some(
                "https://github.com/acme/woohaa/releases/download/v1.2.3-rc.1/latest-windows-x86_64.json"
            )
        );
    }

    #[test]
    fn empty_release_falls_back_to_latest() {
        let github = GithubRef {
            repo: "acme/woohaa",
            asset: "latest.json",
            release: "",
        };
        assert!(
            resolve(None, Some(github))
                .unwrap()
                .unwrap()
                .starts_with("https://github.com/acme/woohaa/releases/latest/download/")
        );
    }

    #[test]
    fn invalid_values_are_rejected_instead_of_producing_odd_urls() {
        for repo in [
            "acme",
            "acme/",
            "/woohaa",
            "a/b/c",
            "acme/..",
            "acme/wo ohaa",
        ] {
            let github = GithubRef {
                repo,
                asset: "latest.json",
                release: "latest",
            };
            assert!(resolve(None, Some(github)).is_err(), "repo={}", repo);
        }
        for asset in ["", "..", "a/b.json", "a b.json"] {
            let github = GithubRef {
                repo: "acme/woohaa",
                asset,
                release: "latest",
            };
            assert!(resolve(None, Some(github)).is_err(), "asset={}", asset);
        }
        for release in ["../main", "v1/2", "v1 2"] {
            let github = GithubRef {
                repo: "acme/woohaa",
                asset: "latest.json",
                release,
            };
            assert!(resolve(None, Some(github)).is_err(), "release={}", release);
        }
    }

    #[test]
    fn insecure_endpoints_are_rejected() {
        for endpoint in [
            "http://example.com/latest.json",
            "example.com/latest.json",
            "https://",
        ] {
            assert!(
                resolve(Some(endpoint), None).is_err(),
                "endpoint={}",
                endpoint
            );
        }
    }
}
