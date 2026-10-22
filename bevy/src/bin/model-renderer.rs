//! 常驻原生模型预览 renderer（change: enhance-model-scene-authoring-api，任务 6.2 / 6.3）。
//!
//! 只编译进 `native-renderer` feature。从 stdin 读取 framed 请求、向 stdout 写 framed 响应：
//!
//! ```text
//! 请求：u32 BE 长度 + JSON（protocolVersion/requestId/sceneVersion/ops/capture...）
//! 响应：u32 BE 长度 + JSON；成功时 JSON 之后紧跟 u32 BE PNG 长度 + PNG bytes
//! ```
//!
//! MUST NOT 执行 JavaScript：只接受规范化 Scene IR，脚本源码在 `parse_request` 即被拒绝。
//! 单条消息超限或无法解析时返回稳定错误并继续服务；进程保持在请求之间常驻。
//! 诊断写 stderr，避免污染 framed stdout。

fn main() {
    if let Err(error) = woohaa_bevy_canvas::model3d::preview::run_stdio() {
        eprintln!("model-renderer 退出：{error}");
        std::process::exit(1);
    }
}
