//! Native archive export remains available when the page is broken.
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::menu::{HELP_SUBMENU_ID, MenuEvent, MenuItem};
use tauri_plugin_dialog::DialogExt;
const MENU_ID: &str = "export-local-diagnostics";
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let item = MenuItem::with_id(app, MENU_ID, "导出诊断日志…", true, None::<&str>)?;
    let Some(menu) = app.menu() else {
        let menu = tauri::menu::Menu::new(app)?;
        let help = tauri::menu::Submenu::with_items(app, "帮助", true, &[&item])?;
        menu.append(&help)?;
        app.set_menu(menu)?;
        return Ok(());
    };
    if let Some(help) = menu
        .get(HELP_SUBMENU_ID)
        .and_then(|i| i.as_submenu().cloned())
    {
        help.append(&item)?;
    } else if let Some(submenu) = menu
        .items()?
        .into_iter()
        .find_map(|i| i.as_submenu().cloned())
    {
        submenu.append(&item)?;
    }
    Ok(())
}
pub(crate) fn selected_runs(current: &Path) -> Vec<PathBuf> {
    let mut result = vec![current.to_owned()];
    if let Some(root) = current.parent() {
        let mut previous: Vec<_> = fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p != current && p.is_dir() && !p.is_symlink())
            .collect();
        previous.sort();
        if let Some(path) = previous.into_iter().rev().find(|p| {
            fs::read(p.join("finished.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .map(|v| v["status"] != "clean_exit")
                .unwrap_or(false)
        }) {
            result.push(path);
        }
    }
    result
}
struct Snapshot(PathBuf);
impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn copy_logs(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_logs(&entry.path(), &destination.join(entry.file_name()))?;
        } else if kind.is_file() {
            // Rotation may remove an old segment while exporting; other errors are actionable.
            match fs::copy(entry.path(), destination.join(entry.file_name())) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}
fn export(current: &Path, destination: &Path) -> Result<(), String> {
    crate::diagnostics::flush();
    let root = current.parent().ok_or("Missing log root")?;
    if destination.starts_with(root) {
        return Err("请保存到日志目录之外".into());
    }
    archive_runs(&selected_runs(current), destination)
}

/// Snapshot only the explicitly selected run directories; never the upload spool.
pub(crate) fn archive_runs(runs: &[PathBuf], destination: &Path) -> Result<(), String> {
    crate::diagnostics::flush();
    let snapshot =
        Snapshot(std::env::temp_dir().join(format!("woohaa-diagnostics-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&snapshot.0).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&snapshot.0, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    for run in runs {
        copy_logs(run, &snapshot.0.join(run.file_name().ok_or("Invalid run")?))
            .map_err(|e| e.to_string())?;
    }
    let archive = snapshot.0.join("diagnostics.tar.gz");
    let mut command = std::process::Command::new(crate::local_host::diagnostic_tar());
    command.arg("-czf").arg(&archive).arg("-C").arg(&snapshot.0);
    for run in runs {
        command.arg(run.file_name().ok_or("Invalid run")?);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => {
                fs::copy(&archive, destination).map_err(|e| e.to_string())?;
                return Ok(());
            }
            Some(status) => return Err(format!("诊断包导出失败：{status}")),
            None if started.elapsed() > std::time::Duration::from_secs(60) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("诊断包导出超时".into());
            }
            _ => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
}
pub fn handle_menu(app: &tauri::AppHandle, event: &MenuEvent) {
    if event.id().as_ref() != MENU_ID {
        return;
    }
    let Some(current) = crate::diagnostics::run_dir().map(Path::to_path_buf) else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let names = selected_runs(&current)
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .collect::<Vec<_>>()
            .join("\n");
        let confirmed=app.dialog().message(format!("将导出以下运行目录中的日志、异常堆栈和取样：\n{names}\n\n原始错误输出可能包含文件路径和业务内容。诊断包仅保存到本机，请检查后再分享。"))
            .title("导出诊断日志").buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel).blocking_show();
        if !confirmed {
            return;
        }
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name("woohaa-diagnostics.tar.gz")
            .blocking_save_file()
            .and_then(|p| p.into_path().ok())
        else {
            return;
        };
        if let Err(error) = export(&current, &path) {
            app.dialog().message(error).blocking_show();
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_contains_logs_without_workspace_secrets() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let current = root.join("runs/current");
        fs::create_dir_all(&current).unwrap();
        fs::write(current.join("webview.jsonl"), "diagnostic fixture").unwrap();
        fs::write(root.join("secrets.yml"), "must not export").unwrap();
        let archive = root.join("export.tar.gz");
        export(&current, &archive).unwrap();
        let output = std::process::Command::new(crate::local_host::diagnostic_tar())
            .arg("-tzf")
            .arg(&archive)
            .output()
            .unwrap();
        assert!(output.status.success());
        let listing = String::from_utf8_lossy(&output.stdout);
        assert!(listing.contains("webview.jsonl"));
        assert!(!listing.contains("secrets.yml"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn selects_current_and_latest_abnormal_only() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for (id, status) in [
            ("1", "abnormal_exit"),
            ("2", "failed_exit"),
            ("3", "clean_exit"),
            ("4", "running"),
        ] {
            fs::create_dir_all(root.join(id)).unwrap();
            fs::write(
                root.join(id).join("finished.json"),
                serde_json::json!({"status":status}).to_string(),
            )
            .unwrap();
        }
        assert_eq!(
            selected_runs(&root.join("4")),
            vec![root.join("4"), root.join("2")]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
