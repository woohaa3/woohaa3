//! Explicitly consented, destination-bound diagnostic archive spool.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::menu::{HELP_SUBMENU_ID, MenuEvent, MenuItem};
use tauri_plugin_dialog::DialogExt;

const MENU_ID: &str = "upload-local-diagnostics";
const MAX_BYTES: u64 = 32 * 1024 * 1024;
static BUSY: AtomicBool = AtomicBool::new(false);
struct Busy;
impl Busy {
    fn acquire() -> Option<Self> {
        (!BUSY.swap(true, Ordering::AcqRel)).then_some(Self)
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}
#[derive(Clone)]
struct Destination {
    server_url: String,
    actor_hash: String,
}
struct Prompt {
    id: String,
    run: PathBuf,
    trigger: &'static str,
}
fn read(path: &Path) -> Value {
    if path.is_symlink() || fs::metadata(path).map(|m| m.len() > 65536).unwrap_or(true) {
        return Value::Null;
    }
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}
fn private_dir(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        return Err("诊断队列目录无效".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn private_write(path: &Path, value: &Value) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(value.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
fn destination(spool: &Path, now: u64) -> Option<Destination> {
    let value = read(&spool.join("destination.json"));
    let updated = value["updatedAt"].as_u64()?;
    if updated > now.saturating_add(5000) || now.saturating_sub(updated) > 30_000 {
        return None;
    }
    let server_url = value["serverUrl"].as_str()?;
    let url = tauri::Url::parse(server_url).ok()?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let actor_hash = value["actorHash"].as_str()?;
    if actor_hash.len() != 64
        || !actor_hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    Some(Destination {
        server_url: server_url.to_owned(),
        actor_hash: actor_hash.to_owned(),
    })
}
fn directories(root: &Path) -> Vec<PathBuf> {
    let mut result: Vec<_> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            e.file_type()
                .ok()
                .filter(|t| t.is_dir() && !t.is_symlink())
                .map(|_| e.path())
        })
        .collect();
    result.sort();
    result
}
fn prompt_id(run: &Path, trigger: &str, incident: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "{}:{trigger}:{incident}",
            run.file_name().unwrap_or_default().to_string_lossy()
        ))
    )
}
fn acknowledged(spool: &Path, id: &str) -> bool {
    spool.join("prompts").join(id).is_file()
}
fn acknowledge(spool: &Path, id: &str) -> Result<(), String> {
    let path = spool.join("prompts");
    private_dir(&path)?;
    let marker = path.join(id);
    if marker.exists() {
        return Ok(());
    }
    private_write(&marker, &json!({"handledAt":crate::diagnostics::now()}))
}
fn next_prompt(current: &Path, spool: &Path) -> Option<Prompt> {
    let root = current.parent()?;
    if let Some(run) = directories(root).into_iter().rev().find(|p| {
        p != current
            && matches!(
                read(&p.join("finished.json"))["status"].as_str(),
                Some("abnormal_exit" | "failed_exit")
            )
    }) {
        let id = prompt_id(&run, "abnormal_exit", "");
        if !acknowledged(spool, &id) {
            return Some(Prompt {
                id,
                run,
                trigger: "abnormal_exit",
            });
        }
    }
    let mut incidents: Vec<_> = fs::read_dir(current.join("incidents"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_file())
                && e.file_name().to_string_lossy().ends_with("-recovered.json")
        })
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    incidents.sort();
    let incident = incidents.last()?;
    let id = prompt_id(current, "hang_recovered", incident);
    (!acknowledged(spool, &id)).then(|| Prompt {
        id,
        run: current.to_owned(),
        trigger: "hang_recovered",
    })
}
fn cleanup(spool: &Path, now: u64) {
    for dir in directories(spool) {
        if dir.file_name().is_some_and(|n| n == "prompts") {
            continue;
        }
        let created = read(&dir.join("job.json"))["createdAt"].as_u64();
        let expired = created.is_some_and(|t| now.saturating_sub(t) > 7 * 86400 * 1000);
        let abandoned = created.is_none()
            && fs::metadata(&dir)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age.as_secs() > 86400);
        if expired || abandoned {
            let _ = fs::remove_dir_all(dir);
        }
    }
    if let Ok(entries) = fs::read_dir(spool.join("prompts")) {
        for entry in entries.flatten() {
            let handled = read(&entry.path())["handledAt"].as_u64().unwrap_or(now);
            if now.saturating_sub(handled) > 7 * 86400 * 1000 {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}
fn ensure_capacity(spool: &Path) -> Result<(), String> {
    let pending = directories(spool)
        .into_iter()
        .filter(|p| {
            p.join("job.json").is_file()
                && !matches!(
                    read(&p.join("state.json"))["status"].as_str(),
                    Some("complete" | "failed")
                )
        })
        .count();
    if pending >= 5 {
        Err("已有 5 份诊断包等待上报，请稍后重试或导出到本机".into())
    } else {
        Ok(())
    }
}
fn queue(
    spool: &Path,
    runs: &[PathBuf],
    run: &Path,
    trigger: &str,
    destination: &Destination,
    version: &str,
) -> Result<String, String> {
    private_dir(spool)?;
    cleanup(spool, crate::diagnostics::now());
    ensure_capacity(spool)?;
    let id = uuid::Uuid::new_v4().to_string();
    let staging = spool.join(format!(".{id}.tmp"));
    private_dir(&staging)?;
    let result = (|| {
        let archive = staging.join("archive.tar.gz");
        crate::diagnostic_export::archive_runs(runs, &archive)?;
        let size = fs::metadata(&archive).map_err(|e| e.to_string())?.len();
        if size == 0 || size > MAX_BYTES {
            return Err("诊断包超过 32 MiB，未加入上报队列；可使用导出功能保存到本机".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&archive, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        let run_id = run
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("运行标识无效")?;
        private_write(
            &staging.join("job.json"),
            &json!({"schema":1,"id":id,"serverUrl":destination.server_url,"actorHash":destination.actor_hash,"archiveKind":"diagnostics","runId":run_id,"trigger":trigger,"createdAt":crate::diagnostics::now(),"frontendVersion":version}),
        )?;
        fs::rename(&staging, spool.join(&id)).map_err(|e| e.to_string())?;
        Ok(id)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}
fn report(app: &tauri::AppHandle, current: &Path, prompt: Option<Prompt>) {
    let Some(root) = current.parent().and_then(Path::parent) else {
        return;
    };
    let spool = root.join("upload-queue");
    let Some(target) = destination(&spool, crate::diagnostics::now()) else {
        if prompt.is_none() {
            app.dialog()
                .message("请先连接并登录服务端，再上报诊断日志。")
                .title("上报诊断日志")
                .blocking_show();
        }
        return;
    };
    let (run, trigger, runs, reason) = if let Some(p) = &prompt {
        (
            p.run.clone(),
            p.trigger,
            vec![p.run.clone()],
            if p.trigger == "abnormal_exit" {
                "检测到上次运行未正常结束，可能是强制关闭或异常退出；不代表已确认发生崩溃。"
            } else {
                "检测到一段时间未收到界面心跳，目前已恢复。"
            },
        )
    } else {
        (
            current.to_owned(),
            "manual",
            crate::diagnostic_export::selected_runs(current),
            "",
        )
    };
    let names = runs
        .iter()
        .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .collect::<Vec<_>>()
        .join("\n");
    let consent = app.dialog().message(format!("{reason}\n将向以下服务端上报诊断包：\n{}\n\n运行记录：\n{names}\n\n包含日志、异常堆栈及取样；原始错误输出可能包含文件路径和业务内容。确认后允许在该账号与服务端下重试，最多保留 7 天。", target.server_url)).title("上报诊断日志").buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel).blocking_show();
    if let Some(p) = &prompt {
        if let Err(error) = acknowledge(&spool, &p.id) {
            app.dialog()
                .message(format!("无法保存提示状态：{error}"))
                .blocking_show();
            return;
        }
    }
    if !consent {
        return;
    }
    // The snapshot stays bound to the exact destination shown in the confirmation.
    match queue(
        &spool,
        &runs,
        &run,
        trigger,
        &target,
        &app.package_info().version.to_string(),
    ) {
        Ok(_) => {
            app.dialog().message("诊断包已加入上报队列。仅在刚才确认的账号和服务端下上传；结果将在原生提示中显示。").title("上报诊断日志").blocking_show();
        }
        Err(error) => {
            app.dialog()
                .message(error)
                .title("上报诊断日志失败")
                .blocking_show();
        }
    }
}
pub fn handle_menu(app: &tauri::AppHandle, event: &MenuEvent) {
    if event.id().as_ref() != MENU_ID {
        return;
    }
    let Some(guard) = Busy::acquire() else {
        return;
    };
    let Some(current) = crate::diagnostics::run_dir().map(Path::to_path_buf) else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        let _guard = guard;
        report(&app, &current, None);
    });
}
fn next_result(spool: &Path, now: u64) -> Option<(PathBuf, &'static str)> {
    // The descriptor is owned by the active remote-server plugin and requires a session.
    let target = destination(spool, now)?;
    for job in directories(spool) {
        if !job.join("job.json").is_file() || job.join("result-notified.json").exists() {
            continue;
        }
        let metadata = read(&job.join("job.json"));
        if metadata["serverUrl"] != target.server_url || metadata["actorHash"] != target.actor_hash
        {
            continue;
        }
        let state = read(&job.join("state.json"));
        let message = match state["status"].as_str() {
            Some("complete") => "诊断日志已上报到服务端，可由后台管理员查看。",
            Some("failed") => {
                "诊断日志未能上报，已停止自动重试。请检查连接后重新上报，或导出到本机。"
            }
            _ => continue,
        };
        return Some((job, message));
    }
    None
}
fn result_prompt(app: &tauri::AppHandle, spool: &Path) {
    if let Some((job, message)) = next_result(spool, crate::diagnostics::now()) {
        if private_write(
            &job.join("result-notified.json"),
            &json!({"time":crate::diagnostics::now()}),
        )
        .is_ok()
        {
            app.dialog()
                .message(message)
                .title("诊断日志上报结果")
                .blocking_show();
        }
    }
}
fn reset_destination(current: &Path) {
    if let Some(logs) = current.parent().and_then(Path::parent) {
        // A recent descriptor can survive a killed process. This launch must wait for
        // its own remote-server activation, not inherit the previous launch's readiness.
        let _ = fs::remove_file(logs.join("upload-queue/destination.json"));
    }
}
pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    let item = MenuItem::with_id(app, MENU_ID, "上报诊断日志…", true, None::<&str>)?;
    if let Some(menu) = app.menu() {
        let help = menu
            .get(HELP_SUBMENU_ID)
            .and_then(|i| i.as_submenu().cloned())
            .or_else(|| {
                menu.items()
                    .ok()?
                    .into_iter()
                    .find_map(|i| i.as_submenu().cloned())
            });
        if let Some(help) = help {
            help.append(&item)?;
        }
    }
    let Some(current) = crate::diagnostics::run_dir().map(Path::to_path_buf) else {
        return Ok(());
    };
    reset_destination(&current);
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(5));
            if current.join("finished.json").exists() {
                break;
            }
            let Some(root) = current.parent().and_then(Path::parent) else {
                break;
            };
            let spool = root.join("upload-queue");
            let Some(_guard) = Busy::acquire() else {
                continue;
            };
            cleanup(&spool, crate::diagnostics::now());
            if destination(&spool, crate::diagnostics::now()).is_none() {
                continue;
            }
            result_prompt(&app, &spool);
            if let Some(prompt) = next_prompt(&current, &spool) {
                report(&app, &current, Some(prompt));
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn target(now: u64) -> Value {
        json!({"serverUrl":"https://example.test/base","actorHash":"a".repeat(64),"updatedAt":now})
    }
    #[test]
    fn new_launch_waits_for_its_own_remote_server_activation() {
        let root = fixture();
        let current = root.join("logs/runs/current");
        let spool = root.join("logs/upload-queue");
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&spool).unwrap();
        fs::write(spool.join("destination.json"), target(100_000).to_string()).unwrap();
        assert!(destination(&spool, 100_000).is_some());
        reset_destination(&current);
        assert!(destination(&spool, 100_000).is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn upload_results_require_an_active_matching_destination() {
        let spool = fixture();
        let job = spool.join("job");
        fs::create_dir(&job).unwrap();
        fs::write(
            job.join("job.json"),
            json!({"serverUrl":"https://example.test/base","actorHash":"a".repeat(64)}).to_string(),
        )
        .unwrap();
        fs::write(
            job.join("state.json"),
            json!({"status":"complete"}).to_string(),
        )
        .unwrap();
        assert!(next_result(&spool, 100_000).is_none());
        fs::write(spool.join("destination.json"), target(100_000).to_string()).unwrap();
        assert!(next_result(&spool, 100_000).is_some());
        let mut other = target(100_000);
        other["actorHash"] = json!("b".repeat(64));
        fs::write(spool.join("destination.json"), other.to_string()).unwrap();
        assert!(next_result(&spool, 100_000).is_none());
        fs::remove_dir_all(spool).unwrap();
    }
    #[test]
    fn destination_must_be_fresh_and_without_credentials() {
        let root = fixture();
        fs::write(root.join("destination.json"), target(100_000).to_string()).unwrap();
        assert!(destination(&root, 120_000).is_some());
        assert!(destination(&root, 131_000).is_none());
        let mut invalid = target(100_000);
        invalid["serverUrl"] = json!("https://secret@example.test");
        fs::write(root.join("destination.json"), invalid.to_string()).unwrap();
        assert!(destination(&root, 100_000).is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn previous_abnormal_selection_skips_live_and_handled_runs() {
        let root = fixture();
        for (id, status) in [
            ("001", "abnormal_exit"),
            ("002", "clean_exit"),
            ("003", "abnormal_exit"),
        ] {
            fs::create_dir_all(root.join(id)).unwrap();
            fs::write(
                root.join(id).join("finished.json"),
                json!({"status":status}).to_string(),
            )
            .unwrap();
        }
        fs::create_dir_all(root.join("004")).unwrap();
        let spool = root.join("upload-queue");
        let prompt = next_prompt(&root.join("004"), &spool).unwrap();
        assert_eq!(prompt.run, root.join("003"));
        assert_eq!(prompt.trigger, "abnormal_exit");
        acknowledge(&spool, &prompt.id).unwrap();
        // Only the latest abnormal run is offered; do not walk historical crashes on each poll.
        assert!(next_prompt(&root.join("004"), &spool).is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recovered_hang_is_offered_once_and_queue_is_bounded() {
        let root = fixture();
        let current = root.join("current");
        fs::create_dir_all(current.join("incidents")).unwrap();
        fs::write(current.join("incidents/123-recovered.json"), "{}").unwrap();
        let spool = root.join("upload-queue");
        let prompt = next_prompt(&current, &spool).unwrap();
        assert_eq!(prompt.trigger, "hang_recovered");
        acknowledge(&spool, &prompt.id).unwrap();
        assert!(next_prompt(&current, &spool).is_none());
        for i in 0..5 {
            let job = spool.join(format!("job-{i}"));
            fs::create_dir_all(&job).unwrap();
            fs::write(job.join("job.json"), "{}").unwrap();
        }
        assert!(ensure_capacity(&spool).is_err());
        fs::write(
            spool.join("job-0/state.json"),
            json!({"status":"complete"}).to_string(),
        )
        .unwrap();
        assert!(ensure_capacity(&spool).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn queued_snapshot_is_private_and_bound_to_the_approved_destination() {
        let root = fixture();
        let run = root.join("logs/runs/run-123");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("desktop.jsonl"), "evidence").unwrap();
        let spool = root.join("logs/upload-queue");
        let target = Destination {
            server_url: "https://example.test".into(),
            actor_hash: "a".repeat(64),
        };
        let id = queue(&spool, &[run.clone()], &run, "manual", &target, "0.1.4").unwrap();
        let job = read(&spool.join(&id).join("job.json"));
        assert_eq!(job["serverUrl"], target.server_url);
        assert_eq!(job["actorHash"], target.actor_hash);
        assert_eq!(job["runId"], "run-123");
        assert_eq!(job["archiveKind"], "diagnostics");
        assert!(spool.join(&id).join("archive.tar.gz").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(spool.join(&id).join("job.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(spool.join(&id)).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retention_removes_old_queue_bytes_without_a_server_connection() {
        let root = fixture();
        let dir = root.join("old-job");
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("job.json"), json!({"createdAt":1}).to_string()).unwrap();
        fs::write(dir.join("archive.tar.gz"), "private bytes").unwrap();
        cleanup(&root, 8 * 86400 * 1000);
        assert!(!dir.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
