//! 动态镜头视频编码子进程（change: 2026-11-05-camera-shot-as-video）。
//!
//! 由本机宿主按需启动：stdin 接收尺寸/帧率与逐帧 RGBA，stdout 返回 MP4。
//! 纯 CPU（OpenH264），不依赖 GPU，也不访问画布或规范状态。

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    match woohaa_bevy_canvas::video_encode::run_session(&mut input, &mut output) {
        Ok(_) => {}
        Err(error) => {
            eprintln!("world-video-encoder 退出：{error}");
            std::process::exit(1);
        }
    }
}
