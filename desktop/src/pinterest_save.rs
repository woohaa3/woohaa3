//! Pinterest 窗口右键「保存到素材库 / 发送到画布」的下载与暂存。
//!
//! ## 为什么由桌面壳下载
//!
//! 宿主 Node 后端的 `fetch` 不读系统代理，而 `i.pinimg.com` 在国内直连会命中被污染的 DNS
//! （实测解析到一个 Facebook 地址段），表现为超时。这里的 reqwest 开了 `system-proxy`，
//! 会读 Windows 注册表里的系统代理 —— 能打开 Pinterest 的用户本来就在用代理。
//!
//! ## 安全边界（这个模块是页面脚本能触达的最远处）
//!
//! 触发下载的是 **Pinterest 页面里的脚本**（外部网页）：它只能发一个哨兵导航，带上图片地址。
//! 所以地址必须当作**不可信输入**：
//!
//! - **只允许 `https://*.pinimg.com`**（含重定向的每一跳）。否则页面脚本等于能让用户的电脑去请求
//!   任意地址，包括内网服务（SSRF）；
//! - 32 MB 上限，**边读边数**，不是读完再判断；
//! - 只认 png / jpeg / webp / gif 的魔数 —— 服务端返回的 `Content-Type` 经常对不上，
//!   也不能让一个 HTML 错误页被当成图片存下来；
//! - 并发上限，暂存有 TTL 与总量上限：主窗口没接住事件时，字节不会在内存里越堆越多。
//!
//! ## 暂存
//!
//! 下载完的字节放在内存里，给主窗口一个一次性 id；主窗口经原生协议 `/pinterest-blob?id=` **取走即删**，
//! 再用现成的 `mediaRemote.upload` 上传（同源、不需要令牌）。不落盘：这是中转，不是缓存。

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Url;

/// 单张图的大小上限。
pub const MAX_BYTES: usize = 32 * 1024 * 1024;
/// 下载整体超时（含连接）。
const TIMEOUT: Duration = Duration::from_secs(30);
/// 重定向最多跟几跳，且每一跳都必须仍在 pinimg 上。
const MAX_REDIRECTS: usize = 3;
/// 同时进行的下载数。连点右键不该把带宽和内存打满。
const MAX_CONCURRENT: usize = 3;
/// 暂存存活时间。主窗口没来取（事件丢了 / 页面刷新）就自动清掉。
const STORE_TTL: Duration = Duration::from_secs(120);
/// 暂存总字节上限。
const STORE_MAX_BYTES: usize = 128 * 1024 * 1024;
/// 暂存条数上限。
const STORE_MAX_ITEMS: usize = 16;

const SITE_HOST: &str = "pinimg.com";
/// Pinterest 图片地址的尺寸段。换成 `originals` 能拿到原图；猜错的尺寸段会 403，所以只是「优先尝试」。
const SIZE_SEGMENTS: [&str; 6] = ["75x75_RS", "236x", "474x", "564x", "736x", "1200x"];

fn host_matches(host: &str, base: &str) -> bool {
    host == base || host.strip_suffix(base).is_some_and(|prefix| prefix.ends_with('.'))
}

/// 图片地址白名单：`https://*.pinimg.com`，无账号密码，端口缺省或 443。
pub fn is_allowed_image_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.port(), None | Some(443))
        && url.host_str().is_some_and(|host| host_matches(host, SITE_HOST))
}

/// 候选下载地址：先试原图，再回落到页面给的原地址。
pub fn candidates(src: &Url) -> Vec<Url> {
    let mut out = Vec::new();
    let mut segments = src.path().trim_start_matches('/').splitn(2, '/');
    if let (Some(segment), Some(rest)) = (segments.next(), segments.next()) {
        if SIZE_SEGMENTS.contains(&segment) {
            if let Ok(original) = src.join(&format!("/originals/{rest}")) {
                if is_allowed_image_url(&original) {
                    out.push(original);
                }
            }
        }
    }
    out.push(src.clone());
    out
}

/// 按魔数判断图片格式，返回 MIME。不信任响应头里的 `Content-Type`。
pub fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    None
}

pub struct Downloaded {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

async fn fetch_one(url: &Url) -> Result<Downloaded, String> {
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent("sixi-desktop/0.1")
        // 重定向的每一跳都必须仍在 pinimg 上：否则 pinimg 上的一个跳转就能把请求带去别处
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS || !is_allowed_image_url(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|error| format!("初始化下载失败：{error}"))?;

    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("下载失败：HTTP {}", response.status()));
    }
    // 重定向被 stop 时会停在 3xx；上面的 is_success 已经挡掉。这里再确认最终地址没跑出白名单。
    if !is_allowed_image_url(response.url()) {
        return Err("下载被拒绝：重定向到了站外".into());
    }
    if response.content_length().is_some_and(|len| len as usize > MAX_BYTES) {
        return Err("图片太大".into());
    }

    // 边读边数：不能先全读进内存再判断大小
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| format!("读取图片失败：{error}"))? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("图片太大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let mime = sniff_mime(&bytes).ok_or_else(|| "下载到的不是图片（可能是错误页或防盗链）".to_string())?;
    Ok(Downloaded { bytes, mime })
}

/// 下载一张图：先试原图，失败回落到原地址。两次都失败时把**最后一次**的原因带回去。
pub async fn download(src: &Url) -> Result<Downloaded, String> {
    if !is_allowed_image_url(src) {
        return Err("只允许下载 Pinterest 图片".into());
    }
    let mut last = String::from("下载失败");
    for url in candidates(src) {
        match fetch_one(&url).await {
            Ok(done) => return Ok(done),
            Err(error) => last = error,
        }
    }
    Err(last)
}

static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

/// 占一个下载名额；满了返回 `None`。名额随返回值释放（`Drop`），异常退出也不会漏。
pub struct Permit;

pub fn try_acquire() -> Option<Permit> {
    let mut current = IN_FLIGHT.load(Ordering::Acquire);
    loop {
        if current >= MAX_CONCURRENT {
            return None;
        }
        match IN_FLIGHT.compare_exchange(current, current + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return Some(Permit),
            Err(actual) => current = actual,
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::AcqRel);
    }
}

struct Entry {
    bytes: Vec<u8>,
    mime: &'static str,
    stored_at: Instant,
}

/// 内存暂存。时间由调用方传入，测试不用真的等 2 分钟。
#[derive(Default)]
pub struct Store {
    entries: HashMap<String, Entry>,
}

impl Store {
    fn sweep(&mut self, now: Instant) {
        self.entries.retain(|_, entry| now.duration_since(entry.stored_at) < STORE_TTL);
    }

    fn total_bytes(&self) -> usize {
        self.entries.values().map(|entry| entry.bytes.len()).sum()
    }

    pub fn put(&mut self, now: Instant, id: String, bytes: Vec<u8>, mime: &'static str) -> Result<(), String> {
        self.sweep(now);
        if self.entries.len() >= STORE_MAX_ITEMS || self.total_bytes() + bytes.len() > STORE_MAX_BYTES {
            return Err("暂存已满，请稍后再试".into());
        }
        self.entries.insert(id, Entry { bytes, mime, stored_at: now });
        Ok(())
    }

    /// 取走即删。过期的当作不存在。
    pub fn take(&mut self, now: Instant, id: &str) -> Option<(Vec<u8>, &'static str)> {
        self.sweep(now);
        self.entries.remove(id).map(|entry| (entry.bytes, entry.mime))
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

/// 暂存一张下载好的图，返回一次性 id。
pub fn stash(bytes: Vec<u8>, mime: &'static str) -> Result<String, String> {
    let id = uuid::Uuid::new_v4().to_string();
    // 锁中毒不该让功能永久不可用：暂存只是中转，状态都在条目里
    let mut guard = store().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.put(Instant::now(), id.clone(), bytes, mime)?;
    Ok(id)
}

/// 主窗口取走暂存的图。取走即删。
pub fn take(id: &str) -> Option<(Vec<u8>, &'static str)> {
    let mut guard = store().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.take(Instant::now(), id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn only_https_pinimg_is_allowed() {
        assert!(is_allowed_image_url(&url("https://i.pinimg.com/736x/ab/cd/x.jpg")));
        assert!(is_allowed_image_url(&url("https://s.pinimg.com/a.png")));
        assert!(is_allowed_image_url(&url("https://pinimg.com/a.png")));
    }

    #[test]
    fn rejects_ssrf_style_targets() {
        // 页面脚本是外部网页：这些都是它可能拿来打内网 / 别处的地址
        for raw in [
            "http://i.pinimg.com/a.jpg",
            "https://127.0.0.1/a.jpg",
            "https://localhost/a.jpg",
            "https://192.168.1.1/a.jpg",
            "https://169.254.169.254/latest/meta-data/",
            "https://evilpinimg.com/a.jpg",
            "https://pinimg.com.evil.example/a.jpg",
            "https://i.pinimg.com@evil.example/a.jpg",
            "https://user:pw@i.pinimg.com/a.jpg",
            "https://i.pinimg.com:8443/a.jpg",
            "file:///C:/Windows/win.ini",
            "data:image/png;base64,AAAA",
        ] {
            assert!(!is_allowed_image_url(&url(raw)), "{raw} 不该放行");
        }
    }

    #[test]
    fn tries_originals_first_then_falls_back_to_the_given_url() {
        let list = candidates(&url("https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].as_str(), "https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg");
        assert_eq!(list[1].as_str(), "https://i.pinimg.com/736x/ab/cd/ef/abcdef.jpg");
    }

    #[test]
    fn does_not_guess_unknown_size_segments() {
        // 猜错的尺寸段会 403：不认识的就只用原地址
        let list = candidates(&url("https://i.pinimg.com/weird/ab/x.jpg"));
        assert_eq!(list.len(), 1);
        let already = candidates(&url("https://i.pinimg.com/originals/ab/x.jpg"));
        assert_eq!(already.len(), 1);
    }

    #[test]
    fn sniffs_by_magic_bytes_not_content_type() {
        assert_eq!(sniff_mime(b"\x89PNG\r\n\x1a\n1234"), Some("image/png"));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0x00]), Some("image/jpeg"));
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBPVP8 ");
        assert_eq!(sniff_mime(&webp), Some("image/webp"));
        assert_eq!(sniff_mime(b"GIF89a.."), Some("image/gif"));
        // HTML 错误页 / 防盗链提示不能被当成图片
        assert_eq!(sniff_mime(b"<!DOCTYPE html>"), None);
        assert_eq!(sniff_mime(b""), None);
    }

    #[test]
    fn store_is_take_once() {
        let mut store = Store::default();
        let now = Instant::now();
        store.put(now, "a".into(), vec![1, 2, 3], "image/png").unwrap();
        assert_eq!(store.take(now, "a"), Some((vec![1, 2, 3], "image/png")));
        assert_eq!(store.take(now, "a"), None, "取走即删，不能取第二次");
    }

    #[test]
    fn store_expires_entries_nobody_collected() {
        let mut store = Store::default();
        let start = Instant::now();
        store.put(start, "a".into(), vec![1], "image/png").unwrap();
        // 主窗口没接住事件：过了 TTL 自动清掉，不会一直占内存
        assert_eq!(store.take(start + STORE_TTL + Duration::from_secs(1), "a"), None);
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn store_is_bounded_by_count_and_bytes() {
        let mut store = Store::default();
        let now = Instant::now();
        for index in 0..STORE_MAX_ITEMS {
            store.put(now, index.to_string(), vec![0], "image/png").unwrap();
        }
        assert!(store.put(now, "overflow".into(), vec![0], "image/png").is_err());

        let mut big = Store::default();
        assert!(big.put(now, "x".into(), vec![0; STORE_MAX_BYTES + 1], "image/png").is_err());
        // 过期的要先清掉再判断容量：否则满了之后永远装不进新的
        store.sweep(now + STORE_TTL + Duration::from_secs(1));
        assert!(store.put(now + STORE_TTL + Duration::from_secs(1), "fresh".into(), vec![0], "image/png").is_ok());
    }

    #[test]
    fn permits_are_bounded_and_released_on_drop() {
        let mut held = Vec::new();
        for _ in 0..MAX_CONCURRENT {
            held.push(try_acquire().expect("名额内应当能拿到"));
        }
        assert!(try_acquire().is_none(), "超过并发上限必须拒绝");
        held.pop();
        assert!(try_acquire().is_some(), "释放后名额应当归还");
    }
}
