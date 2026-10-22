//! 打包运行期默认值（change: 2026-10-14-migrate-canvas-to-tauri-native-bevy，
//! 任务 6.7 / 6.9 的资源接线前置）。
//!
//! 发行 bundle 通过 `bundle.resources` 携带 `woohaa-desktop.defaults.json`，由
//! `scripts/build-desktop.mjs` 生成，形如 `{ "version": 1, "uiUrl": "http://127.0.0.1:5180/" }`。
//!
//! 界面地址优先级：`--ui-url` > `WOOHAA_DESKTOP_URL` > bundle 默认值 > 内置前端资源。
//!
//! 这里只读、只接受 http/https，且任何失败都不阻止启动：调用方回退到内置前端资源并打印诊断，
//! 不把包内资源错误升级成崩溃，也不接受任意 scheme 的跳转。

use std::path::Path;

/// bundle 内的默认值资源名；与 `scripts/lib/desktop-release.mjs` 的常量保持一致。
pub const DEFAULTS_RESOURCE: &str = "woohaa-desktop.defaults.json";

/// 默认值文件上限：它是包内资源，只需挡住异常大的输入。
pub const MAX_DEFAULTS_BYTES: u64 = 64 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Defaults {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    ui_url: Option<String>,
}

/// 解析默认值文档。`uiUrl` 缺省或为 `null` 表示不覆盖；非法地址报错，不静默回退成任意 URL。
pub fn parse_defaults(bytes: &[u8]) -> Result<Option<String>, String> {
    if bytes.len() as u64 > MAX_DEFAULTS_BYTES {
        return Err(format!("默认值文件超过 {MAX_DEFAULTS_BYTES} 字节"));
    }
    let defaults: Defaults = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    match defaults.version {
        None | Some(1) => {}
        Some(other) => return Err(format!("不支持的默认值版本：{other}")),
    }
    let Some(ui_url) = defaults.ui_url else {
        return Ok(None);
    };
    let parsed = tauri::Url::parse(&ui_url).map_err(|error| error.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("界面地址只接受 http/https：{}", parsed.scheme()));
    }
    Ok(Some(parsed.to_string()))
}

/// 读取默认值文件；文件不存在返回 `Ok(None)`（未打包，或构建时没有注入地址）。
pub fn read_defaults(path: &Path) -> Result<Option<String>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if metadata.len() > MAX_DEFAULTS_BYTES {
        return Err(format!("默认值文件超过 {MAX_DEFAULTS_BYTES} 字节"));
    }
    parse_defaults(&std::fs::read(path).map_err(|error| error.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_url_is_optional_and_scheme_bounded() {
        assert_eq!(parse_defaults(br#"{"version":1,"uiUrl":null}"#).unwrap(), None);
        assert_eq!(parse_defaults(br#"{"version":1}"#).unwrap(), None);
        assert_eq!(
            parse_defaults(br#"{"version":1,"uiUrl":"http://127.0.0.1:5180/"}"#)
                .unwrap()
                .as_deref(),
            Some("http://127.0.0.1:5180/")
        );
        assert_eq!(
            parse_defaults(br#"{"uiUrl":"https://example.test/app/"}"#)
                .unwrap()
                .as_deref(),
            Some("https://example.test/app/")
        );
        // 越权/未知输入一律拒绝，而不是被忽略后落到默认资源。
        assert!(parse_defaults(br#"{"version":1,"uiUrl":"file:///etc/passwd"}"#).is_err());
        assert!(parse_defaults(br#"{"version":1,"uiUrl":"tauri://localhost/"}"#).is_err());
        assert!(parse_defaults(br#"{"version":9,"uiUrl":"http://127.0.0.1/"}"#).is_err());
        assert!(parse_defaults(br#"{"version":1,"uiUrl":"http://127.0.0.1/","token":"x"}"#).is_err());
        assert!(parse_defaults(b"not json").is_err());
        assert!(parse_defaults(&vec![b' '; MAX_DEFAULTS_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn missing_defaults_file_is_not_an_error() {
        let path = Path::new("target/woohaa-desktop-defaults-absent.json");
        assert_eq!(read_defaults(path).unwrap(), None);
    }
}
