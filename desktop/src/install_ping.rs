//! 持久安装 ID 与启动 ping（WOO-65 / WOO-66，桌面形态）。
//!
//! 桌面启动路径专用：
//! - 安装 ID 是随机 UUID v4（不掺任何硬件指纹），落在 `diagnostics::data_directory()` 下的
//!   `install-id`；缺失、空内容或非法内容重建，临时文件 + rename 原子写入；
//! - **默认上报，不读任何开关**：桌面壳每次启动都发这一条，不查宿主设置、不读配置文件；
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

static STARTED: OnceLock<()> = OnceLock::new();

/// 安装 ID 文件路径；`base` 是 `diagnostics::data_directory()`。
pub fn install_id_file(base: &Path) -> PathBuf {
    base.join(INSTALL_ID_FILE)
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
pub fn send_install_ping(endpoint: &str, base: &Path, mut log: impl FnMut(&str, &str)) -> bool {
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

/// 派发一次启动 ping：每个进程最多一次；启动路径不等网络。
///
/// 安装 ID 读取与请求都在后台线程完成（本地小文件 I/O），即使磁盘很慢也不会拖住窗口出现。
/// 不读任何开关：只要能确定数据目录，每次启动都发这一条。
///
/// 返回是否真的派发了后台线程（`false` 表示本次进程已经派发过或没有数据目录，调用方通常忽略）。
pub fn dispatch(endpoint: String) -> bool {
    if STARTED.set(()).is_err() {
        return false;
    }
    let Some(base) = crate::diagnostics::data_directory() else {
        return false;
    };
    std::thread::spawn(move || {
        send_install_ping(&endpoint, &base, log_ping);
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
    fn sends_a_single_encoded_request() {
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
        let mut events = Vec::new();
        let sent = send_install_ping(
            &endpoint,
            &base,
            |event, detail| events.push(format!("{event}:{detail}")),
        );
        let request = server.join().unwrap();
        assert!(sent, "每次启动都必须真的发出请求");
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
