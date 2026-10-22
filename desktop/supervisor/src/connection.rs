//! Independent socket/child control loop. Never driven by the window or WebView.
use super::*;
use serde_json::{Value, json};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream as LocalStream;
#[cfg(windows)]
use crate::named_pipe::NamedPipeStream as LocalStream;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc};

const VERSION: &str = "RECORDING_PROTOCOL_VERSION_1_ALPHA_1";
const MAX_FRAME: usize = 8 * 1024 * 1024;

/// Dropping this guard stops the connection thread and all its workers.
pub struct ConnectionGuard {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

pub fn start(config: SupervisorConfig) -> Result<ConnectionGuard, SupervisorError> {
    config.validate()?;
    if !config.worker_path.is_file() {
        return Err(SupervisorError::config(format!("录制 worker 不存在：{}", config.worker_path.display())));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let thread = std::thread::spawn(move || {
        // Probe once using the actual worker/GPU, then reuse the capability on reconnect.
        let output = probe_capability(&config.worker_path, &stopping);
        let mut capability: Value = match output {
            Ok(output) if output.status.success() => match serde_json::from_slice(&output.stdout) {
                Ok(value) => value,
                Err(error) => { eprintln!("recording capability: {error}"); return; }
            },
            _ => { eprintln!("录制能力探测失败"); return; }
        };
        capability["executorInstanceId"] = json!(config.executor_instance_id);
        capability["checkoutId"] = json!(config.checkout_id);
        RecordingSupervisor::new().sweep_work_root(&config.work_root, Duration::from_secs(24 * 60 * 60));
        while !stopping.load(Ordering::Relaxed) {
            if let Err(error) = serve(&config, &capability, &stopping) {
                eprintln!("录制执行器连接：{error}");
            }
            for _ in 0..10 {
                if stopping.load(Ordering::Relaxed) { break; }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    });
    Ok(ConnectionGuard { stop, thread: Some(thread) })
}

fn probe_capability(worker: &Path, stop: &AtomicBool) -> std::io::Result<std::process::Output> {
    let mut child = hidden_command(worker).arg("--capability")
        .stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if child.try_wait()?.is_some() { return child.wait_with_output(); }
        if stop.load(Ordering::Relaxed) || Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::other("capability probe stopped or timed out"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn write_frame(out: &mut impl Write, message: &Value) -> std::io::Result<()> {
    let data = serde_json::to_vec(message)?;
    if data.len() > MAX_FRAME { return Err(std::io::Error::other("control frame too large")); }
    out.write_all(&(data.len() as u32).to_be_bytes())?;
    out.write_all(&data)?;
    out.flush()
}
fn read_frame(input: &mut impl Read) -> std::io::Result<Value> {
    let mut header = [0; 4];
    input.read_exact(&mut header)?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME { return Err(std::io::Error::other("invalid frame length")); }
    let mut data = vec![0; size];
    input.read_exact(&mut data)?;
    Ok(serde_json::from_slice(&data)?)
}
fn failure(sequence: u64, job: &Value, code: &str, message: &str) -> Value {
    json!({"protocolVersion": VERSION, "sequence": sequence.to_string(), "stateChanged": {
        "sequence": sequence.to_string(), "job": job, "state": "RECORDING_JOB_STATE_FAILED",
        "error": {"stage": "RECORDING_ERROR_STAGE_EXECUTOR_LOST", "code": code, "message": message}
    }})
}

fn serve(config: &SupervisorConfig, capability: &Value, stop: &AtomicBool) -> std::io::Result<()> {
    let nonce = std::fs::read_to_string(&config.nonce_path)?;
    // Windows：宿主把本次实例的实际管道名写在同目录 pipe.name；每次重连都重新读取，
    // 避免两进程 TEMP 的 8.3 短路径/长路径字符串差异导致连错管道。
    #[cfg(windows)]
    let endpoint = std::fs::read_to_string(config.nonce_path.with_file_name("pipe.name"))
        .map(|name| PathBuf::from(name.trim()))
        .unwrap_or_else(|_| config.socket_path.clone());
    #[cfg(not(windows))]
    let endpoint = config.socket_path.clone();
    let mut socket = LocalStream::connect(&endpoint).map_err(|error| {
        std::io::Error::new(
            error.kind(),
            format!("连接 {}：{error}", endpoint.display()),
        )
    })?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    write_frame(&mut socket, &json!({"protocolVersion": VERSION, "sequence": "1", "capabilityRequest": {
        "sequence": "1", "requestId": "register", "registrationNonce": nonce.trim(), "capability": capability
    }}))?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    let response = read_frame(&mut socket)?;
    if response.pointer("/capabilityResponse/accepted") != Some(&Value::Bool(true)) {
        return Err(std::io::Error::other(format!("registration rejected: {response}")));
    }
    eprintln!("原生录制执行器已注册 ({})", config.executor_instance_id);
    let (sender, receiver) = mpsc::channel();
    let mut reader = socket.try_clone()?;
    reader.set_read_timeout(None)?;
    let host_sender = sender.clone();
    std::thread::spawn(move || {
        loop {
            let message = read_frame(&mut reader);
            let done = message.is_err();
            if host_sender.send((None, message)).is_err() || done { break; }
        }
    });
    let mut supervisor = RecordingSupervisor::new();
    let result = (|| {
        let mut sequence = 1u64;
        let mut last_heartbeat = Instant::now();
        let mut last_host = Instant::now();
        let mut active: Option<Value> = None;
        while !stop.load(Ordering::Relaxed) {
            if last_host.elapsed() > Duration::from_millis(config.lease_ms) {
                return Err(std::io::Error::other("host lease expired"));
            }
            if last_heartbeat.elapsed() > Duration::from_secs(5) {
                sequence += 1;
                write_frame(&mut socket, &json!({"protocolVersion": VERSION, "sequence": sequence.to_string(),
                    "leaseHeartbeat": {"sequence": sequence.to_string(), "executorInstanceId": config.executor_instance_id}
                }))?;
                last_heartbeat = Instant::now();
            }
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok((None, message)) => {
                    let message = message?;
                    last_host = Instant::now();
                    if message.get("leaseRenewal").is_some() {
                        for worker in supervisor.active.values() {
                            std::fs::write(worker.directory.join("lease.json"), b"{}")?;
                        }
                    } else if let Some(submit) = message.get("submitJob") {
                        if active.is_some() {
                            write_frame(&mut socket, &failure(sequence, &submit["job"], "recording-executor-busy", "worker is busy"))?;
                            continue;
                        }
                        let attempt = submit["job"]["attemptId"].as_str().unwrap_or("");
                        match supervisor.start(config, attempt, nonce.trim()) {
                            Ok(()) => {
                                let worker = supervisor.active.get_mut(attempt).unwrap();
                                let mut stdout = worker.child.stdout.take().unwrap();
                                let worker_sender = sender.clone();
                                let worker_attempt = attempt.to_owned();
                                std::thread::spawn(move || {
                                    loop {
                                        let message = read_frame(&mut stdout);
                                        let done = message.is_err();
                                        if worker_sender.send((Some(worker_attempt.clone()), message)).is_err() || done { break; }
                                    }
                                });
                                write_frame(worker.child.stdin.as_mut().unwrap(), &message)?;
                                active = Some(submit["job"].clone());
                            }
                            Err(error) => write_frame(&mut socket, &failure(sequence, &submit["job"], error.code, &error.message))?,
                        }
                    } else if let Some(cancel) = message.get("cancelJob") {
                        if active.as_ref() == Some(&cancel["job"]) {
                            supervisor.stop_all(config.terminate_grace).map_err(|e| std::io::Error::other(e.message))?;
                            active = None;
                            sequence += 1;
                            write_frame(&mut socket, &json!({"protocolVersion": VERSION, "sequence": sequence.to_string(),
                                "stateChanged": {"job": cancel["job"], "state": "RECORDING_JOB_STATE_CANCELLED"}}))?;
                        }
                    }
                }
                Ok((Some(worker_attempt), message)) => {
                    let Some(job) = active.as_ref() else { continue };
                    if job["attemptId"].as_str() != Some(worker_attempt.as_str()) { continue; }
                    sequence += 1;
                    match message {
                        Ok(mut message) => {
                            // Each worker belongs to exactly one attempt; reject malformed identities.
                            if let Some(changed) = message.get_mut("stateChanged") {
                                if changed.get("job") != Some(job) { return Err(std::io::Error::other("worker identity mismatch")); }
                                let terminal = matches!(changed["state"].as_str(), Some("RECORDING_JOB_STATE_SUCCEEDED" | "RECORDING_JOB_STATE_FAILED" | "RECORDING_JOB_STATE_CANCELLED"));
                                if terminal {
                                    // Keep artifact files until host verification/upload completes.
                                    for (_, mut worker) in std::mem::take(&mut supervisor.active) { let _ = worker.terminate(config.terminate_grace); }
                                    active = None;
                                }
                            }
                            message["sequence"] = json!(sequence.to_string());
                            write_frame(&mut socket, &message)?;
                        }
                        Err(error) => {
                            write_frame(&mut socket, &failure(sequence, job, "recording-worker-terminated", &error.to_string()))?;
                            supervisor.stop_all(config.terminate_grace).map_err(|e| std::io::Error::other(e.message))?;
                            active = None;
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {},
                Err(_) => break,
            }
        }
        Ok(())
    })();
    let _ = socket.shutdown(std::net::Shutdown::Both);
    let _ = supervisor.stop_all(config.terminate_grace);
    result
}

/// Development checkout defaults are compiled in; packaged launches supply explicit trusted paths.
pub fn development_config(checkout: &Path, worker: PathBuf) -> SupervisorConfig {
    use sha2::{Digest, Sha256};
    let checkout_id = format!("{:x}", Sha256::digest(checkout.to_string_lossy().as_bytes()))[..16].to_owned();
    let root = std::env::var_os("WOOHAA3_RECORDING_RUNTIME_ROOT").map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("woohaa3-recording"));
    let directory = root.join(&checkout_id);
    // Windows 没有文件系统 AF_UNIX socket。宿主实际管道名由同目录 `pipe.name` 提供；
    // 这里只计算未读到该文件时的回退名（不依赖 TEMP 的短/长路径格式）。
    #[cfg(windows)]
    let socket_path = PathBuf::from(format!(r"\\.\pipe\woohaa3-recording-{checkout_id}"));
    #[cfg(not(windows))]
    let socket_path = directory.join("executor.sock");
    SupervisorConfig {
        socket_path, nonce_path: directory.join("registration.nonce"),
        worker_path: worker, work_root: directory.join("attempts"),
        executor_instance_id: format!("desktop-{}-{}", std::process::id(), checkout_id), checkout_id,
        lease_ms: 30_000, terminate_grace: Duration::from_secs(1),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::{fs::PermissionsExt, net::UnixListener};

    #[test]
    fn socket_registration_worker_forwarding_and_disconnect_cleanup() {
        let root = std::env::temp_dir().join(format!("wo-connection-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let worker = root.join("worker.py");
        // Protocol/lifecycle fixture only. Does not claim to render or encode video.
        std::fs::write(&worker, r#"#!/usr/bin/python3
import sys,json,struct,os,time
if '--capability' in sys.argv:
 print(json.dumps({'protocolVersion':'RECORDING_PROTOCOL_VERSION_1_ALPHA_1'}));sys.exit()
data=sys.stdin.buffer
n=struct.unpack('>I',data.read(4))[0]
v=json.loads(data.read(n));job=v['submitJob']['job']
open(os.path.join(os.environ['WOOHAA3_RECORDING_WORK_DIR'],'pid'),'w').write(str(os.getpid()))
if job['attemptId']=='blocked':
 time.sleep(30)
else:
 v={'protocolVersion':'RECORDING_PROTOCOL_VERSION_1_ALPHA_1','sequence':'1','stateChanged':{'job':job,'state':'RECORDING_JOB_STATE_SUCCEEDED'}}
 b=json.dumps(v).encode();sys.stdout.buffer.write(struct.pack('>I',len(b))+b);sys.stdout.buffer.flush();time.sleep(30)
"#).unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut config = development_config(&root, worker);
        config.socket_path = root.join("executor.sock");
        config.nonce_path = root.join("nonce");
        config.work_root = root.join("attempts");
        std::fs::write(&config.nonce_path, "test-nonce").unwrap();
        let listener = UnixListener::bind(&config.socket_path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let guard = start(config.clone()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut socket = loop {
            if let Ok((socket, _)) = listener.accept() { break socket; }
            assert!(Instant::now() < deadline, "supervisor did not connect");
            std::thread::sleep(Duration::from_millis(10));
        };
        socket.set_nonblocking(false).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let registration = read_frame(&mut socket).unwrap();
        assert_eq!(registration["capabilityRequest"]["registrationNonce"], "test-nonce");
        assert_eq!(registration["capabilityRequest"]["capability"]["checkoutId"], config.checkout_id);
        write_frame(&mut socket, &json!({"capabilityResponse":{"accepted":true}})).unwrap();
        let job = json!({"jobId":"job", "attemptId":"completed"});
        write_frame(&mut socket, &json!({"submitJob":{"job":job}})).unwrap();
        let terminal = read_frame(&mut socket).unwrap();
        assert_eq!(terminal["stateChanged"]["job"], job);
        assert_eq!(terminal["stateChanged"]["state"], "RECORDING_JOB_STATE_SUCCEEDED");
        assert!(config.attempt_directory("completed").exists(), "host still owns completed files");
        write_frame(&mut socket, &json!({"submitJob":{"job":{"jobId":"job2","attemptId":"blocked"}}})).unwrap();
        let pid_file = config.attempt_directory("blocked").join("pid");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() {
            assert!(Instant::now() < deadline, "second worker did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        // Host disappearance must terminate the worker independently of any window loop.
        socket.shutdown(std::net::Shutdown::Both).unwrap();
        drop(guard);
        assert!(!config.attempt_directory("blocked").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
