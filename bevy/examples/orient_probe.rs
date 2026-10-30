// 独立复算：canvas view_rotation vs preview 相机，比较「模型 local +Z」的屏幕投影。
use bevy::prelude::*;

fn canvas_view() -> Quat {
    Quat::from_euler(EulerRot::XYZ, 30f32.to_radians(), -45f32.to_radians(), 0.0)
}

fn preview_cam(y_deg: f32) -> Quat {
    Quat::from_euler(EulerRot::YXZ, y_deg.to_radians(), -30f32.to_radians(), 0.0)
}

fn screen(q: Quat, v: Vec3) -> (f32, f32) {
    let w = q * v; // view-space direction
    (w.x, -w.y) // screen x right, screen y down
}

fn main() {
    let stage = Quat::from_euler(EulerRot::YXZ, 45f32.to_radians(), 0.0, 0.0);
    let front = Vec3::Z;

    println!(
        "canvas  local+Z          scr=({:+.3},{:+.3})",
        screen(canvas_view(), front).0,
        screen(canvas_view(), front).1
    );
    println!(
        "preview local+Z (y=-45)  scr=({:+.3},{:+.3})",
        screen(preview_cam(-45.0).inverse(), front).0,
        screen(preview_cam(-45.0).inverse(), front).1
    );
    println!(
        "preview local+Z (y=+45)  scr=({:+.3},{:+.3})",
        screen(preview_cam(45.0).inverse(), front).0,
        screen(preview_cam(45.0).inverse(), front).1
    );
    println!();
    println!(
        "canvas  stage*local+Z    scr=({:+.3},{:+.3})",
        screen(canvas_view(), stage * front).0,
        screen(canvas_view(), stage * front).1
    );
    println!(
        "preview stage*local+Z y-45 scr=({:+.3},{:+.3})",
        screen(preview_cam(-45.0).inverse(), stage * front).0,
        screen(preview_cam(-45.0).inverse(), stage * front).1
    );
    println!(
        "preview stage*local+Z y+45 scr=({:+.3},{:+.3})",
        screen(preview_cam(45.0).inverse(), stage * front).0,
        screen(preview_cam(45.0).inverse(), stage * front).1
    );
    println!();
    // 深度：canvas 相机在 +Z 看向 -Z，view z>0 表示朝向观察者；
    // preview 相机 view 空间同理。比较深度符号。
    println!("canvas depth(front) = {:+.3}", (canvas_view() * front).z);
    println!(
        "preview depth(front) = {:+.3}",
        (preview_cam(-45.0).inverse() * front).z
    );
}
