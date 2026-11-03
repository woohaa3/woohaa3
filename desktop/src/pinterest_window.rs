//! 资源栏「Pinterest」：点一下弹出一个独立的 Pinterest 窗口。
//!
//! ## 为什么是独立窗口，不是资源栏里再展开一块
//!
//! 第一版是把 Pinterest 嵌成资源栏右边 300 像素宽的子 webview。实测它被挤成窄窄一条，
//! Pinterest 的页面按窄屏断点排版，文字竖排、卡片被截断，根本没法浏览。
//! Pinterest 本来就是要宽版面的瀑布流站点，独立窗口让用户自己摆放大小，
//! 也不再和原生 Bevy 画布抢同一块窗口区域。
//!
//! ## 窗口关系
//!
//! 以主窗口为 owner：始终显示在主窗口之上、随主窗口最小化，不会被画布窗口盖到后面去。
//! 关掉就销毁；再点会重新建。登录态不丢 —— WebView2 的 Cookie 在同一份用户数据目录里。
//!
//! ## 和主窗口的隔离
//!
//! - 不带 `initialization_script`：主窗口的 `__WOOHAA_NATIVE__` token 只注入在 `main` 上，
//!   这里不能让外部网页拿到它；
//! - 自定义协议 `woohaa-native` 本来就只认 `webview_label() == "main"`（见 `transport.rs`），
//!   这个窗口的 label 是 `pinterest-window`，调用会被拒；
//! - 导航只放行 `pinterest.com` 与登录用的 Google 账号域，其余一律取消；
//! - 新窗口只放行同一批域（登录弹窗要用），其余拒绝。
//!
//! ## 线程：绝不能在主线程里调用
//!
//! 在 Windows 上，于主线程（同步命令 / 事件处理器）里创建 webview 或窗口会**死锁**
//! （Tauri 文档的 Known issues，https://github.com/tauri-apps/wry/issues/583）。
//! 第一版把 `add_child` 放在 `transport.rs` 的 `run_on_main_thread` 回调里，实测点开 Pinterest 后
//! 主窗口网页整个卡死、没有任何报错。现在 `transport.rs` 对 `/pinterest` 单独起线程处理，
//! 本模块的 [`control`] 因此**只能从非主线程调用**。
//!
//! ## 锁
//!
//! 不再被主线程串行，就要自己加锁：连点两下时各自「查是否已有 → 没有就建」会都看到「没有」，
//! 第二次建窗口因 label 重复失败。一把锁把「查 + 建 / 聚焦」变成整体。

use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{Value, json};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

/// 窗口的 label。不是 `main`，所以过不了 `woohaa-native` 协议的来源检查。
pub const LABEL: &str = "pinterest-window";
const HOME: &str = "https://www.pinterest.com/";
const SITE_HOST: &str = "pinterest.com";
/// 登录要经过的域。只放进导航与弹窗白名单，不是产品内容来源。
const LOGIN_HOSTS: &[&str] = &["accounts.google.com"];

/// 请求体上限。只有一个动作。
const MAX_BODY: usize = 128;

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Action {
    Open,
}

/// 调用方能说的只有「打开」。**没有地址、没有尺寸字段**：地址写死在 Rust 里，
/// 尺寸由窗口自己决定，用户拖拽即可。`deny_unknown_fields` 保证多塞字段会被直接拒绝。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    action: Action,
}

fn parse(body: &[u8]) -> Result<Request, String> {
    if body.len() > MAX_BODY {
        return Err("Pinterest request exceeds budget".into());
    }
    serde_json::from_slice(body).map_err(|error| error.to_string())
}

fn host_matches(host: &str, base: &str) -> bool {
    host == base || host.strip_suffix(base).is_some_and(|prefix| prefix.ends_with('.'))
}

/// 站内导航：只允许 https 的 `pinterest.com`（含子域）。
fn is_site(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| host_matches(host, SITE_HOST))
}

fn is_login(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|host| LOGIN_HOSTS.contains(&host))
}

fn is_allowed(url: &Url) -> bool {
    is_site(url) || is_login(url)
}

/// 串行化「查 + 建 / 聚焦」。见模块文档的「锁」一节。
static GUARD: Mutex<()> = Mutex::new(());

/// 处理 `/pinterest` 请求。**必须在非主线程调用** —— 主线程里建窗口会死锁（见模块文档）。
pub fn control(app: &AppHandle, body: &[u8]) -> Result<Value, String> {
    let request = parse(body)?;
    // 锁中毒（上一次持锁时 panic）不该让这个入口永久不可用：状态都在窗口里，不在锁里。
    let _guard = GUARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    match request.action {
        Action::Open => open(app),
    }
}

fn open(app: &AppHandle) -> Result<Value, String> {
    // 已经开着：不重建，只是显示并拉到前面 —— 重建会丢掉用户浏览的位置
    if let Some(existing) = app.get_webview_window(LABEL) {
        existing.show().map_err(|error| error.to_string())?;
        // 最小化的要先还原，否则 set_focus 只会让任务栏图标闪一下
        let _ = existing.unminimize();
        existing.set_focus().map_err(|error| error.to_string())?;
        return Ok(json!({ "state": "focused", "created": false }));
    }

    let home = Url::parse(HOME).map_err(|error| error.to_string())?;
    let popup_app = app.clone();

    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(home))
        .title("Pinterest")
        // Pinterest 要宽版面：给到能排出 4～5 列瀑布流的默认尺寸，用户可以自己拖
        .inner_size(1180.0, 820.0)
        .min_inner_size(640.0, 480.0)
        .center()
        // 原型阶段要看得见页面到底加载到了哪一步（白屏、被拦、被重定向）
        .on_page_load(|_window, payload| {
            crate::diagnostics::stderr(format_args!(
                "pinterest window page {:?}: {}",
                payload.event(),
                payload.url()
            ))
        })
        // 站外链接（品牌官网、原链接）一律不跳：窗口没有地址栏，原地打开别人的站点回不来
        .on_navigation(is_allowed)
        .on_new_window(move |url, features| {
            // 登录弹窗（Google 授权页）走宿主已有的授权窗口，其余拒绝
            if is_allowed(&url) {
                crate::web_popups::create(&popup_app, url, features)
            } else {
                NewWindowResponse::Deny
            }
        });

    // 以主窗口为 owner：始终在它之上、随它最小化。找不到主窗口就退化成独立窗口，不报错 ——
    // 能打开比「必须挂在谁下面」重要。
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.owner(&main).map_err(|error| error.to_string())?;
    }

    let window = builder.build().map_err(|error| error.to_string())?;
    // 去掉继承来的应用菜单栏（「帮助 / 工作区」）：浏览网页的窗口里不该有数据搬家入口
    crate::web_popups::strip_menu(&window);
    Ok(json!({ "state": "opened", "created": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    #[test]
    fn site_navigation_stays_on_pinterest() {
        assert!(is_allowed(&url("https://www.pinterest.com/")));
        assert!(is_allowed(&url("https://pinterest.com/pin/123/")));
        assert!(is_allowed(&url("https://cn.pinterest.com/search/pins/?q=chair")));
    }

    #[test]
    fn rejects_lookalikes_and_foreign_hosts() {
        for raw in [
            "https://evilpinterest.com/",
            "https://pinterest.com.evil.example/",
            "https://example.com/",
            "http://www.pinterest.com/",
            "https://user:pw@www.pinterest.com/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "tauri://localhost/",
            "woohaa-native://localhost/window",
        ] {
            assert!(!is_allowed(&url(raw)), "{raw} 不该放行");
        }
    }

    #[test]
    fn login_hosts_are_exact_not_suffix() {
        assert!(is_allowed(&url("https://accounts.google.com/o/oauth2/auth")));
        assert!(!is_allowed(&url("https://evil.accounts.google.com.example/")));
        assert!(!is_allowed(&url("https://google.com/")));
    }

    #[test]
    fn parses_open_only() {
        assert_eq!(parse(br#"{"action":"open"}"#).unwrap().action, Action::Open);
    }

    #[test]
    fn caller_cannot_choose_the_address_or_other_actions() {
        // 最关键的一条：调用方不能指定要打开什么地址
        assert!(parse(br#"{"action":"open","url":"https://evil.example"}"#).is_err());
        // 旧版的矩形字段、显隐动作都已经不存在
        assert!(parse(br#"{"action":"open","x":0,"y":0,"width":10,"height":10}"#).is_err());
        assert!(parse(br#"{"action":"show"}"#).is_err());
        assert!(parse(br#"{"action":"hide"}"#).is_err());
        assert!(parse(br#"{"action":"navigate"}"#).is_err());
    }

    #[test]
    fn oversized_body_is_rejected_before_parsing() {
        let body = vec![b' '; MAX_BODY + 1];
        assert!(parse(&body).is_err());
    }

    /// 守住那个**编译器和别的单测都发现不了**的死锁：窗口 / webview 在 Windows 的主线程里创建会死锁，
    /// 表现为点开 Pinterest 后整个主窗口网页卡死、没有任何报错。
    /// 结构上的保证只有一条：`/pinterest` 的分发必须在 `run_on_main_thread` 之前，并走独立线程。
    #[test]
    fn pinterest_is_dispatched_off_the_main_thread() {
        let source = include_str!("transport.rs");
        let pinterest = source
            .find("path() == \"/pinterest\"")
            .expect("transport.rs 里找不到 /pinterest 的分发");
        let main_thread = source
            .find("run_on_main_thread(move ||")
            .expect("transport.rs 里找不到 run_on_main_thread");
        assert!(
            pinterest < main_thread,
            "/pinterest 必须在 run_on_main_thread 之前分发：窗口 / webview 在主线程里创建会死锁"
        );
        let branch = &source[pinterest..main_thread];
        assert!(branch.contains("std::thread::spawn"), "/pinterest 必须在独立线程里处理");
    }
}
