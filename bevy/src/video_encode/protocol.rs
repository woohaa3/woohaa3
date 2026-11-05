//! `world-video-encoder` 子进程的 framed 协议（change: 2026-11-05-camera-shot-as-video）。
//!
//! stdin：`u32 BE 长度 + JSON`。首个消息声明尺寸/帧率；随后每帧先发
//! `{"frameLength": N}`，紧接着发 N 字节 RGBA；最后发 `{"finish": true}`。
//! stdout：每个消息都是 `u32 BE 长度 + JSON`；结束时最后再追加一帧 MP4 字节。
//!
//! 这里只实现协议与编码会话，便于无 GPU 的纯 CPU 单测。

use std::io::{Read, Write};

use super::h264::H264Encoder;
use super::mp4::build_mp4;
use super::{MAX_VIDEO_EDGE, MAX_VIDEO_FPS, MAX_VIDEO_SECONDS};

pub const MAX_JSON_BYTES: usize = 16 * 1024;
pub const MAX_FRAME_BYTES: usize = 128 * 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct BeginJson {
    width: u32,
    height: u32,
    fps: u32,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FrameJson {
    frame_length: u64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FinishJson {
    finish: bool,
}

pub struct VideoEncoderSession {
    encoder: H264Encoder,
    fps: u32,
}

impl VideoEncoderSession {
    pub fn start(json: &str) -> Result<Self, String> {
        let begin: BeginJson = serde_json::from_str(json).map_err(|error| error.to_string())?;
        if begin.width == 0 || begin.height == 0 || begin.width > MAX_VIDEO_EDGE || begin.height > MAX_VIDEO_EDGE {
            return Err("video dimensions out of range".to_owned());
        }
        if begin.fps == 0 || begin.fps > MAX_VIDEO_FPS {
            return Err("video fps out of range".to_owned());
        }
        let encoder = H264Encoder::new(begin.width, begin.height, begin.fps)?;
        Ok(Self { encoder, fps: begin.fps })
    }

    pub fn push_frame(&mut self, rgba: &[u8]) -> Result<usize, String> {
        if self.encoder.frame_count() as u32 >= MAX_VIDEO_SECONDS * MAX_VIDEO_FPS {
            return Err("video exceeds maximum frame count".to_owned());
        }
        self.encoder.push_rgba(rgba)?;
        Ok(self.encoder.frame_count())
    }

    /// 结束录制；`Err` 表示没有可发布的视频，调用方必须失败关闭。
    pub fn finish(self) -> Result<FinishedVideo, String> {
        let video = self.encoder.finish()?;
        if (video.frames as u32) > self.fps * MAX_VIDEO_SECONDS {
            return Err("video exceeds maximum duration".to_owned());
        }
        let duration_seconds = video.frames as f64 / self.fps as f64;
        let width = video.width;
        let height = video.height;
        let bytes = build_mp4(&video)?;
        Ok(FinishedVideo { bytes, width, height, fps: self.fps, frames: video.frames, duration_seconds })
    }
}

pub struct FinishedVideo {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: usize,
    pub duration_seconds: f64,
}

pub fn json_string(value: &str) -> String {
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

pub fn write_frame(output: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
    output.write_all(bytes)
}

fn read_json_frame(input: &mut impl Read, limit: usize) -> std::io::Result<Option<String>> {
    let mut header = [0u8; 4];
    if input.read_exact(&mut header).is_err() {
        return Ok(None);
    }
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > limit {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid frame length"));
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    Ok(Some(String::from_utf8_lossy(&payload).to_string()))
}

fn write_ok(output: &mut impl Write, extra: &str) -> std::io::Result<()> {
    let json = if extra.is_empty() {
        r#"{"ok":true}"#.to_owned()
    } else {
        format!(r#"{{"ok":true,{extra}}}"#)
    };
    write_frame(output, json.as_bytes())
}

fn write_error(output: &mut impl Write, code: &str, message: &str) -> std::io::Result<()> {
    let json = format!(
        r#"{{"ok":false,"code":{},"message":{}}}"#,
        json_string(code),
        json_string(message)
    );
    write_frame(output, json.as_bytes())
}

/// 常驻一轮录制；成功时写入 MP4 字节并返回。
pub fn run_session(input: &mut impl Read, output: &mut impl Write) -> std::io::Result<bool> {
    let Some(begin) = read_json_frame(input, MAX_JSON_BYTES)? else { return Ok(false) };
    let mut session = match VideoEncoderSession::start(&begin) {
        Ok(session) => session,
        Err(message) => {
            write_error(output, "invalid-request", &message)?;
            output.flush()?;
            return Ok(false);
        }
    };
    write_ok(output, "")?;
    output.flush()?;

    loop {
        let Some(message) = read_json_frame(input, MAX_JSON_BYTES)? else { return Ok(false) };
        if let Ok(frame) = serde_json::from_str::<FrameJson>(&message) {
            let length = frame.frame_length as usize;
            if length == 0 || length > MAX_FRAME_BYTES {
                write_error(output, "invalid-frame", "frame length out of range")?;
                output.flush()?;
                return Ok(false);
            }
            let mut rgba = vec![0u8; length];
            input.read_exact(&mut rgba)?;
            match session.push_frame(&rgba) {
                Ok(count) => {
                    write_ok(output, &format!(r#""frameCount":{count}"#))?;
                    output.flush()?;
                }
                Err(message) => {
                    write_error(output, "encode-failed", &message)?;
                    output.flush()?;
                    return Ok(false);
                }
            }
            continue;
        }
        if let Ok(finish) = serde_json::from_str::<FinishJson>(&message) {
            if !finish.finish {
                write_error(output, "invalid-request", "finish flag required")?;
                output.flush()?;
                return Ok(false);
            }
            return match session.finish() {
                Ok(video) => {
                    let json = format!(
                        r#"{{"ok":true,"mp4Len":{},"width":{},"height":{},"fps":{},"frames":{},"durationSeconds":{}}}"#,
                        video.bytes.len(),
                        video.width,
                        video.height,
                        video.fps,
                        video.frames,
                        video.duration_seconds
                    );
                    write_frame(output, json.as_bytes())?;
                    write_frame(output, &video.bytes)?;
                    output.flush()?;
                    Ok(true)
                }
                Err(message) => {
                    write_error(output, "encode-failed", &message)?;
                    output.flush()?;
                    Ok(false)
                }
            };
        }
        write_error(output, "invalid-request", "unknown message")?;
        output.flush()?;
        return Ok(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_json(length: usize) -> Vec<u8> {
        let json = format!(r#"{{"frameLength":{length}}}"#);
        let mut out = (json.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(json.as_bytes());
        out
    }

    fn message(json: &str) -> Vec<u8> {
        let mut out = (json.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(json.as_bytes());
        out
    }

    fn read_all_frames(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut offset = 0;
        while offset + 4 <= bytes.len() {
            let length = u32::from_be_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]]) as usize;
            offset += 4;
            if offset + length > bytes.len() {
                break;
            }
            let payload = bytes[offset..offset + length].to_vec();
            offset += length;
            out.push((String::from_utf8_lossy(&payload).to_string(), payload));
        }
        out
    }

    /// 编码真实帧（不需要 GPU）：小尺寸渐变帧，验证 MP4 结构与帧数/时长。
    #[test]
    fn encodes_real_frames_into_a_playable_mp4() {
        let mut input = Vec::new();
        let width = 64u32;
        let height = 48u32;
        let frames = 12usize;
        input.extend(message(r#"{"width":64,"height":48,"fps":12}"#));
        for index in 0..frames {
            let frame_len = (width * height * 4) as usize;
            input.extend(frame_json(frame_len));
            let mut rgba = vec![0u8; frame_len];
            for (pixel, chunk) in rgba.chunks_exact_mut(4).enumerate() {
                let x = (pixel as u32) % width;
                let y = (pixel as u32) / width;
                chunk[0] = ((x + index as u32) % 256) as u8;
                chunk[1] = ((y * 2) % 256) as u8;
                chunk[2] = (index * 8 % 256) as u8;
                chunk[3] = 255;
            }
            input.extend_from_slice(&rgba);
        }
        input.extend(message(r#"{"finish":true}"#));

        let mut output = Vec::new();
        let ok = run_session(&mut input.as_slice(), &mut output).expect("session");
        assert!(ok, "session should finish: {}", String::from_utf8_lossy(&output));
        let messages = read_all_frames(&output);
        let last_json = &messages[messages.len() - 2].0;
        assert!(last_json.contains("\"mp4Len\""), "{last_json}");
        assert!(last_json.contains("\"frames\":12"), "{last_json}");
        assert!(last_json.contains("\"durationSeconds\":1"), "{last_json}");
        let mp4 = &messages[messages.len() - 1].1;
        assert_eq!(&mp4[4..8], b"ftyp");
        assert!(mp4.windows(4).any(|window| window == b"moov"));
        assert!(mp4.windows(4).any(|window| window == b"avcC"));
    }

    #[test]
    fn rejects_out_of_range_fps() {
        let input = message(r#"{"width":64,"height":48,"fps":240}"#);
        let mut output = Vec::new();
        let ok = run_session(&mut input.as_slice(), &mut output).expect("session");
        assert!(!ok);
        assert!(String::from_utf8_lossy(&output).contains("fps"));
    }
}
