//! framed 请求/响应服务与单请求处理
//! （change: refactor-bevy-rust-file-size，任务 3.4 / design D2）。

use super::render::render_preview;

/// 便捷入口：从 JSON 解析请求并渲染。
///
/// 返回 `(requestId, ok, code, message, png)`；PNG 仅成功时非空。
pub fn render_request_json(json: &str) -> (String, bool, Option<String>, Option<String>, Vec<u8>) {
    let (request_id, ok, code, message, bytes, _rgba) = render_request_frame(json);
    (request_id, ok, code, message, bytes)
}

/// 与 `render_request_json` 相同，但额外返回输出是否为裸 RGBA 帧。
pub fn render_request_frame(
    json: &str,
) -> (String, bool, Option<String>, Option<String>, Vec<u8>, bool) {
    let request = match crate::renderer_protocol::parse_request(json) {
        Ok(request) => request,
        Err((code, message)) => {
            return (
                String::new(),
                false,
                Some(code.as_str().to_owned()),
                Some(message),
                Vec::new(),
                false,
            );
        }
    };
    let request_id = request.request_id.clone();
    let rgba = request.capture.format == "rgba";
    if let Err((code, message)) = crate::renderer_protocol::validate_request(&request) {
        return (
            request_id,
            false,
            Some(code.as_str().to_owned()),
            Some(message),
            Vec::new(),
            rgba,
        );
    }
    match render_preview(&request) {
        Ok(bytes) => (request_id, true, None, None, bytes, rgba),
        Err((code, message)) => (
            request_id,
            false,
            Some(code.as_str().to_owned()),
            Some(message),
            Vec::new(),
            rgba,
        ),
    }
}

/// 常驻 framed stdio 服务循环（`model-renderer` binary 的唯一入口）。
///
/// 请求：`u32 BE 长度 + JSON`；响应：`u32 BE 长度 + JSON`，成功时再追加
/// `u32 BE PNG 长度 + PNG bytes`。单条消息越界或无法解析时返回稳定错误并继续服务。
pub fn run_stdio() -> std::io::Result<()> {
    use std::io::{Read, Write};

    eprintln!(
        "model-renderer 就绪（{}）",
        crate::renderer_protocol::RENDERER_PROTOCOL_VERSION
    );
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();

    loop {
        let mut header = [0u8; 4];
        if input.read_exact(&mut header).is_err() {
            break;
        }
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > crate::renderer_protocol::MAX_MESSAGE_BYTES {
            write_error_frame(&mut output, "", "malformed-request", "消息长度越界")?;
            output.flush()?;
            continue;
        }
        let mut payload = vec![0u8; length];
        if input.read_exact(&mut payload).is_err() {
            break;
        }
        let json = String::from_utf8_lossy(&payload);
        let (request_id, ok, code, message, bytes, rgba) = render_request_frame(&json);
        if ok {
            write_success_frame(&mut output, &request_id, &bytes, rgba)?;
        } else {
            write_error_frame(
                &mut output,
                &request_id,
                code.as_deref().unwrap_or("render-failed"),
                message.as_deref().unwrap_or("渲染失败"),
            )?;
        }
        output.flush()?;
    }
    Ok(())
}

fn write_success_frame(
    output: &mut impl std::io::Write,
    request_id: &str,
    bytes: &[u8],
    rgba: bool,
) -> std::io::Result<()> {
    let field = if rgba { "rgbaLen" } else { "pngLen" };
    let json = format!(
        r#"{{"requestId":{},"ok":true,"{field}":{}}}"#,
        json_string(request_id),
        bytes.len()
    );
    write_frame(output, json.as_bytes())?;
    write_frame(output, bytes)
}

fn write_error_frame(
    output: &mut impl std::io::Write,
    request_id: &str,
    code: &str,
    message: &str,
) -> std::io::Result<()> {
    let json = format!(
        r#"{{"requestId":{},"ok":false,"code":{},"message":{}}}"#,
        json_string(request_id),
        json_string(code),
        json_string(message)
    );
    write_frame(output, json.as_bytes())
}

fn write_frame(output: &mut impl std::io::Write, bytes: &[u8]) -> std::io::Result<()> {
    std::io::Write::write_all(output, &(bytes.len() as u32).to_be_bytes())?;
    std::io::Write::write_all(output, bytes)
}

/// 最小 JSON 字符串转义（只处理协议里会出现的字符）。
fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
