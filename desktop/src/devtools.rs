//! WebView 开发者工具：用系统菜单加速键打开，不依赖前端 JS。
//!
//! 组合是 Option+Control+Command+I，避开浏览器常见的 Option+Command+I。

use tauri::{
    AppHandle, Manager, Runtime,
    menu::{HELP_SUBMENU_ID, MenuEvent, MenuItem},
};

pub const MENU_ID: &str = "open-devtools";
pub const ACCELERATOR: &str = "Option+Control+Command+I";
pub const MENU_TEXT: &str = "打开开发者工具";

pub fn is_devtools_menu_id(id: &str) -> bool {
    id == MENU_ID
}

/// 把「打开开发者工具」挂到现有应用菜单。macOS 默认菜单已有 View/Help；
/// 无菜单的平台（无边框 Windows/Linux 窗口）保持空操作，避免突然出现菜单栏。
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let item = MenuItem::with_id(app, MENU_ID, MENU_TEXT, true, Some(ACCELERATOR))?;
    for kind in menu.items()? {
        if let Some(submenu) = kind.as_submenu() {
            if submenu.text()? == "View" {
                submenu.append(&item)?;
                return Ok(());
            }
        }
    }
    if let Some(help) = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|kind| kind.as_submenu().cloned())
    {
        help.append(&item)?;
    }
    Ok(())
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: &MenuEvent) {
    if is_devtools_menu_id(event.id().as_ref()) {
        open(app);
    }
}

fn open<R: Runtime>(app: &AppHandle<R>) {
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));
    if let Some(window) = window {
        window.open_devtools();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerator_is_option_control_command_i() {
        assert_eq!(
            ACCELERATOR.split('+').collect::<Vec<_>>(),
            ["Option", "Control", "Command", "I"]
        );
    }

    #[test]
    fn menu_id_matches_open_devtools_event() {
        assert!(is_devtools_menu_id(MENU_ID));
        assert!(is_devtools_menu_id("open-devtools"));
        assert!(!is_devtools_menu_id("quit"));
        assert!(!is_devtools_menu_id(""));
    }
}
