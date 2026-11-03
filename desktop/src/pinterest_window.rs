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
//! - 只注入 `pinterest_menu.js`（右键菜单），**不带**主窗口的 `__WOOHAA_NATIVE__` token ——
//!   那个只注入在 `main` 上，外部网页不能拿到它；脚本与 Rust 的唯一通道是哨兵导航（见下）；
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

/// 右键菜单脚本。作为 `initialization_script` 注入，只在顶层框架运行。
const MENU_SCRIPT: &str = include_str!("pinterest_menu.js");

/// 页面脚本「请求保存」的哨兵地址。`.invalid` 是保留顶级域，永远解析不了：
/// 即使导航没被拦住也不会真的发出网络请求。
const SAVE_SENTINEL_HOST: &str = "sixi-pinterest.invalid";

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

/// 页面脚本能请求的两件事。**没有第三种**：页面不能指定别的动作。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SaveMode {
    /// 保存到素材库（不属于任何画布）。
    Library,
    /// 发送到当前画布（放一个图片节点）。
    Canvas,
}

impl SaveMode {
    fn as_str(self) -> &'static str {
        match self {
            SaveMode::Library => "library",
            SaveMode::Canvas => "canvas",
        }
    }
}

#[derive(Debug, PartialEq)]
pub struct SaveRequest {
    pub mode: SaveMode,
    pub src: Url,
    pub title: String,
    pub page: String,
}

/// 是不是保存哨兵（只看地址形状，不校验参数）。
fn is_save_signal(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(SAVE_SENTINEL_HOST) && url.path() == "/save"
}

const MAX_TITLE_CHARS: usize = 200;
const MAX_PAGE_CHARS: usize = 1000;

/// 解析并**校验**页面发来的保存请求。页面是外部网页，所有字段都不可信：
/// 地址必须是 pinimg 的 https 图片（见 `pinterest_save::is_allowed_image_url`），其余字段只截断、不执行。
fn parse_save(url: &Url) -> Result<SaveRequest, String> {
    let mut mode = None;
    let mut src = None;
    let mut title = String::new();
    let mut page = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "mode" => {
                mode = match value.as_ref() {
                    "library" => Some(SaveMode::Library),
                    "canvas" => Some(SaveMode::Canvas),
                    _ => None,
                }
            }
            "src" => src = Some(value.into_owned()),
            "title" => title = value.chars().take(MAX_TITLE_CHARS).collect(),
            "page" => page = value.chars().take(MAX_PAGE_CHARS).collect(),
            _ => {}
        }
    }
    let mode = mode.ok_or_else(|| "未知的保存方式".to_string())?;
    let src = Url::parse(&src.ok_or_else(|| "缺少图片地址".to_string())?).map_err(|_| "图片地址无效".to_string())?;
    if !crate::pinterest_save::is_allowed_image_url(&src) {
        return Err("只允许保存 Pinterest 的图片".into());
    }
    Ok(SaveRequest { mode, src, title, page })
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
    let nav_app = app.clone();

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
        .initialization_script(MENU_SCRIPT)
        .on_navigation(move |url| {
            // 页面脚本请求保存：取消这次「导航」，在后台线程里下载。必须在放行判断之前识别，
            // 否则哨兵地址（合法的 https）会真的被导航过去。
            if is_save_signal(url) {
                match parse_save(url) {
                    Ok(request) => handle_save(&nav_app, request),
                    Err(error) => toast(&nav_app, &format!("保存失败：{error}"), false),
                }
                return false;
            }
            is_allowed(url)
        })
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

/// 取查询串里的一个参数（`id=...`）。只给原生协议的 `/pinterest-blob` 用。
pub fn query_param(query: &str, name: &str) -> Option<String> {
    Url::parse(&format!("https://x.invalid/?{query}"))
        .ok()?
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// 主窗口回报保存结果。只有两个字段，`deny_unknown_fields`：主窗口之外的东西不该借它传数据。
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Report {
    ok: bool,
    message: String,
}

const MAX_REPORT_BODY: usize = 2048;
const MAX_REPORT_MESSAGE: usize = 200;

/// 把主窗口的处理结果弹给 Pinterest 窗口里的用户。`message` 会被截断；
/// 经 `toast` 的 JSON 序列化后再进脚本，不会被当成代码执行。
pub fn report(app: &AppHandle, body: &[u8]) -> Result<(), String> {
    if body.len() > MAX_REPORT_BODY {
        return Err("Pinterest report exceeds budget".into());
    }
    let report: Report = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    let message: String = report.message.chars().take(MAX_REPORT_MESSAGE).collect();
    toast(app, &message, report.ok);
    Ok(())
}

/// 往 Pinterest 窗口弹一条提示。文案经 JSON 序列化后拼进脚本，不会被当成代码执行。
pub fn toast(app: &AppHandle, message: &str, ok: bool) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let message = serde_json::to_string(message).unwrap_or_else(|_| "\"\"".into());
        let _ = window.eval(format!("window.__sixiPinToast && window.__sixiPinToast({message}, {ok})"));
    }
}

/// 处理页面发来的保存请求：下载 → 暂存 → 通知主窗口来取。
///
/// **绝不能在调用方线程里做事**：`on_navigation` 回调跑在 UI 线程上，下载是网络 IO。
/// 这里立刻起线程，回调马上返回 `false`（取消导航）。
fn handle_save(app: &AppHandle, request: SaveRequest) {
    let Some(permit) = crate::pinterest_save::try_acquire() else {
        toast(app, "正在处理的图片太多，请稍后再试", false);
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        // 名额随 permit 释放：线程异常退出也不会漏
        let _permit = permit;
        toast(&app, "正在保存…", true);
        let outcome = tauri::async_runtime::block_on(crate::pinterest_save::download(&request.src))
            .and_then(|done| crate::pinterest_save::stash(done.bytes, done.mime));
        match outcome {
            Ok(id) => notify_main(&app, &id, &request),
            Err(error) => toast(&app, &format!("保存失败：{error}"), false),
        }
    });
}

/// 通知主窗口来取图。主窗口前端挂着 `window.__sixiPinterestSave`（见宿主前端 `pinterest-save.ts`）。
/// 没挂上（例如前端还没加载完）就明确告诉用户，而不是让暂存悄悄过期。
fn notify_main(app: &AppHandle, id: &str, request: &SaveRequest) {
    let Some(main) = app.get_webview_window("main") else {
        toast(app, "保存失败：找不到主窗口", false);
        return;
    };
    let payload = json!({
        "id": id,
        "mode": request.mode.as_str(),
        "title": request.title,
        "sourceUrl": request.src.as_str(),
        "pageUrl": request.page,
    });
    // 两层序列化：payload 先成 JSON 字符串，再作为字符串字面量嵌入脚本，主窗口里再 JSON.parse。
    // 不拼接任何页面给的文字进代码位置。
    let literal = serde_json::to_string(&payload.to_string()).unwrap_or_else(|_| "\"{}\"".into());
    let script = format!(
        "(function(){{var h=window.__sixiPinterestSave;if(typeof h==='function'){{h(JSON.parse({literal}));return true;}}return false;}})()"
    );
    if main.eval(script).is_err() {
        toast(app, "保存失败：主窗口没有响应", false);
    }
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

    // ---- 右键保存 ----

    fn save_url(query: &str) -> Url {
        Url::parse(&format!("https://sixi-pinterest.invalid/save?{query}")).unwrap()
    }

    #[test]
    fn save_signal_is_only_the_exact_sentinel() {
        assert!(is_save_signal(&save_url("mode=library")));
        for raw in [
            "https://www.pinterest.com/save",
            "http://sixi-pinterest.invalid/save",
            "https://sixi-pinterest.invalid/other",
            "https://evil-sixi-pinterest.invalid/save",
            "https://sixi-pinterest.invalid.evil.example/save",
        ] {
            assert!(!is_save_signal(&Url::parse(raw).unwrap()), "{raw}");
        }
    }

    #[test]
    fn parses_both_modes_and_nothing_else() {
        let src = "https%3A%2F%2Fi.pinimg.com%2F736x%2Fab%2Fx.jpg";
        let library = parse_save(&save_url(&format!("mode=library&src={src}&title=%E6%A4%85%E5%AD%90"))).unwrap();
        assert_eq!(library.mode, SaveMode::Library);
        assert_eq!(library.title, "椅子");
        assert_eq!(parse_save(&save_url(&format!("mode=canvas&src={src}"))).unwrap().mode, SaveMode::Canvas);
        // 页面不能发明第三种动作
        assert!(parse_save(&save_url(&format!("mode=delete&src={src}"))).is_err());
        assert!(parse_save(&save_url(&format!("src={src}"))).is_err());
    }

    #[test]
    fn page_cannot_make_the_desktop_fetch_arbitrary_addresses() {
        // 页面脚本是外部网页：这是 SSRF 的入口，必须在解析阶段就拒绝
        for target in [
            "http%3A%2F%2F127.0.0.1%2Fa.jpg",
            "https%3A%2F%2F192.168.1.1%2Fa.jpg",
            "https%3A%2F%2Fevil.example%2Fa.jpg",
            "https%3A%2F%2Fpinimg.com.evil.example%2Fa.jpg",
            "file%3A%2F%2F%2FC%3A%2FWindows%2Fwin.ini",
            "data%3Aimage%2Fpng%3Bbase64%2CAAAA",
        ] {
            assert!(parse_save(&save_url(&format!("mode=library&src={target}"))).is_err(), "{target}");
        }
        assert!(parse_save(&save_url("mode=library")).is_err(), "缺 src 必须拒绝");
    }

    #[test]
    fn title_and_page_are_truncated_not_trusted() {
        let src = "https%3A%2F%2Fi.pinimg.com%2Fa.jpg";
        let long = "a".repeat(5000);
        let request = parse_save(&save_url(&format!("mode=library&src={src}&title={long}&page={long}"))).unwrap();
        assert_eq!(request.title.chars().count(), MAX_TITLE_CHARS);
        assert_eq!(request.page.chars().count(), MAX_PAGE_CHARS);
    }

    #[test]
    fn save_signal_is_recognised_before_the_allow_list() {
        // 哨兵本身是合法的 https 地址：真被放行就会去解析 .invalid。
        // on_navigation 必须先识别哨兵并返回 false —— 这条守住顺序。
        let source = include_str!("pinterest_window.rs");
        let signal = source.find("if is_save_signal(url)").expect("找不到哨兵判断");
        let allowed = source.find("            is_allowed(url)\n        })").expect("找不到放行判断");
        assert!(signal < allowed);
        assert!(source[signal..allowed].contains("return false;"));
    }

    #[test]
    fn download_never_runs_on_the_navigation_callback_thread() {
        // on_navigation 跑在 UI 线程上，下载是网络 IO：必须起线程，回调立刻返回
        let source = include_str!("pinterest_window.rs");
        let start = source.find("fn handle_save").expect("找不到 handle_save");
        // 按「下一个函数」切，不按固定字节数：源码里有中文，按字节切会切在字符中间
        let end = source[start..].find("fn notify_main").expect("找不到 notify_main") + start;
        let body = &source[start..end];
        let spawn = body.find("std::thread::spawn").expect("handle_save 必须起线程");
        assert!(!body[..spawn].contains("block_on"), "block_on 只能出现在新线程里");
    }

    #[test]
    fn menu_script_is_top_frame_only_and_carries_nothing_privileged() {
        assert!(MENU_SCRIPT.contains("window.top !== window"));
        assert!(MENU_SCRIPT.contains("window.__sixiPin"), "必须幂等");
        assert!(MENU_SCRIPT.contains(SAVE_SENTINEL_HOST));
        for forbidden in ["__WOOHAA", "woohaa-native", "X-Woohaa-Token"] {
            assert!(!MENU_SCRIPT.contains(forbidden), "脚本里不能出现 {forbidden}");
        }
        // 光标下的图要用 elementsFromPoint 找：卡片上盖着透明遮罩，event.target 往往不是 <img>
        assert!(MENU_SCRIPT.contains("elementsFromPoint"));
        // 非图片位置必须保持原生右键菜单：preventDefault 只能出现在命中图片之后
        let handler = MENU_SCRIPT.find("\"contextmenu\"").unwrap();
        let guard = MENU_SCRIPT[handler..].find("if (!img)").unwrap();
        let prevent = MENU_SCRIPT[handler..].find("preventDefault").unwrap();
        assert!(guard < prevent);
    }

    #[test]
    fn query_param_reads_the_blob_id() {
        assert_eq!(query_param("id=abc-123", "id").as_deref(), Some("abc-123"));
        assert_eq!(query_param("x=1&id=z", "id").as_deref(), Some("z"));
        assert_eq!(query_param("", "id"), None);
    }

    #[test]
    fn report_accepts_only_ok_and_message() {
        assert!(serde_json::from_slice::<Report>(r#"{"ok":true,"message":"已保存"}"#.as_bytes()).is_ok());
        assert!(serde_json::from_slice::<Report>(br#"{"ok":true,"message":"x","script":"alert(1)"}"#).is_err());
    }

    #[test]
    fn blob_and_result_routes_are_dispatched_off_the_main_thread_too() {
        let source = include_str!("transport.rs");
        let route = source.find("\"/pinterest-blob\"").expect("transport.rs 里找不到 /pinterest-blob");
        let main_thread = source.find("run_on_main_thread(move ||").unwrap();
        assert!(route < main_thread);
        assert!(source[route..main_thread].contains("std::thread::spawn"));
    }

    #[test]
    fn menu_script_truncates_very_long_titles() {
        // 真机实测：不少 pin 的链接 aria-label 是整段描述加一串话题标签（几百字），
        // 原样存下来是一条没法看的素材名。Rust 侧 200 字是硬上限，这里更早收短。
        assert!(MENU_SCRIPT.contains("MAX_TITLE = 60"));
        assert!(MENU_SCRIPT.contains("function truncate"));
        // 截断必须在「这一级确实有标题」之后，否则会把空字符串截成一个省略号
        let title_of = MENU_SCRIPT.find("function titleOf").unwrap();
        let body = &MENU_SCRIPT[title_of..];
        let check = body.find("if (cleaned)").unwrap();
        let cut = body.find("truncate(cleaned").unwrap();
        assert!(check < cut, "先判断非空、再截断");
    }

    #[test]
    fn menu_script_treats_pinterests_placeholder_titles_as_empty() {
        // 真机实测（中文界面首页）：链接 aria-label 是「<标题> Pin 图页面」，没标题的 pin 是
        // 「未命名 Pin 图页面」、来源是 Instagram 的是「Instagram Pin 图页面」。
        // 不当成空，所有这类图都会被存成「未命名 Pin 图页面」—— 看着像名字，比兜底名还糟。
        assert!(MENU_SCRIPT.contains("function isPlaceholder"));
        for needle in ["未命名", "Untitled", "Instagram", "Pin\\s*图页面", "Pin\\s*page"] {
            assert!(MENU_SCRIPT.contains(needle), "脚本里缺少对 {needle} 的处理");
        }
        // 占位判断必须在 cleanTitle 返回之前：清洗成空串才能触发 titleOf 的下一级回退
        let clean = MENU_SCRIPT.find("function cleanTitle").unwrap();
        let end = MENU_SCRIPT[clean..].find("function isPlaceholder").unwrap() + clean;
        assert!(MENU_SCRIPT[clean..end].contains("isPlaceholder(cleaned)"));
        // 占位词只在「整串完全等于」时才算：名字里恰好含这些词的（Instagram-worthy kitchen）不能被误删
        let placeholder = &MENU_SCRIPT[end..];
        let body = &placeholder[..placeholder.find("}\n").unwrap()];
        assert!(body.matches("^(").count() >= 2 && body.matches(")$").count() >= 2, "必须是整串匹配：{body}");
    }

    #[test]
    fn menu_script_strips_pinterests_accessibility_prefix_from_titles() {
        // 真机实测：几乎每张图的 alt 都以「其中包括图片：」开头，直接当素材名会变成一排同样的前缀，
        // 而 alt 为空的图会只剩前缀本身。清洗必须发生在「判断是否为空」之前，才能触发下一级回退。
        assert!(MENU_SCRIPT.contains("function cleanTitle"));
        assert!(MENU_SCRIPT.contains("其中包括图片"));
        let title_of = MENU_SCRIPT.find("function titleOf").expect("找不到 titleOf");
        let body = &MENU_SCRIPT[title_of..];
        let clean = body.find("cleanTitle(").expect("titleOf 必须调用 cleanTitle");
        let check = body.find("if (cleaned)").expect("必须先清洗、再判断是否为空");
        assert!(clean < check);
        // 全部候选都清洗后为空时有明确的兜底名，不会存一条空标题
        assert!(body.contains("Pinterest 图片"));
    }

    #[test]
    fn page_title_is_only_a_fallback_on_pin_detail_pages() {
        // 真机实测：首页信息流的 document.title 是「Pinterest」之类，拿来当素材名比兜底名还糟。
        // 页面标题只在 /pin/<数字> 才描述「这张图」。
        let title_of = MENU_SCRIPT.find("function titleOf").expect("找不到 titleOf");
        let body = &MENU_SCRIPT[title_of..];
        let title_push = body.find("candidates.push(document.title)").expect("找不到页面标题回退");
        // 路径判断与 push 在同一条 if 里：取 push 所在的那一行，正则在 location.pathname 的左边
        let line_start = body[..title_push].rfind('\n').map_or(0, |i| i + 1);
        let line = &body[line_start..title_push];
        assert!(line.contains("location.pathname"), "页面标题回退必须按路径限制：{line}");
        assert!(line.contains("pin"), "只允许 /pin/<id> 详情页：{line}");
    }
}
