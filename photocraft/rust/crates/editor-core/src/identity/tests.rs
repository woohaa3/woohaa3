use super::*;
use serde_json::json;

#[test]
fn integrated_domains_match_the_shared_typescript_identity_fixture() {
    let fixture: Value = serde_json::from_str(include_str!("../../../../../tests/fixtures/integrated-content.json")).unwrap();
    assert_eq!(canonicalize(&fixture["input"]).as_deref(), fixture["canonical"].as_str());
    assert_eq!(content_hash(&fixture["input"]).as_deref(), fixture["hash"].as_str());
    for field in ["patternContentHash", "channelsContentHash", "mode", "textStyles", "paths", "workPath", "clippingPath", "animation", "variables"] {
        let mut changed = fixture["input"].clone();
        changed.as_object_mut().unwrap().remove(field);
        assert_ne!(content_hash(&changed).as_deref(), fixture["hash"].as_str(), "{field} must contribute to identity");
    }
}

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
fn fill_layer_parameters_are_content_and_keep_other_kinds_compatible() {
    // 非填充层不出现 `fillLayer` 字段：旧工程与其它层类型的指纹保持逐字节兼容。
    let mut doc = document();
    let baseline = content_hash(&doc).unwrap();
    doc["layers"][0]["fillLayer"] = Value::Null;
    assert_eq!(content_hash(&doc).unwrap(), baseline, "null 等同于没有填充内容");

    // 纯色填充：改颜色必须改变指纹（这正是「改填充参数后保存/重开可见」的前提）。
    let mut doc = document();
    doc["layers"][0]["kind"] = json!("fill");
    doc["layers"][0]["pixel"] = Value::Null;
    doc["layers"][0]["fillLayer"] = json!({
        "kind": "solid", "parameters": { "kind": "solid", "color": "#112233", "alpha": 1.0 }
    });
    let first = content_hash(&doc).expect("合法纯色填充必须可判定");
    assert!(canonicalize(&doc).unwrap().contains("fill:solid:#112233:1"));
    doc["layers"][0]["fillLayer"]["parameters"]["color"] = json!("#ff8800");
    assert_ne!(content_hash(&doc).unwrap(), first, "改填充颜色必须改变内容指纹");
    doc["layers"][0]["fillLayer"]["parameters"]["color"] = json!("#112233");
    doc["layers"][0]["fillLayer"]["parameters"]["alpha"] = json!(0.5);
    assert_ne!(content_hash(&doc).unwrap(), first, "改填充透明度必须改变内容指纹");

    // 渐变：样式取规范小写名，端点次序颠倒即非法（无法判定 ≠ 无变化）。
    let mut doc = document();
    doc["layers"][0]["kind"] = json!("fill");
    doc["layers"][0]["pixel"] = Value::Null;
    let gradient = json!({
        "kind": "gradient",
        "parameters": {
            "kind": "gradient",
            "stops": [
                { "at": 0.0, "color": "#ffffff", "alpha": 1.0 },
                { "at": 1.0, "color": "#000000", "alpha": 1.0 }
            ],
            "angle": 45.0, "scale": 1.0, "style": "linear", "reverse": false,
            "opacityStops": [], "midpoints": [], "offset": [0.0, 0.0], "dither": false, "align": true
        }
    });
    doc["layers"][0]["fillLayer"] = gradient.clone();
    let text = canonicalize(&doc).expect("合法渐变必须可判定");
    assert!(text.contains("fill:gradient:linear:45:1:0:0:1:0,0:"), "{text}");
    let base_hash = content_hash(&doc).unwrap();
    doc["layers"][0]["fillLayer"]["parameters"]["angle"] = json!(90.0);
    assert_ne!(content_hash(&doc).unwrap(), base_hash, "改渐变角度必须改变内容指纹");
    doc["layers"][0]["fillLayer"] = gradient.clone();
    doc["layers"][0]["fillLayer"]["parameters"]["stops"][0]["at"] = json!(0.9);
    doc["layers"][0]["fillLayer"]["parameters"]["stops"][1]["at"] = json!(0.1);
    assert!(content_hash(&doc).is_none(), "端点必须递增");
    doc["layers"][0]["fillLayer"] = gradient.clone();
    doc["layers"][0]["fillLayer"]["parameters"]["style"] = json!("Linear");
    assert!(content_hash(&doc).is_none(), "样式必须是规范小写名");
    doc["layers"][0]["fillLayer"] = gradient.clone();
    doc["layers"][0]["fillLayer"]["parameters"]["scale"] = json!(50.0);
    assert!(content_hash(&doc).is_none(), "缩放必须在 0.1–1.5 的比例区间");

    // 图案：引用 id 参与身份，改名（name）也参与（名称随工程保存）。
    let mut doc = document();
    doc["layers"][0]["kind"] = json!("fill");
    doc["layers"][0]["pixel"] = Value::Null;
    doc["layers"][0]["fillLayer"] = json!({
        "kind": "pattern",
        "parameters": {
            "kind": "pattern", "pattern": "grid", "name": "格子",
            "scale": 1.0, "angle": 0.0, "link": true, "phase": [0.0, 0.0]
        }
    });
    let base_hash = content_hash(&doc).expect("合法图案填充必须可判定");
    assert!(canonicalize(&doc).unwrap().contains("fill:pattern:2:格子:4:grid:1:0:1:0,0"));
    doc["layers"][0]["fillLayer"]["parameters"]["pattern"] = json!("dots");
    assert_ne!(content_hash(&doc).unwrap(), base_hash, "换图案必须改变内容指纹");
    doc["layers"][0]["fillLayer"]["parameters"]["pattern"] = json!("grid");
    doc["layers"][0]["fillLayer"]["parameters"]["scale"] = json!(0.0);
    assert!(content_hash(&doc).is_none(), "图案缩放必须为正");

    // 未知种类：无法判定，绝不当作「无变化」。
    doc["layers"][0]["fillLayer"] = json!({ "kind": "swirl", "parameters": { "kind": "swirl" } });
    assert!(content_hash(&doc).is_none());

    // 内容字段的数量必须与 kind 一致：填充层带 `pixel` 内容属于混合内容。
    let mut doc = document();
    doc["layers"][0]["kind"] = json!("fill");
    doc["layers"][0]["fillLayer"] = json!({
        "kind": "solid", "parameters": { "kind": "solid", "color": "#112233", "alpha": 1.0 }
    });
    assert!(content_hash(&doc).is_none(), "填充层不能再带像素内容");
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
fn new_adjustments_shapes_and_vector_masks_join_the_content_identity() {
    // 旧工程（无 shape / vectorMask / 排版字段）保持原指纹。
    let baseline = content_hash(&document()).expect("基线");
    assert_eq!(baseline, "42d710c4700e1a13");

    // 新区调整：levels / vibrance / black-white 都是内容。
    for (kind, parameters) in [
        (
            "levels",
            json!({
                "kind": "levels",
                "master": {"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0},
                "red": {"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0},
                "green": {"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0},
                "blue": {"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0},
            }),
        ),
        ("vibrance", json!({"kind": "vibrance", "vibrance": 12.0, "saturation": -3.0})),
        (
            "black-white",
            json!({"kind": "black-white", "reds": 40.0, "yellows": 60.0, "greens": 40.0,
                "cyans": 60.0, "blues": 20.0, "magentas": 80.0, "tint": null}),
        ),
    ] {
        let mut doc = document();
        doc["layers"][0]["kind"] = json!("adjustment");
        doc["layers"][0]["pixel"] = Value::Null;
        doc["layers"][0]["adjustment"] = json!({ "kind": kind, "parameters": parameters });
        let hash = content_hash(&doc).unwrap_or_else(|| panic!("{kind} 应参与身份"));
        assert_ne!(hash, baseline, "{kind}");
        // 同一输入必须可复现（无随机字段）。
        assert_eq!(content_hash(&doc).as_deref(), Some(hash.as_str()));
        // 非法参数被拒绝，而不是当成缺省。
        let mut bad = doc.clone();
        bad["layers"][0]["adjustment"]["parameters"]["kind"] = json!("unknown");
        assert!(content_hash(&bad).is_none());
    }

    // 形状层：路径摘要参与身份，缺少摘要被拒绝。
    let mut shape = document();
    shape["layers"][0]["kind"] = json!("shape");
    shape["layers"][0]["pixel"] = Value::Null;
    shape["layers"][0]["shape"] = json!({"contentHash": "0123456789abcdef"});
    let shape_hash = content_hash(&shape).expect("形状层可判定");
    assert_ne!(shape_hash, baseline);
    shape["layers"][0]["shape"] = json!({"contentHash": "not-a-hash"});
    assert!(content_hash(&shape).is_none());

    // 矢量蒙版：存在即内容；省略保持旧指纹。
    let mut masked = document();
    masked["layers"][0]["vectorMask"] = json!({"enabled": true, "contentHash": "0123456789abcdef"});
    let masked_hash = content_hash(&masked).expect("矢量蒙版可判定");
    assert_ne!(masked_hash, baseline);
    masked["layers"][0]["vectorMask"]["linked"] = json!(true);
    assert_eq!(content_hash(&masked).as_deref(), Some(masked_hash.as_str()), "默认链接不改变指纹");
    masked["layers"][0]["vectorMask"]["linked"] = json!(false);
    assert_ne!(content_hash(&masked).as_deref(), Some(masked_hash.as_str()));
    masked["layers"][0]["vectorMask"]["enabled"] = json!(false);
    assert!(content_hash(&masked).is_some());

    // 文字排版：省略保持旧指纹；设置后是内容。
    let mut text = document();
    text["layers"][0]["kind"] = json!("text");
    text["layers"][0]["pixel"] = Value::Null;
    text["layers"][0]["text"] = json!({"text": "标题", "fontFamily": "Inter", "fontSize": 12,
        "color": "#ffffff", "bold": false, "align": "left"});
    let plain = content_hash(&text).expect("点文字");
    text["layers"][0]["text"]["leading"] = json!(18.0);
    assert_ne!(content_hash(&text).as_deref(), Some(plain.as_str()));
    text["layers"][0]["text"]["leading"] = Value::Null;
    text["layers"][0]["text"]["tracking"] = json!(0);
    assert_eq!(content_hash(&text).as_deref(), Some(plain.as_str()), "默认字距保持旧指纹");
    text["layers"][0]["text"]["kerning"] = json!("optical");
    assert_ne!(content_hash(&text).as_deref(), Some(plain.as_str()));
}

#[test]
fn every_published_adjustment_kind_joins_the_content_identity() {
    // U43/U44 的九个新类型必须有 canonical 形式：否则含这些调整层的工程无法判定内容身份。
    let cases = [
        ("exposure", json!({"kind": "exposure", "exposure": 1.5, "offset": 0.1, "gamma": 1.1})),
        ("color-balance", json!({"kind": "color-balance", "shadows": [10.0, -5.0, 0.0],
            "midtones": [0.0, 5.0, 0.0], "highlights": [0.0, 0.0, 5.0], "preserveLuminosity": true})),
        ("photo-filter", json!({"kind": "photo-filter", "color": "#ff8800", "density": 25.0, "preserveLuminosity": true})),
        ("channel-mixer", json!({"kind": "channel-mixer", "red": [40.0, 40.0, 20.0, 0.0],
            "green": [30.0, 60.0, 10.0, 0.0], "blue": [20.0, 20.0, 60.0, 0.0], "monochrome": false})),
        ("invert", json!({"kind": "invert"})),
        ("posterize", json!({"kind": "posterize", "levels": 6})),
        ("threshold", json!({"kind": "threshold", "level": 128})),
        ("gradient-map", json!({"kind": "gradient-map", "stops": [[0.0, "#000000"], [1.0, "#ffffff"]],
            "reverse": false, "dither": true})),
        ("selective-color", json!({"kind": "selective-color", "method": "relative",
            "reds": [10.0, 0.0, 0.0, 0.0], "yellows": [0.0, 0.0, 0.0, 0.0], "greens": [0.0, 0.0, 0.0, 0.0],
            "cyans": [0.0, 0.0, 0.0, 0.0], "blues": [0.0, 0.0, 0.0, 0.0], "magentas": [0.0, 0.0, 0.0, 0.0],
            "whites": [0.0, 0.0, 0.0, 0.0], "neutrals": [0.0, 0.0, 0.0, 0.0], "blacks": [0.0, 0.0, 0.0, 0.0]})),
    ];
    let baseline = content_hash(&document()).expect("基线");
    for (kind, parameters) in cases {
        let mut doc = document();
        doc["layers"][0]["kind"] = json!("adjustment");
        doc["layers"][0]["pixel"] = Value::Null;
        doc["layers"][0]["adjustment"] = json!({ "kind": kind, "parameters": parameters });
        let hash = content_hash(&doc).unwrap_or_else(|| panic!("{kind} 应参与身份"));
        assert_ne!(hash, baseline, "{kind}");
        // 可复现：同样输入得到同样指纹。
        assert_eq!(content_hash(&doc).as_deref(), Some(hash.as_str()), "{kind}");
        // 参数非法（缺键 / 类型不符）必须判为无法判定，而不是算出一个错的身份。
        // `invert` 没有参数可缺，跳过（它的规范串只由 kind 决定）。
        if kind != "invert" {
            let mut bad = doc.clone();
            bad["layers"][0]["adjustment"]["parameters"] = json!({ "kind": kind });
            assert!(content_hash(&bad).is_none(), "{kind}");
        }
    }
}

#[test]
fn new_persistent_parameters_change_identity_but_defaults_stay_compatible() {
    // 兼容规则：U41/U42 新增的持久参数只在**非默认值**时进入规范串，
    // 所以旧工程（没有这些键）与默认值工程得到同一个指纹。
    let levels = |extra: Value| {
        let mut channel = json!({"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0});
        if let (Some(target), Some(source)) = (channel.as_object_mut(), extra.as_object()) {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
        }
        let mut doc = document();
        doc["layers"][0]["kind"] = json!("adjustment");
        doc["layers"][0]["pixel"] = Value::Null;
        doc["layers"][0]["adjustment"] = json!({
            "kind": "levels",
            "parameters": { "kind": "levels", "master": channel.clone(), "red": channel.clone(),
                "green": channel.clone(), "blue": channel }
        });
        content_hash(&doc).expect("色阶可判定")
    };
    let plain = levels(json!({}));
    assert_eq!(levels(json!({"outBlack": 0.0, "outWhite": 255.0})), plain, "默认输出端点不改变旧指纹");
    assert_ne!(levels(json!({"outWhite": 200.0})), plain, "输出白场是内容");
    assert_ne!(levels(json!({"outBlack": 20.0})), plain, "输出黑场是内容");

    // 色相：Colorize 与单个色域是内容，缺省不改变旧指纹。
    let hue = |parameters: Value| {
        let mut doc = document();
        doc["layers"][0]["kind"] = json!("adjustment");
        doc["layers"][0]["pixel"] = Value::Null;
        doc["layers"][0]["adjustment"] = json!({ "kind": "hue-saturation", "parameters": parameters });
        content_hash(&doc).expect("色相可判定")
    };
    let plain = hue(json!({"kind": "hue-saturation", "hue": 10.0, "saturation": 20.0, "lightness": 0.0}));
    assert_eq!(
        hue(json!({"kind": "hue-saturation", "hue": 10.0, "saturation": 20.0, "lightness": 0.0,
            "colorize": false, "reds": {"hue": 0.0, "saturation": 0.0, "lightness": 0.0}})),
        plain,
        "中性色域与关闭的 Colorize 不改变旧指纹"
    );
    assert_ne!(
        hue(json!({"kind": "hue-saturation", "hue": 10.0, "saturation": 20.0, "lightness": 0.0, "colorize": true})),
        plain,
        "Colorize 是内容"
    );
    assert_ne!(
        hue(json!({"kind": "hue-saturation", "hue": 10.0, "saturation": 20.0, "lightness": 0.0,
            "reds": {"hue": 0.0, "saturation": -40.0, "lightness": 0.0, "range": [-45.0, -15.0, 15.0, 45.0]}})),
        plain,
        "单个色域是内容（U42 的丢改动缺陷正是这里）"
    );
}

#[test]
fn published_adjustment_canonical_strings_are_byte_identical_to_typescript() {
    // 跨语言逐字节一致：下面每条规范串同时被 `packages/protocol/src/image-project.test.ts` 的
    // 「U43/U44 规范串与 Rust 逐字节一致」用例断言。改一边必须同时改另一边。
    let layer = |kind: &str, parameters: Value| {
        let mut doc = document();
        doc["layers"][0]["kind"] = json!("adjustment");
        doc["layers"][0]["pixel"] = Value::Null;
        doc["layers"][0]["adjustment"] = json!({ "kind": kind, "parameters": parameters });
        canonicalize(&doc).expect("可判定").split('|').next_back().unwrap().to_string()
    };
    let channel = || json!({"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0});
    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "levels",
            json!({"kind": "levels", "master": {"inBlack": 0.0, "gamma": 1.0, "inWhite": 255.0, "outBlack": 0.0, "outWhite": 200.0},
                "red": channel(), "green": channel(), "blue": channel()}),
            "adjust:levels:0,1,255/0,200;0,1,255;0,1,255;0,1,255",
        ),
        (
            "hue-saturation",
            json!({"kind": "hue-saturation", "hue": 10.0, "saturation": 20.0, "lightness": 0.0, "colorize": false,
                "reds": {"hue": 0.0, "saturation": 0.0, "lightness": 0.0, "range": [-45.0, -15.0, 15.0, 45.0]}}),
            "adjust:hue-saturation:10:20:0",
        ),
        (
            "hue-saturation",
            json!({"kind": "hue-saturation", "hue": 10.0, "saturation": 20.0, "lightness": 0.0, "colorize": true,
                "reds": {"hue": 5.0, "saturation": -40.5, "lightness": 3.0, "range": [-45.0, -15.0, 15.0, 45.0]}}),
            "adjust:hue-saturation:10:20:0:colorize:reds/5/-40.5/3/-45,-15,15,45",
        ),
        (
            "curves",
            json!({"kind": "curves", "rgb": [{"x": 0.0, "y": 0.0}, {"x": 0.5, "y": 0.75}, {"x": 1.0, "y": 1.0}], "pencil": true}),
            "adjust:curves:0,0;0.5,0.75;1,1:pencil",
        ),
        (
            "exposure",
            json!({"kind": "exposure", "exposure": 1.5, "offset": 0.1, "gamma": 1.1}),
            "adjust:exposure:1.5:0.1:1.1",
        ),
        (
            "color-balance",
            json!({"kind": "color-balance", "shadows": [10.0, -5.0, 0.0], "midtones": [0.0, 5.0, 0.0],
                "highlights": [0.0, 0.0, 5.0], "preserveLuminosity": true}),
            "adjust:color-balance:10,-5,0:0,5,0:0,0,5:1",
        ),
        (
            "photo-filter",
            json!({"kind": "photo-filter", "color": [1.0, 0.5, 0.0], "density": 25.0, "preserveLuminosity": false}),
            "adjust:photo-filter:#ff8000:25:0",
        ),
        (
            "channel-mixer",
            json!({"kind": "channel-mixer", "red": [40.0, 40.0, 20.0, 0.0], "green": [30.0, 60.0, 10.0, 0.0],
                "blue": [20.0, 20.0, 60.0, 0.0], "monochrome": false}),
            "adjust:channel-mixer:40,40,20,0:30,60,10,0:20,20,60,0:0",
        ),
        ("invert", json!({"kind": "invert"}), "adjust:invert"),
        ("posterize", json!({"kind": "posterize", "levels": 6}), "adjust:posterize:6"),
        ("threshold", json!({"kind": "threshold", "level": 128}), "adjust:threshold:128"),
        (
            "gradient-map",
            json!({"kind": "gradient-map", "stops": [[0.0, "#000000"], [0.5, "#ab12ef"], [1.0, "#ffffff"]],
                "reverse": false, "dither": true}),
            "adjust:gradient-map:0,#000000;0.5,#ab12ef;1,#ffffff:0:1",
        ),
        (
            "selective-color",
            json!({"kind": "selective-color", "method": "absolute", "reds": [10.0, -5.0, 0.0, 0.0],
                "yellows": [0.0, 0.0, 0.0, 0.0], "greens": [0.0, 0.0, 0.0, 0.0], "cyans": [0.0, 0.0, 0.0, 0.0],
                "blues": [0.0, 0.0, 0.0, 0.0], "magentas": [0.0, 0.0, 0.0, 0.0], "whites": [0.0, 0.0, 0.0, 0.0],
                "neutrals": [0.0, 0.0, 0.0, 0.0], "blacks": [0.0, 0.0, 0.0, 0.0]}),
            "adjust:selective-color:absolute:10,-5,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0;0,0,0,0",
        ),
    ];
    for (kind, parameters, expected) in cases {
        assert_eq!(layer(kind, parameters), expected, "{kind}");
    }
}

#[test]
fn document_paths_are_content_and_empty_stays_compatible() {
    // 已存命名路径 / 工作路径 / 裁切路径是**持久字段**：改一条已存路径必须改变指纹，
    // 否则宿主会把它判成「无净变化」而丢工作。
    let baseline = document();
    let baseline_hash = content_hash(&baseline).expect("基线");
    let mut with_paths = document();
    with_paths["paths"] = json!([
        { "name": "中文", "contentHash": "1111111111111111" },
        { "name": "A", "contentHash": "2222222222222222" }
    ]);
    let saved = content_hash(&with_paths).expect("已存路径可判定");
    assert_ne!(saved, baseline_hash);
    // 顺序不敏感（加载顺序不得影响指纹），且与 TypeScript 逐字节一致。
    with_paths["paths"] = json!([
        { "name": "A", "contentHash": "2222222222222222" },
        { "name": "中文", "contentHash": "1111111111111111" }
    ]);
    assert_eq!(content_hash(&with_paths).as_deref(), Some(saved.as_str()));
    // 规范文本的形态固定（Rust/TS 两端逐字节一致）：`<UTF-16 长度>:<名字>:<摘要>` 直接拼接。
    assert!(
        canonicalize(&with_paths)
            .unwrap()
            .contains("paths:[1:A:22222222222222222:中文:1111111111111111]"),
        "已存路径按名字稳定排序后以长度前缀连接"
    );
    // 改一条路径的几何摘要 = 内容变化。
    with_paths["paths"][0]["contentHash"] = json!("3333333333333333");
    assert_ne!(content_hash(&with_paths).as_deref(), Some(saved.as_str()));

    // 空数组 / 空 name / 非法摘要都按「无法判定」或「无后缀」处理，绝不静默当成无变化。
    let mut empty = document();
    empty["paths"] = json!([]);
    assert_eq!(content_hash(&empty), Some(baseline_hash.clone()));
    empty["paths"] = json!(null);
    assert_eq!(content_hash(&empty), Some(baseline_hash.clone()));
    for bad in [json!([{"name": " ", "contentHash": "1111111111111111"}]), json!([{"name": "A", "contentHash": "nope"}])] {
        let mut doc = document();
        doc["paths"] = bad;
        assert!(content_hash(&doc).is_none());
    }

    // 工作路径。
    let mut work = document();
    work["workPath"] = json!({ "contentHash": "4444444444444444" });
    let work_hash = content_hash(&work).expect("工作路径可判定");
    assert_ne!(work_hash, baseline_hash);
    work["workPath"]["contentHash"] = json!("5555555555555555");
    assert_ne!(content_hash(&work).as_deref(), Some(work_hash.as_str()));

    // 裁切路径引用：名字与平直度都是内容。
    let mut clip = document();
    clip["clippingPath"] = json!({ "name": "A", "flatness": 2 });
    let clip_hash = content_hash(&clip).expect("裁切路径可判定");
    assert_ne!(clip_hash, baseline_hash);
    clip["clippingPath"]["flatness"] = json!(2.5);
    assert_ne!(content_hash(&clip).as_deref(), Some(clip_hash.as_str()), "平直度是导出语义");
    clip["clippingPath"]["flatness"] = json!(1e9);
    assert!(content_hash(&clip).is_none(), "越界平直度不是内容");
    clip["clippingPath"] = json!({ "name": "", "flatness": 0 });
    assert!(content_hash(&clip).is_none());
}

#[test]
fn document_paths_canonical_text_matches_typescript() {
    // 期望值由协议包 `canonicalizeImageProjectContent` 对同一输入计算（fixture 固定）：
    // 顺序按 (名字, 摘要) 稳定排序；名字带 UTF-16 长度前缀；平直度按 1e-4 归一。
    let mut doc = document();
    doc["paths"] = json!([
        { "name": "中文", "contentHash": "1111111111111111" },
        { "name": "A", "contentHash": "2222222222222222" }
    ]);
    doc["workPath"] = json!({ "contentHash": "3333333333333333" });
    doc["clippingPath"] = json!({ "name": "A", "flatness": 2.5 });
    let canonical = "canvas:800x600\npaths:[1:A:22222222222222222:中文:1111111111111111]\nwork:3333333333333333\nclip:1:A:2.5\nlayer|background|背景|pixel|1|1|normal|0,0,1,0,0,0|none|pixel:asset-base:0123456789abcdef";
    assert_eq!(canonicalize(&doc).as_deref(), Some(canonical));
    assert_eq!(content_hash(&doc).as_deref(), Some("ef50aab665dcced5"));
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

fn video_layer(name: &str) -> Value {
    json!({
        "name": name,
        "video": {
            "fps": 30, "showAltered": true,
            "frames": [{"contentHash": "0123456789abcdef", "width": 8, "height": 8, "format": "RGBA8"}]
        }
    })
}

#[test]
fn animation_summary_joins_the_shared_canonical_form() {
    // 旧工程没有 `animation` 字段：规范文本必须逐字节不变（指纹兼容）。
    let plain = document();
    let baseline = canonicalize(&plain).unwrap();
    assert!(!baseline.contains("animation:"));
    assert_eq!(content_hash(&plain).as_deref(), Some("42d710c4700e1a13"));

    // 带时间轴与视频层：追加一行，格式与 TS `canonicalizeAnimationContent` 逐字节相同。
    let mut doc = document();
    doc["animation"] = json!({ "timeline": {"fps": 24, "duration": 3}, "layers": [video_layer("视频")] });
    assert_eq!(
        canonicalize(&doc).unwrap(),
        format!("{baseline}\nanimation:24,3:47:[42:2:视频@30,1,29:[0123456789abcdef,8,8,RGBA8;]]")
    );
    assert_ne!(content_hash(&doc).as_deref(), Some("42d710c4700e1a13"));

    // 帧率、时长、帧内容、帧顺序都改变指纹。
    let with = |patch: Value| {
        let mut next = doc.clone();
        for (key, value) in patch.as_object().unwrap() {
            if key == "animation" {
                next["animation"] = value.clone();
            }
        }
        content_hash(&next)
    };
    assert_ne!(with(json!({"animation": {"timeline": {"fps": 30, "duration": 3}, "layers": [video_layer("视频")]}})), content_hash(&doc));
    assert_ne!(with(json!({"animation": {"timeline": {"fps": 24, "duration": 4}, "layers": [video_layer("视频")]}})), content_hash(&doc));
    assert_ne!(with(json!({"animation": {"timeline": {"fps": 24, "duration": 3}, "layers": [video_layer("改")]}})), content_hash(&doc));

    // 空帧（宽高 0）是合法内容：不能因为「尺寸必须为正」把整份文档判成无法判定。
    let mut empty = document();
    empty["animation"] = json!({
        "timeline": null,
        "layers": [{"name": "v", "video": {"fps": 24, "showAltered": false, "frames": []}}]
    });
    assert!(content_hash(&empty).is_some());

    // 没有帧栈的组用 `null` 表示，空对象/非法值都返回「无法判定」。
    let mut group = document();
    group["animation"] = json!({
        "timeline": null,
        "layers": [{"name": "组", "video": null, "children": [video_layer("子")]}]
    });
    let text = canonicalize(&group).expect("组只有子层帧也是内容");
    assert!(text.contains("@-"), "{text}");
    let mut empty_object = document();
    empty_object["animation"] = json!({
        "timeline": null,
        "layers": [{"name": "组", "video": {}, "children": [video_layer("子")]}]
    });
    assert!(canonicalize(&empty_object).is_none(), "空对象不能顶替 null");
    for broken in [
        json!({"timeline": {"fps": 24, "duration": 0}, "layers": []}),
        json!({"timeline": {"fps": null, "duration": 3}, "layers": []}),
        json!({"timeline": null, "layers": [{"name": "v", "video": {"fps": 24, "showAltered": true, "frames": [{"contentHash": "短", "width": 8, "height": 8, "format": "RGBA8"}]}}]}),
        json!({"timeline": null, "layers": [{"name": "v", "video": {"fps": 24, "showAltered": true, "frames": [{"contentHash": "0123456789abcdef", "width": 8, "height": 8, "format": "a,b"}]}}]}),
    ] {
        let mut invalid = document();
        invalid["animation"] = broken.clone();
        assert!(content_hash(&invalid).is_none(), "{broken}");
    }
}

#[test]
fn variables_and_data_sets_enter_the_canonical_text() {
    // 变量/数据集是持久内容（`doc.variables` 随 `.pcraft` 保存），必须参与身份。
    // 这段文本形状由协议 `canonicalizeVariables` 逐字节复现。
    let base = serde_json::json!({
        "canvasWidth": 8,
        "canvasHeight": 6,
        "layers": [{
            "id": "layer-1", "name": "背景", "kind": "pixel",
            "visible": true, "opacity": 1, "blend": "normal",
            "transform": {"translateX":0,"translateY":0,"scale":1,"rotationDegrees":0,"flipHorizontal":false,"flipVertical":false},
            "mask": null,
            "pixel": {"sourceAssetId": null, "contentHash": "0123456789abcdef"},
            "text": null, "adjustment": null
        }]
    });
    let plain = canonicalize(&base).unwrap();
    assert!(!plain.contains("variables:"), "空变量保持旧指纹形状");

    let mut with_vars = base.clone();
    with_vars["variables"] = serde_json::json!({
        "defs": [
            {"name":"show","layer":"layer-1","type":"visibility"},
            {"name":"photo","layer":"layer-2","type":"pixelReplacement","method":"fill","align":"topLeft","clip":true}
        ],
        "dataSets": [
            {"name":"一","values":[
                {"variable":"show","kind":"visibility","value":false},
                {"variable":"photo","kind":"pixels","value":"a.png"}
            ]}
        ]
    });
    let canonical = canonicalize(&with_vars).unwrap();
    let line = canonical.split('\n').next_back().unwrap();
    assert_eq!(
        line,
        "variables:[31:def|4:show|7:layer-1|visibility53:def|5:photo|7:layer-2|pixelReplacement|fill|topLeft|1][69:set|1:一|[25:value|4:show|visibility|028:value|5:photo|pixels|5:a.png]]"
    );
    assert_ne!(content_hash(&with_vars), content_hash(&base));

    // 未知种类 / 非法载荷 → `None`（无法判定，不是「无变化」）。
    for broken in [
        serde_json::json!({"defs":[{"name":"x","layer":"layer-1","type":"magic"}],"dataSets":[]}),
        serde_json::json!({"defs":[{"name":"x","layer":"layer-1","type":"pixelReplacement","method":"stretch","align":"center","clip":false}],"dataSets":[]}),
        serde_json::json!({"defs":[{"name":"","layer":"layer-1","type":"visibility"}],"dataSets":[]}),
        serde_json::json!({"defs":[],"dataSets":[{"name":"s","values":[{"variable":"x","kind":"magic","value":1}]}]}),
    ] {
        let mut content = base.clone();
        content["variables"] = broken;
        assert!(canonicalize(&content).is_none(), "{content}");
    }
}
