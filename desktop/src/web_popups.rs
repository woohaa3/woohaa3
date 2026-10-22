//! WebView 新窗口：沿用 opener 的 WebKit 配置与会话，独立窗口不注入 native token。
use tauri::{
    AppHandle, Url, WebviewUrl, WebviewWindowBuilder,
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
    let result = WebviewWindowBuilder::new(
        app,
        format!("web-popup-{}", uuid::Uuid::new_v4()),
        WebviewUrl::External(Url::parse("about:blank").expect("blank URL")),
    )
    .title("授权")
    .inner_size(520.0, 640.0)
    .window_features(features)
    .on_navigation(allowed_url)
    .on_document_title_changed(|window, title| {
        let _ = window.set_title(&title);
    })
    .build();
    match result {
        Ok(window) => NewWindowResponse::Create { window },
        Err(_) => {
            // 不记录包含 OAuth state / code 等参数的 URL。
            eprintln!("Unable to create authorization WebView window");
            NewWindowResponse::Deny
        }
    }
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
}
