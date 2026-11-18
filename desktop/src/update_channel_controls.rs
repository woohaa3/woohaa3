//! 更新通道设置的原生边界（change: 2026-11-18-add-desktop-update-channels）。
//!
//! 只暴露「读当前通道 / 写当前通道」两项，走与 `/window`、`/workspace-folder` 同一条
//! `woohaa-native` 协议：token 与来源校验在 `transport::install` 已统一完成，这里只管
//! 请求体解析与字段校验。
//!
//! 关闭开发者版本时顺带写入一次性回退意图——这是唯一允许安装低版本的路径，必须由用户的
//! 显式动作产生，不能由前端随手置位。

use crate::update_channel::{self, ChannelState, STABLE_CHANNEL};
use serde::Deserialize;
use serde_json::{Value, json};

/// 请求体上限：只有两个字段，给足余量但仍然有界。
const MAX_BODY_BYTES: usize = 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    /// 目标通道；必须在本安装包的可用集合内。
    channel: String,
}

fn parse(body: &[u8]) -> Result<String, String> {
    if body.len() > MAX_BODY_BYTES {
        return Err("Update channel request exceeds budget".into());
    }
    let request: Request = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    Ok(request.channel)
}

/// 读当前状态；文件缺失或损坏时返回 stable（与实际生效的通道一致）。
pub fn read() -> Result<Value, String> {
    let file = state_file()?;
    let state = update_channel::read_state(&file);
    Ok(json!({ "channel": state.channel, "pendingRollback": state.pending_rollback }))
}

/// 写通道选择。
///
/// `available` 是本安装包可查询的通道集合：不在其中的通道一律拒绝，避免前端把设置改成
/// 一个永远查不到的通道后静默失败。
pub fn write(available: &[String], body: &[u8]) -> Result<Value, String> {
    let channel = parse(body)?;
    if !available.iter().any(|name| name == &channel) {
        return Err(format!("本安装包不提供 {channel} 通道"));
    }
    let file = state_file()?;
    let previous = update_channel::read_state(&file);
    // 从非 stable 关回 stable 时置一次性回退意图：下次启动允许装回更低的正式版。
    let pending_rollback = channel == STABLE_CHANNEL && previous.channel != STABLE_CHANNEL;
    let state = ChannelState { channel, pending_rollback };
    update_channel::write_state(&file, &state)?;
    Ok(json!({ "channel": state.channel, "pendingRollback": state.pending_rollback }))
}

fn state_file() -> Result<std::path::PathBuf, String> {
    let base = crate::diagnostics::data_directory().ok_or_else(|| "无法定位桌面数据目录".to_owned())?;
    Ok(update_channel::channel_file(&base))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_fields_are_accepted() {
        assert_eq!(parse(br#"{"channel":"alpha"}"#).unwrap(), "alpha");
        assert!(parse(br#"{"channel":"alpha","pendingRollback":true}"#).is_err());
        assert!(parse(&[b' '; MAX_BODY_BYTES + 1]).is_err());
    }
}
