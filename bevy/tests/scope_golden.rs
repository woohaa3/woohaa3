//! 跨语言范围 golden：Rust `canvas_query::scope` 与 web/contracts `composite-asset-scope`
//! 共享同一 fixture（change: 2026-10-12-align-film-set-scope-with-isometric-grid，任务 2.3）。
//!
//! 断言投影轴、中心/半径/AABB/顶点/8 抓手、边内外与 AABB 空白角。TS 侧有对应用例。

use std::fs;
use std::path::Path;

use serde::Deserialize;
use woohaa_bevy_canvas::golden_api::{scope_contains, scope_geometry_json, scope_intersects_rect};

#[derive(Deserialize)]
struct Golden {
    #[serde(rename = "edgeSlope")]
    edge_slope: f32,
    #[serde(rename = "axisX")]
    axis_x: f32,
    #[serde(rename = "axisY")]
    axis_y: f32,
    #[serde(rename = "minHalf")]
    min_half: f32,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Case {
    name: String,
    base: BaseRect,
    shape: String,
    ground: [f32; 4],
    center: [f32; 2],
    radius: [f32; 2],
    aabb: [f32; 4],
    vertices: [[f32; 2]; 4],
    handles: [[f32; 2]; 8],
    contains: Vec<PointProbe>,
    intersect: Vec<RectProbe>,
}

#[derive(Deserialize)]
struct BaseRect {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[derive(Deserialize)]
struct PointProbe {
    point: [f32; 2],
    expect: bool,
}

#[derive(Deserialize)]
struct RectProbe {
    rect: [f32; 4],
    expect: bool,
}

fn fixture() -> Golden {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("contracts")
        .join("fixtures")
        .join("canvas-scope-golden.json");
    let source = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read fixture: {error}"));
    serde_json::from_str(&source).expect("parse fixture")
}

impl BaseRect {
    fn as_array(&self) -> [f32; 4] {
        [self.x, self.y, self.width, self.height]
    }
}

fn approx(a: f32, b: f32) -> bool {
    (a - b).abs() < 1e-3
}

#[test]
fn scope_geometry_matches_contract_golden() {
    let golden = fixture();
    let expected_slope = woohaa_bevy_canvas::isometric_grid::CANVAS_CAMERA_PITCH.sin();
    assert!(
        approx(golden.edge_slope, expected_slope),
        "edge slope must follow camera pitch"
    );
    assert!((golden.axis_y / golden.axis_x - golden.edge_slope).abs() < 1e-4);
    for case in &golden.cases {
        let raw = scope_geometry_json(
            case.base.as_array(),
            &case.shape,
            case.ground,
            golden.min_half,
        )
        .unwrap_or_else(|error| panic!("{}: {error}", case.name));
        let value: serde_json::Value = serde_json::from_str(&raw).expect("geometry json");
        let center = value["center"].as_array().unwrap();
        assert!(
            approx(center[0].as_f64().unwrap() as f32, case.center[0]),
            "{} center.x",
            case.name
        );
        assert!(
            approx(center[1].as_f64().unwrap() as f32, case.center[1]),
            "{} center.y",
            case.name
        );
        let radius = value["radius"].as_array().unwrap();
        assert!(
            approx(radius[0].as_f64().unwrap() as f32, case.radius[0]),
            "{} radius.x",
            case.name
        );
        assert!(
            approx(radius[1].as_f64().unwrap() as f32, case.radius[1]),
            "{} radius.y",
            case.name
        );
        let aabb = value["aabb"].as_array().unwrap();
        for axis in 0..4 {
            assert!(
                approx(aabb[axis].as_f64().unwrap() as f32, case.aabb[axis]),
                "{} aabb[{axis}]",
                case.name
            );
        }
        let vertices = value["vertices"].as_array().unwrap();
        for index in 0..4 {
            let vertex = vertices[index].as_array().unwrap();
            assert!(
                approx(vertex[0].as_f64().unwrap() as f32, case.vertices[index][0]),
                "{} v{index}.x",
                case.name
            );
            assert!(
                approx(vertex[1].as_f64().unwrap() as f32, case.vertices[index][1]),
                "{} v{index}.y",
                case.name
            );
        }
        let handles = value["handles"].as_array().unwrap();
        for index in 0..8 {
            let handle = handles[index].as_array().unwrap();
            assert!(
                approx(handle[0].as_f64().unwrap() as f32, case.handles[index][0]),
                "{} h{index}.x",
                case.name
            );
            assert!(
                approx(handle[1].as_f64().unwrap() as f32, case.handles[index][1]),
                "{} h{index}.y",
                case.name
            );
        }
    }
}

#[test]
fn scope_contains_matches_contract_golden() {
    let golden = fixture();
    for case in &golden.cases {
        for probe in &case.contains {
            let actual = scope_contains(
                case.base.as_array(),
                &case.shape,
                case.ground,
                golden.min_half,
                probe.point[0],
                probe.point[1],
            )
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
            assert_eq!(
                actual, probe.expect,
                "{} contains {:?}",
                case.name, probe.point
            );
        }
    }
}

#[test]
fn scope_intersect_matches_contract_golden() {
    let golden = fixture();
    for case in &golden.cases {
        for probe in &case.intersect {
            let actual = scope_intersects_rect(
                case.base.as_array(),
                &case.shape,
                case.ground,
                golden.min_half,
                probe.rect,
            )
            .unwrap_or_else(|error| panic!("{}: {error}", case.name));
            assert_eq!(
                actual, probe.expect,
                "{} intersect {:?}",
                case.name, probe.rect
            );
        }
    }
}
