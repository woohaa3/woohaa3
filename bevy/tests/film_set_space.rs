//! 片场场景空间 ↔ 画布呈现空间 fixture 对齐
//! （change: 2026-10-23-isolate-film-set-camera-space，任务 1.2 / 5.1 / design D2）。
//!
//! Web `film-set-space.ts` 与 Rust `model3d::shot_adapter::display_camera_state` 读取同一
//! `web/contracts/fixtures/film-set-space.json` 并各自断言；任一侧漂移都会使对方测试失败。
//! 这里只验证纯数学（相机距离/焦点偏移/方位角的相似变换），不代替真实 GPU 像素验收。

use std::path::Path;

use bevy::prelude::Vec3;
use serde::Deserialize;
use woohaa_bevy_canvas::film_set_space::{DisplayUnit, SceneCamera, display_camera};

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    display: Display,
    #[serde(rename = "boundsCenter")]
    bounds_center: [f32; 3],
    camera: Camera,
    expected: Expected,
}

#[derive(Deserialize)]
struct Display {
    scale: f32,
    yaw: f32,
}

#[derive(Deserialize)]
struct Camera {
    azimuth: f32,
    elevation: f32,
    distance: f32,
    #[serde(rename = "focusOffset")]
    focus_offset: [f32; 3],
}

#[derive(Deserialize)]
struct Expected {
    distance: f32,
    #[serde(rename = "focusOffset")]
    focus_offset: [f32; 3],
    focus: [f32; 3],
}

fn fixture() -> Fixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("contracts")
        .join("fixtures")
        .join("film-set-space.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("无法读取 {}: {error}", path.display()));
    serde_json::from_str(&raw).expect("解析 film-set-space fixture")
}

#[test]
fn rust_display_mapping_matches_shared_fixture() {
    const TOLERANCE: f32 = 1e-4;
    for case in fixture().cases {
        let display_unit = DisplayUnit::validated(case.display.scale, case.display.yaw)
            .unwrap_or_else(|| panic!("{}: 显示变换非法", case.name));
        let display = display_camera(
            Some(display_unit),
            &SceneCamera {
                azimuth: case.camera.azimuth,
                elevation: case.camera.elevation,
                distance: case.camera.distance,
                focus_offset: Vec3::from_array(case.camera.focus_offset),
            },
        )
        .unwrap_or_else(|| panic!("{}: display 映射失败", case.name));
        assert!(
            (display.distance - case.expected.distance).abs() <= TOLERANCE,
            "{}: distance {} != {}",
            case.name,
            display.distance,
            case.expected.distance
        );
        for axis in 0..3 {
            assert!(
                (display.focus_offset.to_array()[axis] - case.expected.focus_offset[axis]).abs()
                    <= TOLERANCE,
                "{}: focusOffset[{axis}] {} != {}",
                case.name,
                display.focus_offset.to_array()[axis],
                case.expected.focus_offset[axis]
            );
            let focus = Vec3::from_array(case.bounds_center) + display.focus_offset;
            assert!(
                (focus.to_array()[axis] - case.expected.focus[axis]).abs() <= TOLERANCE,
                "{}: focus[{axis}] {} != {}",
                case.name,
                focus.to_array()[axis],
                case.expected.focus[axis]
            );
        }
        // 竖直角与容器绕 Y 轴旋转无关；方位角加上容器 yaw。
        assert!((display.elevation - case.camera.elevation).abs() <= TOLERANCE);
        assert!(
            (display.azimuth - (case.camera.azimuth + case.display.yaw)).abs() <= TOLERANCE,
            "{}: 方位角必须随容器旋转",
            case.name
        );
    }
}

fn camera(distance: f32, focus_offset: [f32; 3]) -> SceneCamera {
    SceneCamera {
        azimuth: 0.0,
        elevation: 0.4,
        distance,
        focus_offset: Vec3::from_array(focus_offset),
    }
}

#[test]
fn illegal_display_never_yields_a_camera() {
    for scale in [0.0_f32, -1.0, f32::NAN, f32::INFINITY] {
        assert!(
            DisplayUnit::validated(scale, 0.0).is_none(),
            "scale={scale} 必须显式失败"
        );
    }
    assert!(DisplayUnit::validated(1.0, f32::NAN).is_none());
    let unit = DisplayUnit::validated(1.0, 0.0).unwrap();
    assert!(display_camera(Some(unit), &camera(0.0, [0.0, 0.0, 0.0])).is_none());
    assert!(display_camera(Some(unit), &camera(5.0, [f32::NAN, 0.0, 0.0])).is_none());
}

#[test]
fn display_mapping_is_reversible_for_hand_gestures() {
    let unit = DisplayUnit::validated(3.5, 0.9).unwrap();
    let scene = Vec3::new(0.235, 1.365, -0.025);
    let back = unit.unvector(unit.vector(scene));
    assert!((back - scene).length() < 1e-5, "逆映射必须回到场景值");
}
