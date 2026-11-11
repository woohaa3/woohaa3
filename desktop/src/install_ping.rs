//! 持久安装 ID 与启动 ping（WOO-65 / WOO-66，桌面形态）。
//!
//! 桌面启动路径专用：
//! - 安装 ID 是随机 UUID v4（不掺任何硬件指纹），落在 `diagnostics::data_directory()` 下的
//!   `install-id`；缺失、空内容或非法内容重建，临时文件 + rename 原子写入；
//! - **受「外部上报遥测」总开关约束**（`telemetry.export.enabled`，缺省 false）：关闭时一条
//!   都不发，**也不生成安装 ID**；桌面壳无法直连宿主设置服务（`client/web/**` 不在本任务范围），
//!   因此只读宿主写出的配置文件（`WOOHAA3_CONFIG_FILE`，缺省 `data_directory()/config/woohaa.config.yml`），
//!   读取失败/文件不存在/键缺失一律按关闭处理——宁可少发，不能误发；
//! - 每次启动最多一条 GET，端点可配置（`WOOHAA3_INSTALL_PING_URL`），缺省
//!   `https://woohaa3.zombee.tech/woohaa/ping`；参数 `install_id`、`v`、`os`，全部百分号编码；
//! - 约 3s 超时、失败静默、不重试、不阻塞启动：异步派发，启动路径不等网络、也不等磁盘；
//! - 日志只记事件与错误码，不写 URL query（其中含安装 ID）。
//!
//! `os` 使用 `平台-架构` 口径（如 `darwin-arm64`）；安装 ID 只代表桌面安装。

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

/// 端点环境变量；值为空串时退回缺省。
pub const INSTALL_PING_URL_ENV: &str = "WOOHAA3_INSTALL_PING_URL";
/// 官方 EdgeOne 计数端点。
pub const DEFAULT_INSTALL_PING_URL: &str = "https://woohaa3.zombee.tech/woohaa/ping";
/// 请求超时。
pub const INSTALL_PING_TIMEOUT_MS: u64 = 3000;
/// 安装 ID 文件名；与 `diagnostics::data_directory()` 同目录。
pub const INSTALL_ID_FILE: &str = "install-id";
/// 配置文件上限；它只是开关所在的小文件，挡住异常大的输入。
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

/// 启动 ping 的开关来源：桌面壳只读宿主配置文件里的这一项。
pub type EnabledSource = Box<dyn Fn() -> bool + Send + Sync>;

static STARTED: OnceLock<()> = OnceLock::new();

/// 安装 ID 文件路径；`base` 是 `diagnostics::data_directory()`。
pub fn install_id_file(base: &Path) -> PathBuf {
    base.join(INSTALL_ID_FILE)
}

/// 宿主配置文件路径：显式环境变量优先，否则 `data_directory()/config/woohaa.config.yml`。
///
/// 这与 `scripts/lib/desktop-host-data.mjs` 的 `desktopEnvironment` 给出的
/// `WOOHAA3_CONFIG_FILE` 一致（`<数据目录>/config/woohaa.config.yml`）。
pub fn config_file(env_file: Option<PathBuf>, base: &Path) -> PathBuf {
    env_file.unwrap_or_else(|| base.join("config").join("woohaa.config.yml"))
}

/// UUID v4 形态（不区分大小写，允许首尾空白）。
fn normalize(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return None;
    }
    let groups: Vec<&str> = value.split('-').collect();
    if groups.iter().map(|g| g.len()).collect::<Vec<_>>() != [8, 4, 4, 4, 12] {
        return None;
    }
    if !bytes.iter().all(|b| b.is_ascii_hexdigit() || *b == b'-') {
        return None;
    }
    // 版本位固定为 4，变体位是 8/9/a/b（RFC 9562）。
    match (value.as_bytes().get(14), value.as_bytes().get(19)) {
        (Some(b'4'), Some(v)) if matches!(v, b'8' | b'9' | b'a' | b'b') => Some(value),
        _ => None,
    }
}

/// 读出安装 ID；文件缺失、为空或内容非法时生成新的并原子写入。
///
/// 读失败（权限、目录不存在等）也走重建路径：拿不到旧 ID 时宁可换一个 ID，也不阻塞启动。
/// 写失败只让本次返回值不落盘（下次启动再试），不抛错——安装 ID 缺失不该影响业务。
pub fn read_or_create_install_id(file: &Path, generate: impl FnOnce() -> String) -> String {
    let existing = fs::read_to_string(file)
        .ok()
        .map(|raw| if raw.len() > 256 { String::new() } else { raw })
        .and_then(|raw| normalize(&raw));
    if let Some(id) = existing {
        return id;
    }
    let created = normalize(&generate()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let _ = write_atomic(file, &created);
    created
}

/// 临时文件 + rename；Unix 上权限 0600（安装 ID 只属于本用户）。
///
/// 已存在的旧文件（含损坏内容）由 rename 整体替换，不会留下半写入的中间态。
fn write_atomic(file: &Path, value: &str) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
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
        output.write_all(value.as_bytes())?;
        output.write_all(b"\n")?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, file)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// 按段编码 URI 查询参数值（RFC 3986 `pchar`/`query` 子集下的保守集合）。
///
/// 保留字母、数字与 `-._~`；其余一律百分号编码。安装 ID 本身是 UUID，不含特殊字符，但版本号
/// 可能含 `+`（本地版本）/`-rc`，端点也可能带网关署名参数，所以不能靠字符串拼接。
pub fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn split_fragment(endpoint: &str) -> (&str, &str) {
    match endpoint.find('#') {
        Some(at) => endpoint.split_at(at),
        None => (endpoint, ""),
    }
}

/// 拼接启动 ping 地址：保留端点已有参数，只补/覆盖 `install_id`、`v`、`os`。
pub fn build_install_ping_url(
    endpoint: &str,
    install_id: &str,
    version: &str,
    os: &str,
) -> Result<String, String> {
    let (base, fragment) = split_fragment(endpoint.trim());
    let url = tauri::Url::parse(base).map_err(|_| "启动 ping 端点无效".to_owned())?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("启动 ping 端点必须是 http/https 且不带凭据".into());
    }
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| !matches!(key.as_ref(), "install_id" | "v" | "os"))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    pairs.push(("install_id".into(), install_id.to_owned()));
    pairs.push(("v".into(), version.to_owned()));
    pairs.push(("os".into(), os.to_owned()));
    let query = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode_component(key), encode_component(value)))
        .collect::<Vec<_>>()
        .join("&");
    let origin = if url.port().is_some() {
        format!(
            "{}://{}:{}",
            url.scheme(),
            url.host_str().unwrap_or_default(),
            url.port().unwrap_or_default()
        )
    } else {
        format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
    };
    let path = url.path();
    Ok(format!("{origin}{path}?{query}{fragment}"))
}

/// `os` 参数：与浏览器形态的 `platform-arch` 口径一致（`darwin-arm64` / `win32-x64`）。
pub fn os_name() -> String {
    let platform = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{platform}-{}", std::env::consts::ARCH)
}

/// 端点：显式环境变量优先，空串/非法退回缺省。
pub fn endpoint(configured: Option<&str>) -> String {
    let trimmed = configured.unwrap_or_default().trim();
    if trimmed.is_empty() {
        return DEFAULT_INSTALL_PING_URL.to_owned();
    }
    match tauri::Url::parse(trimmed) {
        Ok(url) if matches!(url.scheme(), "https" | "http") && url.host_str().is_some() => {
            trimmed.to_owned()
        }
        _ => DEFAULT_INSTALL_PING_URL.to_owned(),
    }
}

/// 版本号：`WOOHAA_DESKTOP_VERSION`（打包注入）→ `tauri.conf.json` 的 version → `unknown`。
pub fn version() -> String {
    if let Ok(from_env) = std::env::var("WOOHAA_DESKTOP_VERSION") {
        let trimmed = from_env.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
        .ok()
        .and_then(|value| value["version"].as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_owned())
}

/// 完整开关判定：读取失败/文件缺失/键缺失/类型不对都是关闭。
///
/// 桌面壳只读这一个键，不解释宿主的其它设置；写入由宿主自己完成（设置页 / `/api/settings`）。
pub fn export_enabled(config: &Path) -> bool {
    read_export_enabled(config).unwrap_or(false)
}

fn read_export_enabled(config: &Path) -> Option<bool> {
    let metadata = fs::metadata(config).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    // 宿主写配置是「临时文件 + rename」，这里读到的总是完整旧值或完整新值，不必再取锁。
    parse_export_enabled(&fs::read(config).ok()?)
}

/// 解析 `telemetry.export.enabled`。
///
/// 配置是 YAML。桌面侧只需要一个布尔，所以按真实嵌套路径定位键，再只认两种明确写法：
/// `true` / `false`（大小写不敏感，允许行尾注释）。带引号的字符串、`yes`/`on` 这类
/// 由 YAML 1.1 解析器解释成布尔的写法都**不算打开**——宁可少发。
pub fn parse_export_enabled(bytes: &[u8]) -> Option<bool> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut stack: Vec<(usize, String)> = Vec::new();
    for raw in text.lines() {
        let line = strip_comment(raw);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        if trimmed == "-" || trimmed.starts_with("- ") {
            // 序列项：本键不可能落在序列里，清掉更深的层。
            stack.retain(|(depth, _)| *depth < indent);
            continue;
        }
        let Some((key, value)) = split_key(trimmed) else {
            continue;
        };
        stack.retain(|(depth, _)| *depth < indent);
        let mut full = stack
            .iter()
            .map(|(_, key)| key.as_str())
            .collect::<Vec<_>>()
            .join(".");
        if !full.is_empty() {
            full.push('.');
        }
        full.push_str(&key);
        if full == "telemetry.export.enabled" {
            return parse_bool(value);
        }
        if value.is_empty() {
            stack.push((indent, key));
        }
    }
    None
}

/// 去掉行首空白后的 `# …` 注释；引号内的 `#` 保留。
fn strip_comment(line: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut previous = ' ';
    for (index, ch) in line.char_indices() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (None, '\'' | '"') => quote = Some(ch),
            (None, '#') if previous.is_whitespace() => return &line[..index],
            _ => {}
        }
        previous = ch;
    }
    line
}

/// `key: value`（也接受 `"key": value` 与 `key:`）。值里的 `:` 不参与切分。
fn split_key(line: &str) -> Option<(String, &str)> {
    let (key, rest) = if let Some(stripped) = line.strip_prefix('"') {
        let end = stripped.find('"')?;
        (&stripped[..end], stripped[end + 1..].trim_start())
    } else if let Some(stripped) = line.strip_prefix('\'') {
        let end = stripped.find('\'')?;
        (&stripped[..end], stripped[end + 1..].trim_start())
    } else {
        let at = line.find(':')?;
        (line[..at].trim(), &line[at..])
    };
    let value = rest.strip_prefix(':')?;
    Some((key.to_owned(), value.trim()))
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// 本次启动的安装 ID：读取或生成一次。
///
/// 不跨调用缓存：一次启动只发一条 ping，重复读取的成本可以忽略；缓存反而会在数据目录被
/// 切换（测试、`WOOHAA_DESKTOP_DATA_DIR`）时返回别处的 ID。
pub fn install_id(base: &Path) -> String {
    read_or_create_install_id(&install_id_file(base), || uuid::Uuid::new_v4().to_string())
}

/// 发一条启动 ping，返回是否真的发出了请求。
///
/// 任何失败（超时、网络、非 2xx）只记一个错误码事件，不抛错、不重试；调用方在独立线程里调用，
/// 不占启动路径。
pub fn send_install_ping(
    enabled: bool,
    endpoint: &str,
    base: &Path,
    mut log: impl FnMut(&str, &str),
) -> bool {
    if !enabled {
        return false;
    }
    let id = install_id(base);
    let target = match build_install_ping_url(endpoint, &id, &version(), &os_name()) {
        Ok(target) => target,
        Err(error) => {
            log("install-ping-failed", "invalid-endpoint");
            crate::diagnostics::event(
                "desktop",
                "install-ping-failed",
                serde_json::json!({"code":"invalid-endpoint","reason":error}),
            );
            return true;
        }
    };
    if rustls_provider().is_err() {
        log("install-ping-failed", "tls-init");
        return true;
    }
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(INSTALL_PING_TIMEOUT_MS))
        .no_proxy()
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            log("install-ping-failed", "client-init");
            return true;
        }
    };
    match client.get(&target).header("accept", "*/*").send() {
        Ok(response) => {
            let status = response.status().as_u16();
            if (200..300).contains(&status) {
                log("install-ping-ok", &status.to_string());
                crate::diagnostics::event(
                    "desktop",
                    "install-ping-ok",
                    serde_json::json!({"status":status}),
                );
            } else {
                log("install-ping-failed", &format!("http-{status}"));
            }
        }
        Err(error) => {
            let code = error_code(&error);
            log("install-ping-failed", &code);
            crate::diagnostics::event(
                "desktop",
                "install-ping-failed",
                serde_json::json!({"code":code}),
            );
        }
    }
    true
}

fn error_code(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "timeout".to_owned();
    }
    // 只取分类，不回显 URL（其中含安装 ID）。
    if error.is_connect() {
        "connect".to_owned()
    } else if error.is_body() || error.is_decode() {
        "body".to_owned()
    } else {
        "network".to_owned()
    }
}

/// rustls 的 crypto provider 必须恰好安装一次；与 updater 插件共用同一个全局状态。
static RUSTLS_PROVIDER: OnceLock<Result<(), ()>> = OnceLock::new();

fn rustls_provider() -> Result<(), ()> {
    *RUSTLS_PROVIDER.get_or_init(|| {
        if rustls::crypto::CryptoProvider::get_default().is_some() {
            return Ok(());
        }
        rustls::crypto::ring::default_provider()
            .install_default()
            .map_err(|_| ())
    })
}

/// 开关来源：只读宿主配置文件里的 `telemetry.export.enabled`。
///
/// 桌面壳不直连宿主设置服务（那在 `client/web/**`），只读宿主自己维护的同一份配置文件；
/// 键缺失、文件缺失、解析失败都按关闭处理。每次调用现读，不做缓存（设置项是热重载）。
pub fn config_enabled(config: &Path) -> bool {
    export_enabled(config)
}

/// 把某个配置文件固化成 [`EnabledSource`]（每次调用现读，不缓存）。
pub fn leak_enabled(config: PathBuf) -> EnabledSource {
    Box::new(move || config_enabled(&config))
}

/// 派发一次启动 ping：每个进程最多一次；启动路径不等网络。
///
/// 开关判定与安装 ID 读取都在后台线程完成（本地小文件 I/O，读不到就按关闭处理），即使磁盘很慢
/// 也不会拖住窗口出现。`enabled` 为真时才读取/生成安装 ID，所以关闭开关不会在本地留下安装痕迹。
///
/// 返回是否真的派发了后台线程（`false` 表示本次进程已经派发过或没有数据目录，调用方通常忽略）。
pub fn dispatch(enabled: EnabledSource, endpoint: String) -> bool {
    if STARTED.set(()).is_err() {
        return false;
    }
    let Some(base) = crate::diagnostics::data_directory() else {
        return false;
    };
    std::thread::spawn(move || {
        if !enabled() {
            return;
        }
        send_install_ping(true, &endpoint, &base, log_ping);
    });
    true
}

fn log_ping(event: &str, detail: &str) {
    match event {
        "install-ping-ok" => crate::shell_log::info(&format!("install ping ok status={detail}")),
        _ => crate::shell_log::warn(&format!("install ping failed code={detail}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(format!("woohaa-install-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, text: &str) {
        fs::write(path, text).unwrap();
    }

    const ID: &str = "2b8f0d9a-6a1e-4c2b-8b0f-9d7e5c1a3b64";

    #[test]
    fn install_id_is_created_persisted_and_reused() {
        let base = fixture();
        let file = install_id_file(&base);
        let first = read_or_create_install_id(&file, || ID.into());
        assert_eq!(first, ID);
        assert_eq!(fs::read_to_string(&file).unwrap(), format!("{ID}\n"));
        let second = read_or_create_install_id(&file, || "0".repeat(36));
        assert_eq!(second, ID, "已有合法 ID 时不再生成");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn generated_install_id_is_uuid_v4() {
        let base = fixture();
        let id =
            read_or_create_install_id(&install_id_file(&base), || uuid::Uuid::new_v4().to_string());
        assert_eq!(normalize(&id).as_deref(), Some(id.as_str()));
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn empty_or_invalid_install_id_is_rebuilt() {
        for content in ["", "   \n", "not-a-uuid", "2b8f0d9a-6a1e-1c2b-8b0f-9d7e5c1a3b64"] {
            let base = fixture();
            let file = install_id_file(&base);
            write(&file, content);
            let id = read_or_create_install_id(&file, || ID.into());
            assert_eq!(id, ID, "{content:?}");
            assert_eq!(fs::read_to_string(&file).unwrap(), format!("{ID}\n"));
            fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn uppercase_and_padded_install_id_is_normalized() {
        let base = fixture();
        let file = install_id_file(&base);
        write(&file, &format!("  {}  \n", ID.to_uppercase()));
        assert_eq!(read_or_create_install_id(&file, || "0".repeat(36)), ID);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn install_id_lands_under_the_diagnostics_data_directory() {
        assert_eq!(
            install_id_file(Path::new("/data/app")),
            PathBuf::from("/data/app/install-id")
        );
        let base = crate::diagnostics::data_directory();
        if let Some(base) = base {
            if std::env::var_os("WOOHAA_DESKTOP_DATA_DIR").is_none() {
                assert!(install_id_file(&base).starts_with(&base));
            }
        }
    }

    #[test]
    fn ping_url_encodes_parameters_and_keeps_endpoint_extras() {
        let url = build_install_ping_url(
            "https://count.example/ping?site=woo&sig=a%20b",
            ID,
            "1.0.0-rc.1+meta",
            "darwin-arm64",
        )
        .unwrap();
        assert!(url.starts_with("https://count.example/ping?site=woo&sig=a%20b&"));
        assert!(url.contains(&format!("install_id={ID}")));
        assert!(url.contains("v=1.0.0-rc.1%2Bmeta"));
        assert!(url.contains("os=darwin-arm64"));
    }

    #[test]
    fn ping_url_overrides_stale_parameters_and_rejects_credentials() {
        let url = build_install_ping_url(
            "https://count.example/ping?v=old&install_id=x",
            ID,
            "0.1.20",
            "linux-x86_64",
        )
        .unwrap();
        assert_eq!(url.matches("install_id=").count(), 1);
        assert_eq!(url.matches("v=").count(), 1);
        assert!(url.contains("v=0.1.20"));
        assert!(
            build_install_ping_url("https://user:pass@count.example/ping", ID, "1", "os").is_err()
        );
        assert!(build_install_ping_url("file:///tmp/ping", ID, "1", "os").is_err());
    }

    #[test]
    fn default_endpoint_matches_the_desktop_endpoint() {
        assert_eq!(endpoint(None), DEFAULT_INSTALL_PING_URL);
        assert_eq!(endpoint(Some("  ")), DEFAULT_INSTALL_PING_URL);
        assert_eq!(
            endpoint(Some("https://edge.example/ping")),
            "https://edge.example/ping"
        );
        assert_eq!(endpoint(Some("not-a-url")), DEFAULT_INSTALL_PING_URL);
        assert_eq!(DEFAULT_INSTALL_PING_URL, "https://woohaa3.zombee.tech/woohaa/ping");
    }

    #[test]
    fn export_switch_defaults_to_off() {
        let base = fixture();
        assert!(!export_enabled(&config_file(None, &base)));
        let config = config_file(None, &base);
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        write(&config, "telemetry:\n  local:\n    enabled: true\n");
        assert!(!export_enabled(&config), "缺键按关闭");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn export_switch_reads_the_nested_boolean() {
        assert_eq!(
            parse_export_enabled(b"telemetry:\n  export:\n    enabled: true\n"),
            Some(true)
        );
        assert_eq!(
            parse_export_enabled(b"telemetry:\n  export:\n    enabled: false\n"),
            Some(false)
        );
        assert_eq!(
            parse_export_enabled(b"# comment\ntelemetry:\n  export:\n    enabled: TRUE  # on\n"),
            Some(true)
        );
        assert_eq!(
            parse_export_enabled(b"telemetry:\n  export:\n    enabled: \"true\"\n"),
            None,
            "字符串不算打开"
        );
        assert_eq!(
            parse_export_enabled(b"storage:\n  telemetry:\n    export:\n      enabled: true\n"),
            None,
            "只认顶层 telemetry"
        );
        assert_eq!(
            parse_export_enabled(b"telemetry:\n  export:\n    enabled: true\n    other: 1\n"),
            Some(true)
        );
    }

    #[test]
    fn enabled_switch_sends_a_single_encoded_request() {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/woohaa/ping?site=woo", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
            // 204 不带 body：客户端读完响应头就会返回，不需要额外收尾。
            let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
            let _ = stream.flush();
            request
        });
        let base = fixture();
        let config = config_file(None, &base);
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        write(&config, "telemetry:\n  export:\n    enabled: true\n");
        let mut events = Vec::new();
        let sent = send_install_ping(
            export_enabled(&config),
            &endpoint,
            &base,
            |event, detail| events.push(format!("{event}:{detail}")),
        );
        let request = server.join().unwrap();
        assert!(sent, "开关打开时必须真的发出请求");
        let expected = format!(
            "GET /woohaa/ping?site=woo&install_id={}&v={}&os={} HTTP/1.1",
            install_id(&base),
            encode_component(&version()),
            encode_component(&os_name())
        );
        assert_eq!(request.lines().next().unwrap(), expected);
        assert_eq!(events, ["install-ping-ok:204"]);
        let id = fs::read_to_string(install_id_file(&base)).unwrap();
        assert_eq!(id.trim(), install_id(&base), "安装 ID 落盘并复用");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn failed_ping_is_silent_and_does_not_block() {
        let base = fixture();
        // 绑定后立刻释放端口：连接被拒绝，发送方拿到错误而不是 panic。
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let mut events = Vec::new();
        let started = std::time::Instant::now();
        let sent = send_install_ping(
            true,
            &format!("http://127.0.0.1:{port}/ping"),
            &base,
            |event, detail| events.push(format!("{event}:{detail}")),
        );
        assert!(sent);
        assert!(started.elapsed() < Duration::from_millis(INSTALL_PING_TIMEOUT_MS + 2000));
        assert!(events.iter().any(|event| event.starts_with("install-ping-failed:")));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn disabled_switch_sends_nothing() {
        let base = fixture();
        assert!(!send_install_ping(
            export_enabled(&config_file(None, &base)),
            DEFAULT_INSTALL_PING_URL,
            &base,
            |_, _| panic!("开关关闭时不应记录请求"),
        ));
        assert!(!install_id_file(&base).exists(), "开关关闭时不生成安装 ID");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn os_parameter_uses_platform_arch_pairs() {
        let os = os_name();
        assert!(os.contains('-'));
        let platform = os.split('-').next().unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(platform, "darwin");
        } else if cfg!(windows) {
            assert_eq!(platform, "windows");
        } else {
            assert_eq!(platform, "linux");
        }
    }

    #[test]
    fn version_comes_from_tauri_conf() {
        let version = version();
        assert!(!version.is_empty());
        assert_ne!(version, "unknown");
    }
}
