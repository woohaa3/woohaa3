//! Native folder selection/opening only; workspace authority remains in the local host.
use serde::Deserialize;
use serde_json::{Value, json};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
enum Request {
    Pick,
    Open { path: String },
}

pub fn control(app: &tauri::AppHandle, body: &[u8]) -> Result<Value, String> {
    if body.len() > 32768 {
        return Err("目录操作请求过大".into());
    }
    match serde_json::from_slice::<Request>(body).map_err(|e| e.to_string())? {
        Request::Pick => {
            let selected = app.dialog().file().blocking_pick_folder();
            let path = selected
                .map(|file| file.into_path().map_err(|e| e.to_string()))
                .transpose()?;
            Ok(json!({"path": path.map(|p| p.to_string_lossy().into_owned())}))
        }
        Request::Open { path } => {
            let directory = std::path::Path::new(&path);
            if !directory.is_absolute() || !directory.is_dir() {
                return Err("目录不存在或不是绝对路径".into());
            }
            let directory = directory.canonicalize().map_err(|e| e.to_string())?;
            #[cfg(target_os = "macos")]
            let mut command = std::process::Command::new("/usr/bin/open");
            #[cfg(target_os = "linux")]
            let mut command = std::process::Command::new("xdg-open");
            #[cfg(target_os = "windows")]
            let mut command = std::process::Command::new("explorer.exe");
            let status = command.arg(directory).status().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("无法打开目录".into());
            }
            Ok(json!({}))
        }
    }
}
