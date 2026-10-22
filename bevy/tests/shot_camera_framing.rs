//! 跨语言 shot camera 取景 fixture 对齐
//! （change: add-reusable-bevy-shot-camera，任务 1.2 / design D2）。
//!
//! Rust `shot_camera::framing` 与 Web `shot-camera.ts` 读取同一
//! `web/contracts/fixtures/shot-camera-framing.json` 并各自断言；任一侧数学漂移都会使对方
//! 测试失败。这里断言 Rust 纯函数与 fixture 数值在明确容差内一致。

use std::path::Path;

use serde::Deserialize;
use woohaa_bevy_canvas::shot_camera::{
    Aabb, azimuth_from_horizontal_drag, distance_from_drag, elevation_from_vertical_drag,
    resolve_shot_camera, shot_bounding_radius, shot_fit_distance,
};

#[derive(Deserialize)]
struct Fixture {
    tolerance: f32,
    cases: Vec<Case>,
    #[serde(rename = "dragCases")]
    drag_cases: Vec<DragCase>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    aabb: AabbDto,
    azimuth: f32,
    #[serde(default = "default_elevation")]
    elevation: f32,
    distance: f32,
    #[allow(dead_code)]
    aspect: String,
    #[serde(rename = "aspectRatio")]
    aspect_ratio: f32,
    #[serde(rename = "focusOffset")]
    focus_offset: [f32; 3],
    expected: Expected,
}

fn default_elevation() -> f32 {
    std::f32::consts::FRAC_PI_4
}

#[derive(Deserialize)]
struct AabbDto {
    min: [f32; 3],
    max: [f32; 3],
}

#[derive(Deserialize)]
struct Expected {
    #[serde(rename = "boundingRadius")]
    bounding_radius: f32,
    #[serde(rename = "fitDistance")]
    fit_distance: f32,
    distance: f32,
    focus: [f32; 3],
    position: [f32; 3],
    fov: f32,
}

#[derive(Deserialize)]
struct DragCase {
    name: String,
    #[serde(rename = "startAzimuth")]
    start_azimuth: Option<f32>,
    #[serde(rename = "deltaX")]
    delta_x: Option<f32>,
    #[serde(rename = "surfaceWidth")]
    surface_width: Option<f32>,
    #[serde(rename = "expectedAzimuth")]
    expected_azimuth: Option<f32>,
    #[serde(rename = "startDistance")]
    start_distance: Option<f32>,
    #[serde(rename = "deltaPixels")]
    delta_pixels: Option<f32>,
    #[serde(rename = "surfaceHeight")]
    surface_height: Option<f32>,
    #[serde(rename = "fitDistance")]
    fit_distance: Option<f32>,
    #[serde(rename = "expectedDistance")]
    expected_distance: Option<f32>,
    #[serde(rename = "startElevation")]
    start_elevation: Option<f32>,
    #[serde(rename = "expectedElevation")]
    expected_elevation: Option<f32>,
}

fn fixture() -> Fixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("contracts")
        .join("fixtures")
        .join("shot-camera-framing.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("无法读取 {}: {error}", path.display()));
    serde_json::from_str(&raw).expect("解析 shot camera fixture")
}

#[test]
fn rust_framing_matches_shared_fixture() {
    let fixture = fixture();
    let tolerance = fixture.tolerance.max(1e-5);
    for case in &fixture.cases {
        let aabb = Aabb::new(case.aabb.min.into(), case.aabb.max.into());
        let expected = &case.expected;
        let radius = shot_bounding_radius(&aabb);
        assert!(
            (radius - expected.bounding_radius).abs() <= tolerance,
            "{}: bounding radius {} != {}",
            case.name,
            radius,
            expected.bounding_radius
        );
        let fit = shot_fit_distance(expected.bounding_radius, case.aspect_ratio);
        assert!(
            (fit - expected.fit_distance).abs() <= tolerance,
            "{}: fit {} != {}",
            case.name,
            fit,
            expected.fit_distance
        );
        let pose = resolve_shot_camera(
            &aabb,
            case.azimuth,
            case.elevation,
            case.distance,
            case.aspect_ratio,
            case.focus_offset.into(),
        )
        .unwrap_or_else(|| panic!("{}: resolve 失败", case.name));
        assert!(
            (pose.distance - expected.distance).abs() <= tolerance,
            "{}: distance {} != {}",
            case.name,
            pose.distance,
            expected.distance
        );
        for index in 0..3 {
            assert!(
                (pose.focus.to_array()[index] - expected.focus[index]).abs() <= tolerance,
                "{}: focus[{index}] {} != {}",
                case.name,
                pose.focus.to_array()[index],
                expected.focus[index]
            );
            assert!(
                (pose.position.to_array()[index] - expected.position[index]).abs() <= tolerance,
                "{}: position[{index}] {} != {}",
                case.name,
                pose.position.to_array()[index],
                expected.position[index]
            );
        }
        assert!(
            (pose.fov - expected.fov).abs() <= tolerance,
            "{}: fov {} != {}",
            case.name,
            pose.fov,
            expected.fov
        );
        assert!(
            (pose.elevation - case.elevation).abs() <= tolerance,
            "{}: elevation {} != {}",
            case.name,
            pose.elevation,
            case.elevation
        );
    }
}

#[test]
fn rust_drag_math_matches_shared_fixture() {
    let fixture = fixture();
    let tolerance = fixture.tolerance.max(1e-5);
    for case in &fixture.drag_cases {
        if let (Some(start), Some(delta_x), Some(width), Some(expected)) = (
            case.start_azimuth,
            case.delta_x,
            case.surface_width,
            case.expected_azimuth,
        ) {
            let actual = azimuth_from_horizontal_drag(start, delta_x, width);
            assert!(
                (actual - expected).abs() <= tolerance,
                "{}: azimuth {} != {}",
                case.name,
                actual,
                expected
            );
        }
        if let (
            Some(start),
            Some(delta),
            Some(height),
            Some(fit),
            Some(expected),
        ) = (
            case.start_distance,
            case.delta_pixels,
            case.surface_height,
            case.fit_distance,
            case.expected_distance,
        ) {
            let actual = distance_from_drag(start, delta, height, fit);
            assert!(
                (actual - expected).abs() <= tolerance,
                "{}: distance {} != {}",
                case.name,
                actual,
                expected
            );
        }
        if let (Some(start), Some(delta), Some(height), Some(expected)) = (
            case.start_elevation,
            case.delta_pixels,
            case.surface_height,
            case.expected_elevation,
        ) {
            let actual = elevation_from_vertical_drag(start, delta, height);
            assert!(
                (actual - expected).abs() <= tolerance,
                "{}: elevation {} != {}",
                case.name,
                actual,
                expected
            );
        }
    }
}
