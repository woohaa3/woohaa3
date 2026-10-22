//! 跨语言 golden：Rust `canvas_query` 与 web/contracts 共享同一 fixture
//! （change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm，任务 7.2）。
//!
//! 只断言已固定的行为：signature/AABB/extent、FNV-1a UTF-16 与 2D 点命中。fixture 由
//! `web/contracts/fixtures/canvas-hot-paths-golden.json` 提供，TS 侧有对应用例。

use std::fs;
use std::path::Path;

use serde::Deserialize;
use woohaa_bevy_canvas::golden_api::{
    canonical_signature, derive_aabb_from_ops_json, derive_extent_from_ops_json, fnv1a64_utf16,
    point_hit_kind,
};

#[derive(Deserialize)]
struct Golden {
    #[serde(rename = "modelV2")]
    model_v2: ModelV2,
    fnv: Fnv,
    #[serde(rename = "pointHit")]
    point_hit: PointHit,
}

#[derive(Deserialize)]
struct ModelV2 {
    #[serde(rename = "sceneVersion")]
    scene_version: String,
    #[serde(rename = "opsJson")]
    ops_json: String,
    signature: String,
    aabb: Aabb,
    extent: f32,
}

#[derive(Deserialize)]
struct Aabb {
    min: [f32; 3],
    max: [f32; 3],
}

#[derive(Deserialize)]
struct Fnv {
    empty: String,
    abc: String,
    unicode: UnicodeFnv,
}

#[derive(Deserialize)]
struct UnicodeFnv {
    text: String,
    hash: String,
}

#[derive(Deserialize)]
struct PointHit {
    zoom: f32,
    nodes: serde_json::Value,
    cases: Vec<PointCase>,
}

#[derive(Deserialize)]
struct PointCase {
    world: [f32; 2],
    expect: Option<Expected>,
}

#[derive(Deserialize)]
struct Expected {
    kind: String,
    #[serde(rename = "nodeId")]
    node_id: String,
    #[serde(default)]
    side: Option<String>,
}

fn fixture() -> Golden {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("web")
        .join("contracts")
        .join("fixtures")
        .join("canvas-hot-paths-golden.json");
    let source = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read fixture: {error}"));
    serde_json::from_str(&source).expect("parse fixture")
}

#[test]
fn signature_matches_contract_golden() {
    let golden = fixture();
    assert_eq!(
        canonical_signature(&golden.model_v2.scene_version, &golden.model_v2.ops_json),
        golden.model_v2.signature
    );
}

#[test]
fn fnv_matches_contract_golden() {
    let golden = fixture();
    assert_eq!(fnv1a64_utf16(""), golden.fnv.empty);
    assert_eq!(fnv1a64_utf16("abc"), golden.fnv.abc);
    assert_eq!(fnv1a64_utf16(&golden.fnv.unicode.text), golden.fnv.unicode.hash);
}

#[test]
fn aabb_and_extent_match_contract_golden() {
    let golden = fixture();
    let (min, max) = derive_aabb_from_ops_json(&golden.model_v2.ops_json).expect("aabb");
    for axis in 0..3 {
        assert!((min[axis] - golden.model_v2.aabb.min[axis]).abs() < 1e-3);
        assert!((max[axis] - golden.model_v2.aabb.max[axis]).abs() < 1e-3);
    }
    let extent = derive_extent_from_ops_json(&golden.model_v2.ops_json).expect("extent");
    assert!((extent - golden.model_v2.extent).abs() < 1e-3);
}

#[test]
fn point_hit_matches_contract_golden() {
    let golden = fixture();
    let nodes_json = serde_json::to_string(&golden.point_hit.nodes).expect("nodes json");
    for case in &golden.point_hit.cases {
        let actual = point_hit_kind(&nodes_json, case.world[0], case.world[1], golden.point_hit.zoom)
            .expect("point hit");
        match (&case.expect, actual) {
            (None, None) => {}
            (Some(expected), Some(actual)) => {
                let want = match &expected.side {
                    Some(side) => format!("{}:{}:{}", expected.kind, expected.node_id, side),
                    None => format!("{}:{}", expected.kind, expected.node_id),
                };
                assert_eq!(actual, want, "case {:?}", case.world);
            }
            (expected, actual) => panic!("case {:?}: expected {:?}, got {:?}", case.world, expected.is_some(), actual),
        }
    }
}
