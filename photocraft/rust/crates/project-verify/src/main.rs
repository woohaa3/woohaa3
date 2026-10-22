//! 原生无 UI 工程核验工具。
//!
//! 用法（Media 内部适配以参数数组 + 管道调用，绝不执行用户提供的路径或命令）：
//!
//! ```text
//! photocraft-project-verify < project.pcraft        # 从 stdin 读字节
//! photocraft-project-verify project.pcraft          # 从文件读字节
//! ```
//!
//! 成功：stdout 输出一行 JSON 摘要，退出码 0。
//! 失败：stdout 输出一行 JSON `{"ok":false,"code":"...","message":"..."}`，退出码 2。
//!
//! 工具只读输入，不写文件、不访问网络，也不链接任何 UI（`ui-egui`/`egui`/`eframe`）。

#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::unimplemented,
    clippy::todo,
    clippy::unreachable
)]

use std::io::Read as _;
use std::process::ExitCode;

use photocraft_project_verify::verify;

fn main() -> ExitCode {
    let (embedded, bytes) = match read_input() {
        Ok(bytes) => bytes,
        Err(message) => {
            print_failure("io-error", &message);
            return ExitCode::from(2);
        }
    };
    let result = if embedded {
        photocraft_project_verify::smart_source::verify_project(&bytes)
    } else {
        verify(&bytes)
    };
    match result {
        Ok(summary) => {
            let payload = serde_json::json!({ "ok": true, "summary": summary });
            println!("{payload}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            let payload =
                serde_json::json!({ "ok": false, "code": error.code, "message": error.message });
            println!("{payload}");
            ExitCode::from(2)
        }
    }
}

/// 读入工程字节：位置参数为文件路径时读该文件，否则读 stdin。
fn read_input() -> Result<(bool, Vec<u8>), String> {
    let mut args = std::env::args_os().skip(1);
    let mut first = args.next();
    let embedded = first.as_deref() == Some(std::ffi::OsStr::new("--embedded-smart"));
    if embedded {
        first = args.next();
    }
    if args.next().is_some() {
        return Err("输入参数过多".into());
    }
    let reader: Box<dyn std::io::Read> = if let Some(path) = first.filter(|p| p != "-") {
        Box::new(std::fs::File::open(path).map_err(|e| format!("无法读取输入文件：{e}"))?)
    } else {
        Box::new(std::io::stdin())
    };
    let mut buffer = Vec::new();
    reader
        .take(photocraft_project_verify::MAX_PROJECT_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .map_err(|e| format!("无法读取工程：{e}"))?;
    Ok((embedded, buffer))
}

fn print_failure(code: &str, message: &str) {
    let payload = serde_json::json!({ "ok": false, "code": code, "message": message });
    println!("{payload}");
}
