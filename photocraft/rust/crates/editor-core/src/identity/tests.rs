use super::*;
use serde_json::json;

fn transform() -> Value {
    json!({
        "translateX": 0, "translateY": 0, "scale": 1,
        "rotationDegrees": 0, "flipHorizontal": false, "flipVertical": false
    })
}

fn pixel_layer() -> Value {
    json!({
        "id": "background", "name": "背景", "kind": "pixel", "visible": true,
        "opacity": 1, "blend": "normal", "transform": transform(), "mask": null,
        "pixel": { "sourceAssetId": "asset-base", "contentHash": "0123456789abcdef" },
        "text": null, "adjustment": null
    })
}

fn document() -> Value {
    json!({ "canvasWidth": 800, "canvasHeight": 600, "layers": [pixel_layer()] })
}

#[test]
fn pattern_resource_summary_has_shared_canonical_form() {
    let mut doc=document();let base=content_hash(&doc).unwrap();
    doc["patternContentHash"]=json!("0123456789abcdef");
    assert!(canonicalize(&doc).unwrap().contains("canvas:800x600\npatterns:0123456789abcdef\n"));
    assert_ne!(content_hash(&doc).unwrap(),base);
    assert_eq!(content_hash(&doc).unwrap(),"a625f47a4bc9c3e6");
    for value in [json!(null),json!("unsupported"),json!("0123456789abcdeF"),json!(123)] {
        doc["patternContentHash"]=value;assert!(content_hash(&doc).is_none());
    }
}

fn group(children: Vec<Value>) -> Value {
    let mut layer = pixel_layer();
    layer["id"] = json!("group"); layer["name"] = json!("组");
    layer["kind"] = json!("group"); layer["blend"] = json!("pass-through");
    layer["pixel"] = Value::Null; layer["children"] = json!(children);
    layer
}

#[test]
fn style_summary_matches_typescript_and_keeps_empty_style_compatible() {
    let mut doc=document();let baseline=content_hash(&doc).unwrap();
    doc["layers"][0]["effects"]=Value::Null;assert_eq!(content_hash(&doc).unwrap(),baseline);
    doc["layers"][0]["effects"]=json!({"enabled":true,"contentHash":"0123456789abcdef"});
    assert_eq!(content_hash(&doc).unwrap(),"d0533ad14dc4f832");
    doc["layers"][0]["effects"]["enabled"]=json!(false);assert_ne!(content_hash(&doc).unwrap(),"d0533ad14dc4f832");
    doc["layers"][0]["effects"]["contentHash"]=json!("unsupported");assert!(content_hash(&doc).is_none());
}

#[test]
fn fill_is_independent_content_and_defaults_keep_old_identity() {
    let mut doc=document(); let baseline=content_hash(&doc).unwrap();
    doc["layers"][0]["fill"]=json!(1.0);
    assert_eq!(content_hash(&doc).unwrap(),baseline);
    doc["layers"][0]["fill"]=json!(0.4);
    assert_ne!(content_hash(&doc).unwrap(),baseline);
    assert!(canonicalize(&doc).unwrap().contains("|fill:0.4"));
    for value in [json!(-1),json!(1.1),Value::Null,json!("0.4")] {
        doc["layers"][0]["fill"]=value;assert!(content_hash(&doc).is_none());
    }
}

#[test]
fn group_tree_hash_matches_typescript_and_excludes_expansion() {
    let mut empty = group(vec![]);
    empty["id"] = json!("empty"); empty["name"] = json!("空组");
    let mut doc = document();
    doc["layers"] = json!([group(vec![pixel_layer(), empty])]);
    let baseline = content_hash(&doc).unwrap();
    assert_eq!(baseline, "380d5e0af12766e3");
    doc["layers"][0]["expanded"] = json!(false);
    assert_eq!(content_hash(&doc).unwrap(), baseline);
    doc["layers"][0]["children"][0]["opacity"] = json!(0.5);
    assert_ne!(content_hash(&doc).unwrap(), baseline);
    doc["layers"][0]["children"][0]["opacity"] = json!(1);
    doc["layers"][0]["children"].as_array_mut().unwrap().reverse();
    assert_ne!(content_hash(&doc).unwrap(), baseline);
    doc["layers"][0]["children"].as_array_mut().unwrap().reverse();
    doc["layers"][0]["blend"] = json!("normal");
    assert_ne!(content_hash(&doc).unwrap(), baseline);
}

#[test]
fn group_rejects_mixed_bodies_hidden_children_and_non_group_passthrough() {
    let mut bad = group(vec![]); bad.as_object_mut().unwrap().remove("children");
    let mut mixed = group(vec![]); mixed["pixel"] = pixel_layer()["pixel"].clone();
    let mut hidden = pixel_layer(); hidden["children"] = json!([]);
    let mut passthrough = pixel_layer(); passthrough["blend"] = json!("pass-through");
    let mut smart = pixel_layer(); smart["kind"] = json!("smart");
    for layer in [bad, mixed, hidden, passthrough, group(vec![smart])] {
        let mut doc = document(); doc["layers"] = json!([layer]);
        assert!(content_hash(&doc).is_none());
    }
}

#[test]
fn group_tree_limits_count_all_descendants() {
    let mut nested = group(vec![]);
    for _ in 1..photocraft_project_verify::MAX_DOCUMENT_DEPTH { nested = group(vec![nested]); }
    let mut doc = document(); doc["layers"] = json!([nested.clone()]);
    assert!(content_hash(&doc).is_some());
    doc["layers"] = json!([group(vec![nested])]);
    assert!(content_hash(&doc).is_none());
    let children = vec![group(vec![]); photocraft_project_verify::MAX_LAYERS - 1];
    doc["layers"] = json!([group(children)]);
    assert!(content_hash(&doc).is_some());
    doc["layers"][0]["children"].as_array_mut().unwrap().push(group(vec![]));
    assert!(content_hash(&doc).is_none());
}

#[test]
fn clipping_is_content_with_default_compatibility_and_shared_hash() {
    let mut doc=document();let baseline=content_hash(&doc).unwrap();
    doc["layers"][0]["clipped"]=json!(false);assert_eq!(content_hash(&doc).unwrap(),baseline);
    doc["layers"][0]["clipped"]=json!(true);
    assert_eq!(content_hash(&doc).unwrap(),"ca3d4d65d1a04e10");
    assert!(canonicalize(&doc).unwrap().ends_with("|clipped"));
    for invalid in [Value::Null,json!(0),json!(1),json!("true"),json!([]),json!({})] {
        doc["layers"][0]["clipped"]=invalid;assert!(content_hash(&doc).is_none());
    }
}

#[test]
fn layer_locks_are_content_with_unlocked_compatibility_and_cross_language_hash() {
    let mut doc=document();let baseline=content_hash(&doc).unwrap();
    for locks in [json!({}),json!({"position":false,"all":false})] {
        doc["layers"][0]["locks"]=locks;assert_eq!(content_hash(&doc).unwrap(),baseline);
    }
    for key in ["transparency","pixels","position","artboard","all"] {
        doc["layers"][0]["locks"]=json!({key:true});assert_ne!(content_hash(&doc).unwrap(),baseline);
    }
    doc["layers"][0]["locks"]=json!({"all":true,"position":true});
    assert!(canonicalize(&doc).unwrap().ends_with("|locks:00101"));
    assert_eq!(content_hash(&doc).unwrap(),"a7fefd5a50bda5b1");
    for locks in [Value::Null,json!([]),json!(true),json!({"all":1}),json!({"all":null}),json!({"unknown":false})] {
        doc["layers"][0]["locks"]=locks;assert!(content_hash(&doc).is_none());
    }
}

#[test]
fn canonical_text_is_deterministic_and_compact() {
    let text = canonicalize(&document()).expect("规范文本");
    assert_eq!(
        text,
        "canvas:800x600\nlayer|background|背景|pixel|1|1|normal|0,0,1,0,0,0|none|pixel:asset-base:0123456789abcdef"
    );
}

#[test]
fn view_state_is_not_part_of_the_content() {
    // 选区、取景、活动层、工具偏好与保存时间不属于内容：额外字段被忽略，指纹不变。
    let mut with_view = document();
    with_view["activeLayerIndex"] = json!(3);
    with_view["selection"] = json!({ "kind": "rect" });
    with_view["zoom"] = json!(2.5);
    with_view["savedAt"] = json!("2026-10-16T00:00:00Z");
    assert_eq!(content_hash(&document()), content_hash(&with_view));
}

#[test]
fn same_png_different_structure_differs() {
    let mut two_layers = document();
    let mut second = pixel_layer();
    second["id"] = json!("extra");
    second["name"] = json!("另一个");
    two_layers["layers"] = json!([pixel_layer(), second]);
    assert_ne!(content_hash(&document()), content_hash(&two_layers));
}

#[test]
fn rejects_unknown_kinds_blends_adjustments_and_mixed_bodies() {
    let mut bad_kind = document();
    bad_kind["layers"][0]["kind"] = json!("shape");
    assert!(content_hash(&bad_kind).is_none());

    let mut bad_blend = document();
    bad_blend["layers"][0]["blend"] = json!("reflect");
    assert!(content_hash(&bad_blend).is_none());

    let mut bad_adjust = document();
    bad_adjust["layers"][0]["adjustment"] = json!({ "kind": "curves", "parameters": { "kind": "curves" } });
    assert!(content_hash(&bad_adjust).is_none());

    let mut mixed = document();
    mixed["layers"][0]["text"] = json!({
        "text": "x", "fontFamily": "Inter", "fontSize": 12,
        "color": "#ffffff", "bold": false, "align": "left"
    });
    assert!(content_hash(&mixed).is_none());

    assert!(content_hash(&json!({ "canvasWidth": 0, "canvasHeight": 600, "layers": [pixel_layer()] })).is_none());
    assert!(content_hash(&json!({ "canvasWidth": 800, "canvasHeight": 600, "layers": [] })).is_none());
}

/// 跨语言等价：同一规范文本在 TypeScript `fnv1a64Hex` 与 Rust `fnv1a64_hex` 上得到同一指纹。
/// 期望值由 contracts 的 `image-project.test.ts`「跨语言指纹 fixture」用同一文本生成。
#[test]
fn cross_language_hash_fixture_matches_typescript() {
    let canonical = "canvas:800x600\nlayer|background|背景|pixel|1|1|normal|0,0,1,0,0,0|none|pixel:asset-base:0123456789abcdef";
    assert_eq!(fnv1a64_hex(canonical), "42d710c4700e1a13");
    assert_eq!(canonicalize(&document()).as_deref(), Some(canonical));
    assert_eq!(content_hash(&document()).as_deref(), Some("42d710c4700e1a13"));
}

#[test]
fn mask_link_default_is_compatible_and_unlinked_hash_matches_typescript() {
    let mut doc=document();
    doc["layers"][0]["mask"]=json!({"enabled":true,"origin":"paint","contentHash":"0123456789abcdef"});
    let old=content_hash(&doc);
    doc["layers"][0]["mask"]["linked"]=json!(true);
    assert_eq!(content_hash(&doc),old);
    doc["layers"][0]["mask"]["linked"]=json!(false);
    assert_eq!(content_hash(&doc).as_deref(),Some("ab60b2f81ebba8f0"));
    doc["layers"][0]["mask"]["linked"]=json!("false");
    assert!(content_hash(&doc).is_none());
}

#[test]
fn paragraph_box_is_content_and_matches_typescript() {
    let mut doc=document();
    doc["layers"][0]["kind"]=json!("text");doc["layers"][0]["pixel"]=Value::Null;
    doc["layers"][0]["text"]=json!({"text":"标题","fontFamily":"Inter","fontSize":12,"color":"#ffffff","bold":false,"align":"left"});
    let point=content_hash(&doc);
    doc["layers"][0]["text"]["box"]=Value::Null;assert_eq!(content_hash(&doc),point);
    doc["layers"][0]["text"]["box"]=json!([0,0,120,70]);
    assert_eq!(content_hash(&doc).as_deref(),Some("a4642cb445e77939"));
    assert_ne!(content_hash(&doc),point);
    doc["layers"][0]["text"]["box"]=json!([0,0,0,70]);assert!(content_hash(&doc).is_none());
}

#[test]
fn normalizes_negative_zero_like_javascript() {
    // `Math.round(-0.00001 * 1e4) / 1e4` 是 `-0`，`String(-0)` 是 `"0"`。
    let mut with_negative_zero = document();
    with_negative_zero["layers"][0]["transform"]["translateX"] = json!(-0.00001);
    let text = canonicalize(&with_negative_zero).expect("规范文本");
    assert!(text.contains("|0,0,1,0,0,0|"), "{text}");

    // 常规负数保留一位小数的语义值。
    let mut negative = document();
    negative["layers"][0]["transform"]["translateX"] = json!(-0.2);
    let text = canonicalize(&negative).expect("规范文本");
    assert!(text.contains("|-0.2,0,1,0,0,0|"), "{text}");
}
#[test]
fn smart_summary_has_exact_affine_and_shared_typescript_hash() {
    let mut doc=document();doc["layers"][0]["kind"]=json!("smart");doc["layers"][0]["pixel"]=Value::Null;
    doc["layers"][0]["smart"]=json!({"sourceContentHash":"0123456789abcdef","sourceName":"源🙂.pcraft","contentsGroup":1,"transform":[1.0,0.0,1e-8,2.0,10.0,-0.0]});
    assert_eq!(content_hash(&doc).as_deref(),Some("3c0a3d85d7e8d7f2"));
    let baseline=content_hash(&doc);doc["layers"][0]["smart"]["transform"][2]=json!(2e-8);assert_ne!(content_hash(&doc),baseline);
    let mut shared=doc.clone();let copy=shared["layers"][0].clone();shared["layers"].as_array_mut().unwrap().push(copy);
    assert!(content_hash(&shared).is_some());shared["layers"][1]["smart"]["sourceName"]=json!("other.pcraft");assert!(content_hash(&shared).is_none());
    for patch in [json!({"sourceName":"../x.pcraft"}),json!({"sourceName":"\u{feff}.pcraft"}),json!({"sourceContentHash":"unsupported"}),json!({"transform":[1,0,0,0,0,0]}),json!({"contentsGroup":1.5})] {
        let mut invalid=doc.clone();for (key,value) in patch.as_object().unwrap() {invalid["layers"][0]["smart"][key]=value.clone();}assert!(content_hash(&invalid).is_none());
    }
    doc["layers"][0]["smart"]["contentsGroup"]=json!(2);assert!(content_hash(&doc).is_none());
    doc["layers"][0]["smart"]["contentsGroup"]=json!(1);doc["layers"][0]["smart"]["extra"]=json!(true);assert!(content_hash(&doc).is_none());
}
