//! WebView 新窗口：沿用 opener 的 WebKit 配置与会话，独立窗口不注入 native token。
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
    webview::{NewWindowFeatures, NewWindowResponse},
};

fn allowed_url(url: &Url) -> bool {
    (matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none())
        || url.as_str() == "about:blank"
}

pub fn create(
    app: &AppHandle,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<tauri::Wry> {
    if !allowed_url(&url) {
        return NewWindowResponse::Deny;
    }
    // WebKit 的目标配置继承 Cookie/process pool，也可能继承主窗口的 user scripts。
    // 保留前者；替换脚本控制器，防止将 native bootstrap/token 带入外部登录页面。
    #[cfg(target_os = "macos")]
    {
        let Some(main_thread) = objc2::MainThreadMarker::new() else {
            return NewWindowResponse::Deny;
        };
        // SAFETY: new-window 回调在已确认的 AppKit 主线程执行；配置由 WebKit 提供，
        // 新 controller 由配置持有，且尚未创建目标 WebView。
        unsafe {
            features
                .opener()
                .target_configuration
                .setUserContentController(&objc2_web_kit::WKUserContentController::new(
                    main_thread,
                ));
        }
    }
    // window_features 传递 related WebView / WKWebViewConfiguration，保留 opener、Cookie
    // 与命名窗口语义。初始 URL 必须是 about:blank，由 WebKit 完成原请求的导航。
    let label = format!("web-popup-{}", uuid::Uuid::new_v4());
    let nav_app = app.clone();
    let nav_label = label.clone();
    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(Url::parse("about:blank").expect("blank URL")),
    )
    .title("授权")
    .inner_size(520.0, 640.0)
    .window_features(features)
    .on_navigation(move |url| {
        // 页面调用了 `window.close()`（见 CLOSE_SCRIPT）：关掉这个弹窗，并取消这次「导航」。
        if is_close_signal(url) {
            close_popup(&nav_app, &nav_label);
            return false;
        }
        allowed_url(url)
    })
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    });
    #[cfg(windows)]
    let builder = builder.initialization_script(CLOSE_SCRIPT);
    let result = builder.build();
    match result {
        Ok(window) => {
            strip_menu(&window);
            NewWindowResponse::Create { window }
        }
        Err(_) => {
            // 不记录包含 OAuth state / code 等参数的 URL。
            crate::diagnostics::stderr(format_args!("Unable to create authorization WebView window"));
            NewWindowResponse::Deny
        }
    }
}

/// 去掉窗口上继承来的应用菜单栏（「帮助 / 工作区」）。
///
/// Windows / Linux 上 Tauri 创建窗口时，没单独指定菜单就**继承应用菜单**，于是每个窗口顶上都多一条
/// 菜单栏。主窗口里它是宿主的数据搬家入口（导出 / 导入工作区、从备份恢复），但放在登录弹窗和
/// Pinterest 这种浏览网页的窗口里：一是白占一行，二是「导入工作区」会**替换整个数据目录**，
/// 不该让人在一个看网页的窗口里误碰到。
///
/// macOS 不支持按窗口移除（菜单是屏幕顶部的应用级菜单，本来就不在窗口里），所以这里什么都不做。
/// 失败不影响窗口使用：菜单栏多出来只是难看，不能因此让窗口打不开。
pub fn strip_menu(window: &tauri::WebviewWindow) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.remove_menu();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window;
    }
}

/// 「页面想关掉自己」的哨兵地址。`.invalid` 是保留顶级域，永远解析不了，
/// 所以即便导航没被拦住也不会真的发出任何网络请求。
const CLOSE_SENTINEL_HOST: &str = "sixi-popup-close.invalid";

fn is_close_signal(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some(CLOSE_SENTINEL_HOST)
}

/// 页面脚本调用 `window.close()` 时关不掉弹窗的补丁（Windows）。
///
/// **现象**：Google 登录完成后，弹窗内容消失但一块空白窗口留着不走。
/// **原因**：wry 在 Windows 上处理 `window.close()` 的方式是 `DestroyWindow(容器 HWND)` ——
/// 只销毁 webview 自己的容器子窗口，外面那层 Tauri 顶层窗口不管；而 Tauri 只响应原生窗口的
/// 「关闭请求」，不响应页面脚本发起的关闭。两层都不关，就剩一个空壳。
///
/// **做法**：把弹窗里的 `window.close` 改写成导航到哨兵地址，由 `on_navigation` 识别后
/// 关掉对应的 Tauri 窗口。只改顶层框架（iframe 里的 `close()` 不该关掉整个弹窗）。
/// 脚本里没有任何 token 或业务信息 —— 这里不能把宿主的东西带进外部登录页。
///
/// 只在 Windows 上注入：这是 wry 的 WebView2 实现特有的行为，别的平台没有这个现象，
/// 也没法在这里验证。
#[cfg(windows)]
const CLOSE_SCRIPT: &str = r#"(function () {
  if (window.top !== window) return;
  window.close = function () {
    try { window.location.replace("https://sixi-popup-close.invalid/"); } catch (e) {}
  };
})();"#;

/// 在独立线程里关窗口：`on_navigation` 回调跑在 UI 线程上，那里同步等窗口关闭容易自己等自己。
fn close_popup(app: &AppHandle, label: &str) {
    let app = app.clone();
    let label = label.to_owned();
    std::thread::spawn(move || {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.close();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_navigation_accepts_web_auth_and_blank_but_not_privileged_schemes() {
        for raw in [
            "about:blank",
            "https://auth.openai.com/api/accounts/authorize?state=test",
            "http://127.0.0.1:5177/dev/app/api/oauth-agent/authorize/complete?code=test",
        ] {
            assert!(allowed_url(&Url::parse(raw).unwrap()));
        }
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,test",
            "tauri://localhost/",
            "woohaa-native://localhost/rpc",
            "about:config",
            "https://user:password@example.com/",
        ] {
            assert!(!allowed_url(&Url::parse(raw).unwrap()));
        }
    }

    #[test]
    fn close_signal_is_only_the_sentinel_host() {
        assert!(is_close_signal(&Url::parse("https://sixi-popup-close.invalid/").unwrap()));
        // 别的域、别的协议、长得像的域都不算：否则任何页面都能借它关窗口之外的东西
        for raw in [
            "https://accounts.google.com/",
            "http://sixi-popup-close.invalid/",
            "https://sixi-popup-close.invalid.evil.example/",
            "https://evil-sixi-popup-close.invalid/",
        ] {
            assert!(!is_close_signal(&Url::parse(raw).unwrap()), "{raw}");
        }
    }

    #[test]
    fn close_signal_is_not_a_navigation_the_popup_may_follow() {
        // 哨兵本身是合法的 https 地址：真被放行就会去解析 .invalid。
        // 所以 on_navigation 必须在 allowed_url 之前先识别它并返回 false —— 这条守住顺序。
        let source = include_str!("web_popups.rs");
        let signal = source.find("is_close_signal(url)").expect("找不到哨兵判断");
        let allowed = source.find("allowed_url(url)
    })").expect("找不到放行判断");
        assert!(signal < allowed);
    }

    #[cfg(windows)]
    #[test]
    fn close_script_only_patches_the_top_frame_and_carries_nothing_privileged() {
        assert!(CLOSE_SCRIPT.contains("window.top !== window"));
        assert!(CLOSE_SCRIPT.contains(CLOSE_SENTINEL_HOST));
        for forbidden in ["__WOOHAA", "token", "woohaa-native"] {
            assert!(!CLOSE_SCRIPT.contains(forbidden), "脚本里不能出现 {forbidden}");
        }
    }

    #[test]
    fn popups_and_pinterest_window_do_not_keep_the_app_menu() {
        // 两处窗口都必须去掉继承来的应用菜单栏：弹窗在这个文件里，Pinterest 窗口在自己的模块里
        let popups = include_str!("web_popups.rs");
        assert!(popups.contains("strip_menu(&window);"), "登录弹窗创建后必须去掉菜单栏");
        let pinterest = include_str!("pinterest_window.rs");
        assert!(pinterest.contains("strip_menu(&window)"), "Pinterest 窗口创建后必须去掉菜单栏");
    }
}
