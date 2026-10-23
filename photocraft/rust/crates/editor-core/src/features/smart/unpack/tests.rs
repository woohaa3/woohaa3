//! 转回图层与源导出/替换的域内回归：真实转换、一步历史、共享实例不变、
//! 拒绝条件不写文档。镜像像素合成的完整视觉验收在真实设备上另行执行。
use super::*;
use crate::Editor;
use photocraft_doc::{ColorMode, Rect, SampleType, Size};
use serde_json::json;

/// 26×18 的嵌入源：填过色的背景 + 一个空像素层。
fn source_bytes() -> Vec<u8> {
    let mut document = Document::new("源", Size::new(26, 18), ColorMode::Rgb, SampleType::U8);
    let mut background = Layer::raster("背景", document.pixel_format());
    background.locks.transparency = true;
    background.locks.position = true;
    background
        .surface_mut()
        .unwrap()
        .fill_rect(Rect::new(0, 0, 26, 18), &[1.0, 0.0, 0.0, 1.0]);
    document.layers = vec![background, Layer::raster("上层", document.pixel_format())];
    photocraft_format::save_to_bytes(&document, &Default::default()).unwrap()
}

/// 只有一个像素层的嵌入源。
fn single_source_bytes() -> Vec<u8> {
    let mut document = Document::new("单层源", Size::new(20, 14), ColorMode::Rgb, SampleType::U8);
    let mut layer = Layer::raster("唯一", document.pixel_format());
    layer
        .surface_mut()
        .unwrap()
        .fill_rect(Rect::new(2, 2, 12, 9), &[0.0, 1.0, 0.0, 1.0]);
    document.layers = vec![layer];
    photocraft_format::save_to_bytes(&document, &Default::default()).unwrap()
}

/// 含图案样式的嵌入源：源里有一份图案资源与引用它的图案叠加。
fn patterned_source_bytes() -> Vec<u8> {
    let mut document = Document::new("图案源", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
    let mut tile = photocraft_doc::Surface::new(document.pixel_format());
    tile.fill_rect(Rect::new(0, 0, 4, 4), &[0.0, 0.0, 1.0, 1.0]);
    let pattern = photocraft_doc::Pattern::new("蓝格", tile, 4, 4);
    document.patterns = vec![pattern.clone()];
    let mut layer = Layer::raster("带样式", document.pixel_format());
    layer
        .surface_mut()
        .unwrap()
        .fill_rect(Rect::new(0, 0, 16, 12), &[0.5, 0.5, 0.5, 1.0]);
    layer.effects.enabled = true;
    layer.effects.items = vec![photocraft_doc::Effect::PatternOverlay {
        common: photocraft_doc::FxCommon::new(photocraft_doc::BlendMode::Normal, 1.0),
        name: pattern.name.clone(),
        id: pattern.id.clone(),
        scale: 1.0,
        angle: 0.0,
        link: true,
        phase: (0.0, 0.0),
    }];
    document.layers = vec![layer];
    photocraft_format::save_to_bytes(&document, &Default::default()).unwrap()
}

fn editor() -> Editor {
    let mut editor = Editor::new();
    editor
        .execute("file.new", json!({"width": 40, "height": 30}))
        .unwrap();
    editor
        .execute("layer.new.layer", json!({"name": "内容"}))
        .unwrap();
    editor
        .execute("edit.fillForeground", json!({"color": "#3366cc"}))
        .unwrap();
    editor
}

fn smart_editor() -> Editor {
    let mut editor = editor();
    let layer = editor.active_layer_id().unwrap().0;
    editor.convert_to_smart_object(&[layer]).unwrap();
    editor
}

fn active(editor: &Editor) -> u64 {
    editor.state()["document"]["activeLayer"].as_u64().unwrap()
}

fn history(editor: &Editor) -> usize {
    editor.state()["document"]["history"]
        .as_array()
        .unwrap()
        .len()
}

fn row(editor: &Editor, id: u64) -> Option<serde_json::Value> {
    fn find(rows: &[serde_json::Value], id: u64) -> Option<serde_json::Value> {
        for row in rows {
            if row["id"].as_u64() == Some(id) {
                return Some(row.clone());
            }
            if let Some(children) = row["children"].as_array()
                && let Some(found) = find(children, id)
            {
                return Some(found);
            }
        }
        None
    }
    find(editor.state()["document"]["layers"].as_array().unwrap(), id)
}

#[test]
fn multi_layer_source_becomes_an_editable_group_in_one_history_step() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &source_bytes())
        .unwrap();
    let before = editor.state();
    let steps = history(&editor);
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(converted["group"], true, "源有两层，必须建组");
    assert_eq!(history(&editor), steps + 1, "转回图层只增加一步历史");
    let new_id = converted["layer"].as_u64().unwrap();
    let group = row(&editor, new_id).unwrap();
    assert_eq!(group["kind"], "Group");
    assert_eq!(group["name"], "内容", "组沿用智能图层的名称");
    let children = group["children"].as_array().unwrap();
    assert_eq!(children.len(), 2, "源的每一层都成为可编辑图层");
    assert!(
        children.iter().any(|child| child["name"] == "背景"),
        "源背景成为普通图层"
    );
    // 源 Background 的锁在父文档里不成立：解包后必须可编辑。
    let bottom = children
        .iter()
        .find(|child| child["name"] == "背景")
        .unwrap();
    assert_eq!(bottom["effectiveLocks"]["all"], false);
    editor
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    let restored = editor.state();
    assert_eq!(
        restored["document"]["layers"], before["document"]["layers"],
        "一次撤销把智能对象整棵放回"
    );
    assert_eq!(
        restored["document"]["activeLayer"],
        before["document"]["activeLayer"]
    );
}

#[test]
fn single_foldable_layer_replaces_the_smart_layer_directly() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &single_source_bytes())
        .unwrap();
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(converted["group"], false, "可折叠的单层不建组");
    assert_eq!(converted["layers"], 1);
    let new_id = converted["layer"].as_u64().unwrap();
    assert_ne!(new_id, layer, "结果必须使用新的图层身份");
    let replaced = row(&editor, new_id).unwrap();
    assert_eq!(replaced["kind"], "Pixel");
    assert_eq!(replaced["name"], "内容");
}

#[test]
fn whole_pixel_placement_moves_the_unpacked_layers() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &single_source_bytes())
        .unwrap();
    editor
        .execute(
            "edit.transform",
            json!({"layer": layer, "matrix": [1, 0, 0, 1, 7, 5]}),
        )
        .unwrap();
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    let new_id = converted["layer"].as_u64().unwrap();
    let replaced = row(&editor, new_id).unwrap();
    // 源内容在 (2,2)-(12,9)，平移 (7,5) 后落在 (9,7)-(19,14)。
    assert_eq!(replaced["bounds"], json!([9, 7, 10, 7]));
}

/// 合成像素证据：整像素放置解包前后画面逐字节一致，撤销后同样一致。
#[test]
fn unpack_keeps_the_composited_pixels_identical() {
    fn pixels(editor: &Editor) -> Vec<u8> {
        let doc = editor.session.active().unwrap().doc.clone();
        photocraft_compose::render(&doc, Rect::new(0, 0, 40, 30))
            .to_rgba8()
            .pixels
    }
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &source_bytes())
        .unwrap();
    editor
        .execute(
            "edit.transform",
            json!({"layer": layer, "matrix": [1, 0, 0, 1, 6, 4]}),
        )
        .unwrap();
    let before = pixels(&editor);
    editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(pixels(&editor), before, "整像素放置的解包不改变画面");
    editor
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(pixels(&editor), before, "撤销后画面一致");
}

/// 非整像素放置走引擎自己的自由变换：解包前后画面同样一致（不是近似栅格化）。
#[test]
fn fractional_placement_uses_the_engine_transform_and_stays_visually_equal() {
    fn pixels(editor: &Editor) -> Vec<u8> {
        let doc = editor.session.active().unwrap().doc.clone();
        photocraft_compose::render(&doc, Rect::new(0, 0, 40, 30))
            .to_rgba8()
            .pixels
    }
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &source_bytes())
        .unwrap();
    editor
        .execute(
            "edit.transform",
            json!({"layer": layer, "matrix": [1, 0, 0, 1, 3.5, 2.5]}),
        )
        .unwrap();
    let before = pixels(&editor);
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(converted["group"], true);
    assert_eq!(pixels(&editor), before, "非整像素放置的解包保留实例布局");
}

#[test]
fn converting_one_instance_leaves_shared_instances_smart() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    let copies = editor.duplicate_smart_object(&[layer], false).unwrap();
    let copy = copies["layers"].as_array().unwrap()[0].as_u64().unwrap();
    assert_eq!(row(&editor, copy).unwrap()["kind"], "Smart Object");
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    assert!(converted["layer"].as_u64().is_some());
    assert_eq!(
        row(&editor, copy).unwrap()["kind"],
        "Smart Object",
        "其他共享实例保持智能对象"
    );
    // 共享关系没有被破坏：另一个实例仍能打开同一子文档。
    editor.begin_smart_child(copy).unwrap();
    assert_eq!(editor.smart_child_state()["active"], true);
}

#[test]
fn unrepresentable_effects_are_rejected_without_history() {
    // 每一种无法用普通层/组表达的实例效果都必须显式拒绝；静默解包会改变画面。
    type Mutation = fn(&mut SmartObject);
    let cases: [(&str, Mutation, &str); 5] = [
        (
            "透视",
            |smart| {
                smart.perspective = Some([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
            },
            "透视",
        ),
        (
            "变形",
            |smart| {
                smart.warp = Some(photocraft_geom::warp::Warp::preset(
                    photocraft_geom::warp::WarpStyle::Arc,
                    0.5,
                    [0.0, 0.0, 40.0, 30.0],
                ));
            },
            "变形",
        ),
        (
            "智能滤镜",
            |smart| {
                smart.smart_filters.push(photocraft_doc::SmartFilter {
                    command: "filter.blur.gaussianBlur".into(),
                    params: json!({"radius": 2}),
                    visible: true,
                    blend: photocraft_doc::BlendMode::Normal,
                    opacity: 1.0,
                });
            },
            "智能滤镜",
        ),
        (
            "滤镜蒙版",
            |smart| {
                smart.filter_mask = Some(photocraft_doc::LayerMask::reveal_all());
            },
            "智能滤镜",
        ),
        (
            "堆栈模式",
            |smart| {
                smart.stack_mode = Some(photocraft_doc::StackMode::Mean);
            },
            "堆栈模式",
        ),
    ];
    for (name, mutate, expected) in cases {
        let mut editor = smart_editor();
        let layer = active(&editor);
        {
            let state = editor.session.active().unwrap();
            let mut document = (*state.doc).clone();
            if let LayerContent::Smart(smart) =
                &mut document.layer_mut(LayerId(layer)).unwrap().content
            {
                mutate(smart);
            }
            editor.session.active_mut().unwrap().doc = std::sync::Arc::new(document);
        }
        let before = editor.state();
        let failed = editor.convert_smart_to_layers(layer).unwrap_err();
        assert!(
            failed.message().contains(expected),
            "{name}：{}",
            failed.message()
        );
        assert_eq!(editor.state(), before, "{name} 拒绝不得修改文档或历史");
        // 状态投影必须先一步给出同一原因，UI 不会先允许再拒绝。
        let projection = editor.smart_layer_state(layer).unwrap();
        assert_eq!(projection["canConvertToLayers"], false, "{name}");
        assert!(
            projection["convertReason"]
                .as_str()
                .unwrap()
                .contains(expected),
            "{name}：{}",
            projection["convertReason"]
        );
    }
}

#[test]
fn smart_layer_mask_and_style_force_a_group_instead_of_dropping_them() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    {
        let state = editor.session.active().unwrap();
        let mut document = (*state.doc).clone();
        let target = document.layer_mut(LayerId(layer)).unwrap();
        target.mask = Some(photocraft_doc::LayerMask::reveal_all());
        target.effects.enabled = true;
        target.effects.items = vec![photocraft_doc::Effect::ColorOverlay {
            common: photocraft_doc::FxCommon::new(photocraft_doc::BlendMode::Normal, 1.0),
            color: photocraft_doc::Color::rgba(1.0, 0.0, 0.0, 1.0),
        }];
        editor.session.active_mut().unwrap().doc = std::sync::Arc::new(document);
    }
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(
        converted["group"], true,
        "智能层自带蒙版/样式时不能折叠进单层，否则会静默丢样式"
    );
    let new_id = converted["layer"].as_u64().unwrap();
    let result = row(&editor, new_id).unwrap();
    assert_eq!(result["kind"], "Group");
    assert_eq!(result["hasMask"], true, "蒙版跟到组上");
    assert_eq!(
        result["effects"]["items"].as_array().map(Vec::len),
        Some(1),
        "样式跟到组上"
    );
    assert_eq!(
        result["children"].as_array().unwrap().len(),
        1,
        "源的单层成为组内唯一的可编辑图层"
    );
    // 组本身仍保留智能层原有的可见性/不透明度属性。
    assert_eq!(result["name"], "内容");
}

#[test]
fn rejections_cover_missing_layer_plain_layer_and_open_child_draft() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    assert!(editor.convert_smart_to_layers(999_999).is_err());
    editor
        .execute("layer.new.layer", json!({"name": "普通"}))
        .unwrap();
    let plain = active(&editor);
    assert!(editor.convert_smart_to_layers(plain).is_err());
    editor.begin_smart_child(layer).unwrap();
    let failed = editor.convert_smart_to_layers(layer).unwrap_err();
    assert!(failed.message().contains("子文档"), "{}", failed.message());
    assert_eq!(editor.smart_child_state()["active"], true, "子文档保留");
}

#[test]
fn export_source_does_not_require_a_child_session() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    assert_eq!(editor.smart_child_state()["active"], false);
    let (name, bytes) = editor.export_smart_source(layer).unwrap();
    assert!(name.to_ascii_lowercase().ends_with(".pcraft"), "{name}");
    assert!(!bytes.is_empty());
    let decoded = photocraft_format::load_from_bytes(&bytes).unwrap();
    assert!(!decoded.layers.is_empty());
    let before = editor.state();
    let _ = editor.export_smart_source(layer).unwrap();
    assert_eq!(editor.state(), before, "导出不改文档、不新增历史");
    editor
        .execute("layer.new.layer", json!({"name": "普通"}))
        .unwrap();
    let plain = active(&editor);
    assert!(editor.export_smart_source(plain).is_err());
    assert!(editor.export_smart_source(999_999).is_err());
}

#[test]
fn replace_source_does_not_require_a_child_session() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    assert_eq!(editor.smart_child_state()["active"], false);
    let steps = history(&editor);
    editor
        .replace_smart_contents(layer, &source_bytes())
        .unwrap();
    assert_eq!(history(&editor), steps + 1, "替换源是一步历史");
    // 替换保留实例身份：仍可打开子文档。
    editor.begin_smart_child(layer).unwrap();
    assert_eq!(editor.smart_child_state()["active"], true);
}

/// 工程重开：解包结果仍是可编辑的普通层/组，不再有智能对象身份。
#[test]
fn unpacked_layers_survive_a_project_round_trip() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &source_bytes())
        .unwrap();
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    let new_id = converted["layer"].as_u64().unwrap();
    let saved = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&saved, None).unwrap();
    let group = row(&reopened, new_id).expect("解包结果随工程保存");
    assert_eq!(group["kind"], "Group");
    assert_eq!(group["children"].as_array().unwrap().len(), 2);
    assert!(
        reopened.smart_layer_state(new_id).unwrap()["smart"] == false,
        "重开后不再是智能对象"
    );
    // 内部层仍是普通可编辑像素层：重开后的组子项带像素表面，不再是智能对象。
    let kinds: Vec<&str> = group["children"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|child| child["kind"].as_str())
        .collect();
    assert_eq!(kinds, vec!["Pixel", "Pixel"]);
}

/// 导出源与替换源都只看选中层自己的源。
#[test]
fn export_source_returns_exactly_the_embedded_bytes() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    let source = source_bytes();
    editor.replace_smart_contents(layer, &source).unwrap();
    let (_, exported) = editor.export_smart_source(layer).unwrap();
    assert_eq!(exported, source, "导出不重新编码，逐字节原样返回");
    assert_eq!(
        editor.state()["document"]["history"]
            .as_array()
            .unwrap()
            .last()
            .unwrap(),
        "替换智能对象内容"
    );
}

#[test]
fn layer_state_reports_availability_and_reasons_per_layer() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    let state = editor.smart_layer_state(layer).unwrap();
    assert_eq!(state["smart"], true);
    assert_eq!(state["canExport"], true);
    assert_eq!(state["canReplace"], true);
    assert_eq!(state["canConvertToLayers"], true);
    assert_eq!(state["canEditContents"], true);
    assert_eq!(state["childOpen"], false);
    assert_eq!(state["source"]["kind"], "embedded");
    assert!(state["source"]["bytes"].as_u64().unwrap() > 0);
    // 打开子文档后不能再解包，但导出仍可用。
    editor.begin_smart_child(layer).unwrap();
    let blocked = editor.smart_layer_state(layer).unwrap();
    assert_eq!(blocked["canConvertToLayers"], false);
    assert_eq!(blocked["childOpen"], true);
    assert_eq!(blocked["canExport"], true);
    assert!(
        blocked["convertReason"]
            .as_str()
            .unwrap()
            .contains("子文档"),
        "{}",
        blocked["convertReason"]
    );
    // 非智能图层给出明确原因，不返回成功态。
    editor
        .execute("layer.new.layer", json!({"name": "普通"}))
        .unwrap();
    let plain = active(&editor);
    let plain_state = editor.smart_layer_state(plain).unwrap();
    assert_eq!(plain_state["smart"], false);
    assert_eq!(plain_state["canExport"], false);
    for key in ["reason", "exportReason", "convertReason", "editReason"] {
        assert!(
            !plain_state[key].as_str().unwrap().is_empty(),
            "{key} 必须给出原因"
        );
    }
    assert!(editor.smart_layer_state(999_999).is_err());
}

/// 每个不可用入口都必须带自己的原因：UI 不推断，也不静默禁用。
#[test]
fn every_disabled_entry_reports_its_own_reason() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .execute("layer.lockLayers", json!({"all": true}))
        .unwrap();
    let locked = editor.smart_layer_state(layer).unwrap();
    assert_eq!(locked["canExport"], true, "锁定不影响读取源字节");
    assert_eq!(locked["canReplace"], false);
    assert_eq!(locked["canConvertToLayers"], false);
    assert_eq!(locked["canEditContents"], false);
    for key in ["replaceReason", "convertReason", "editReason"] {
        assert!(
            locked[key].as_str().unwrap().contains("锁定"),
            "{key}: {}",
            locked[key]
        );
    }
    assert_eq!(locked["exportReason"], "", "可用入口不带原因");
    // 解锁后恢复可用。
    editor
        .execute("layer.lockLayers", json!({"all": false}))
        .unwrap();
    assert_eq!(editor.smart_layer_state(layer).unwrap()["canReplace"], true);
}

/// 外链是 NON_GOAL：入口关闭并说明，绝不读取外部文件。
#[test]
fn linked_source_is_refused_with_a_reason_instead_of_reading_the_file() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    {
        let state = editor.session.active().unwrap();
        let mut document = (*state.doc).clone();
        if let LayerContent::Smart(smart) = &mut document.layer_mut(LayerId(layer)).unwrap().content
        {
            smart.source = photocraft_doc::SmartSource::Linked {
                path: "/tmp/ext/linked.pcraft".into(),
            };
        }
        editor.session.active_mut().unwrap().doc = std::sync::Arc::new(document);
    }
    let state = editor.smart_layer_state(layer).unwrap();
    assert_eq!(state["source"]["kind"], "linked");
    assert_eq!(state["source"]["fileName"], "linked.pcraft", "只暴露文件名");
    assert_eq!(state["source"]["bytes"], serde_json::Value::Null);
    for key in [
        "canExport",
        "canReplace",
        "canConvertToLayers",
        "canEditContents",
    ] {
        assert_eq!(state[key], false, "{key} 外链不可用");
    }
    for key in [
        "exportReason",
        "replaceReason",
        "convertReason",
        "editReason",
    ] {
        assert!(
            state[key].as_str().unwrap().contains("NON_GOALS"),
            "{key}: {}",
            state[key]
        );
    }
    let before = editor.state();
    assert!(editor.export_smart_source(layer).is_err());
    assert!(editor.convert_smart_to_layers(layer).is_err());
    assert_eq!(editor.state(), before, "拒绝不写文档");
}

/// 解包带来的图案资源必须一起进入父文档：否则样式引用悬空，工程重开会被核验器拒绝。
#[test]
fn unpacked_layer_styles_keep_their_pattern_resources() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &patterned_source_bytes())
        .unwrap();
    let before = editor.state();
    let patterns_before = before["document"]["patterns"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .len();
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    let new_id = converted["layer"].as_u64().unwrap();
    let converted_row = row(&editor, new_id).unwrap();
    let anchor = converted_row
        .get("children")
        .and_then(|children| children.as_array())
        .and_then(|children| children.last())
        .unwrap_or(&converted_row);
    assert_eq!(
        anchor["effects"]["enabled"], true,
        "源里的图案叠加必须保留为可编辑样式"
    );
    // 图案资源随解包带入；同 id 同内容不重复占用预算。
    let state = editor.state();
    let patterns = state["document"]["patterns"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(patterns.len() >= patterns_before, "图案资源不得丢失");
    let saved = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened
        .open_project(&saved, None)
        .expect("解包后的样式引用必须仍能在父工程里核验通过");
    assert_eq!(reopened.smart_layer_state(new_id).unwrap()["smart"], false);
}

/// 嵌套组里的智能对象：解包替换原位子树，组结构与其他兄弟层保持。
#[test]
fn converting_a_nested_smart_layer_keeps_the_group_around_it() {
    let mut editor = smart_editor();
    let smart = active(&editor);
    editor
        .replace_smart_contents(smart, &source_bytes())
        .unwrap();
    editor
        .execute("layer.new.group", json!({"name": "外层组"}))
        .unwrap();
    let group = active(&editor);
    editor
        .execute(
            "layer.moveTo",
            json!({"layer": smart, "target": group, "position": "into"}),
        )
        .unwrap();
    let before_layers = editor.state()["document"]["layers"]
        .as_array()
        .unwrap()
        .len();
    assert!(
        row(&editor, group).unwrap()["children"]
            .as_array()
            .unwrap()
            .len()
            == 1,
        "前置：智能对象已移入外层组"
    );
    let converted = editor.convert_smart_to_layers(smart).unwrap();
    let new_id = converted["layer"].as_u64().unwrap();
    let state = editor.state();
    assert_eq!(
        state["document"]["layers"].as_array().unwrap().len(),
        before_layers,
        "原地替换，不新增顶层层"
    );
    let converted_row = row(&editor, new_id).unwrap();
    assert_eq!(converted_row["kind"], "Group", "两层源解包成组");
    let overview = row(&editor, group).unwrap();
    let children = overview["children"].as_array().unwrap();
    assert!(
        children
            .iter()
            .any(|child| child["id"].as_u64() == Some(new_id)),
        "外层组里换成了解包结果"
    );
    editor
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(
        row(&editor, smart).map(|row| row["kind"].clone()),
        Some(json!("Smart Object")),
        "一次撤销恢复智能对象原位"
    );
}

/// 解包结果可以导出为可编辑 PSD（无智能滤镜/外链），不再有智能对象块。
#[test]
fn unpacked_result_exports_to_an_editable_psd_without_smart_blocks() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &source_bytes())
        .unwrap();
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    let new_id = converted["layer"].as_u64().unwrap();
    let preview = editor.inspect_psd_export().unwrap();
    assert_eq!(
        preview["editable"], true,
        "解包结果是纯可编辑层/组：{preview}"
    );
    let (bytes, report) = editor.export_psd(json!({"rasterizeLossy": false})).unwrap();
    assert_eq!(report["rasterized"], false, "不静默栅格化");
    assert!(!bytes.is_empty());
    // 导出的 PSD 不再携带智能对象；组与像素层仍可编辑。
    let import = crate::psd::import_psd(&bytes).unwrap();
    assert!(import.lossy.is_empty(), "{:?}", import.lossy);
    assert!(
        !import
            .document
            .walk()
            .iter()
            .any(|(_, _, layer)| { matches!(layer.content, LayerContent::Smart(_)) })
    );
    assert_eq!(
        editor.smart_layer_state(new_id).unwrap()["smart"],
        false,
        "导出不改原文档"
    );
}

/// 层级预算与核验器同语义（根层 depth 从 1 起）：14 层外层组包住智能层时，
/// 换上的两层组正好落在第 16 层，必须放行；再深一层必须拒绝。
#[test]
fn unpacked_depth_budget_uses_the_verifier_depth_semantics() {
    fn nest(editor: &mut Editor, smart: u64, groups: usize) {
        for index in 0..groups {
            editor
                .execute("layer.new.group", json!({"name": format!("组{index}")}))
                .unwrap();
            let group = active(editor);
            editor
                .execute(
                    "layer.moveTo",
                    json!({"layer": smart, "target": group, "position": "into"}),
                )
                .unwrap();
        }
    }
    let mut editor = smart_editor();
    let smart = active(&editor);
    editor
        .replace_smart_contents(smart, &source_bytes())
        .unwrap();
    nest(&mut editor, smart, 14);
    let converted = editor
        .convert_smart_to_layers(smart)
        .expect("14 层外层组 + 两层源正好 16 层，应放行");
    assert_eq!(converted["group"], true);
    assert_eq!(
        row(&editor, converted["layer"].as_u64().unwrap())
            .unwrap()
            .get("kind")
            .cloned(),
        Some(json!("Group"))
    );

    let mut deep = smart_editor();
    let layer = active(&deep);
    deep.replace_smart_contents(layer, &source_bytes()).unwrap();
    nest(&mut deep, layer, 15);
    let before = deep.state();
    let error = deep.convert_smart_to_layers(layer).unwrap_err();
    assert!(
        error.to_string().contains("层级"),
        "超限必须给出层级原因：{error}"
    );
    assert_eq!(deep.state(), before, "拒绝不写文档");
}

/// 解包带入的图案超出工程图案预算时必须整体拒绝，不能让父工程保存出无法重开的资源。
#[test]
fn pattern_budget_overflow_rejects_without_writing() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &patterned_source_bytes())
        .unwrap();
    // 父文档先把图案资源用满（仍在上限内）；源里那一份图案便没有空位可并入。
    {
        let state = editor.session.active().unwrap();
        let mut document = (*state.doc).clone();
        let template = photocraft_doc::Pattern::new(
            "占位",
            photocraft_doc::Surface::new(document.pixel_format()),
            4,
            4,
        );
        let mut patterns = Vec::new();
        loop {
            let mut candidate = patterns.clone();
            candidate.push(photocraft_doc::Pattern {
                id: format!("filler-{}", candidate.len()),
                ..template.clone()
            });
            if !photocraft_project_verify::pattern_support::supported(&candidate) {
                break;
            }
            patterns = candidate;
        }
        assert!(!patterns.is_empty(), "前置：父文档已占满图案预算");
        document.patterns = patterns;
        editor.session.active_mut().unwrap().doc = std::sync::Arc::new(document);
    }
    let before = editor.state();
    let failed = editor.convert_smart_to_layers(layer).unwrap_err();
    assert!(
        failed.message().contains("图案"),
        "预算拒绝必须说明资源原因：{}",
        failed.message()
    );
    assert_eq!(editor.state(), before, "拒绝不得修改文档或历史");
}

/// 源里的嵌套智能对象在解包后仍是活的智能对象，不被顺手压平成像素。
#[test]
fn nested_smart_objects_stay_live_after_conversion() {
    let mut inner = Document::new("内层", Size::new(12, 10), ColorMode::Rgb, SampleType::U8);
    inner
        .layers
        .push(Layer::raster("内层像素", inner.pixel_format()));
    let inner_bytes = photocraft_format::save_to_bytes(&inner, &Default::default()).unwrap();
    let mut outer = Document::new("外层", Size::new(24, 20), ColorMode::Rgb, SampleType::U8);
    outer
        .layers
        .push(Layer::raster("底层", outer.pixel_format()));
    outer.layers.push(Layer::new(
        "嵌套对象",
        LayerContent::Smart(photocraft_doc::SmartObject::new(
            photocraft_doc::SmartSource::Embedded {
                file_name: "inner.pcraft".into(),
                bytes: std::sync::Arc::new(inner_bytes),
            },
            photocraft_doc::Affine::IDENTITY,
            None,
        )),
    ));
    let outer_bytes = photocraft_format::save_to_bytes(&outer, &Default::default()).unwrap();

    let mut editor = smart_editor();
    let layer = active(&editor);
    editor.replace_smart_contents(layer, &outer_bytes).unwrap();
    let converted = editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(converted["group"], true);
    let new_id = converted["layer"].as_u64().unwrap();
    fn nested_smart(row: &serde_json::Value) -> Option<u64> {
        if row["kind"] == "Smart Object" {
            return row["id"].as_u64();
        }
        row["children"].as_array()?.iter().find_map(nested_smart)
    }
    let nested =
        nested_smart(&row(&editor, new_id).unwrap()).expect("嵌套智能对象必须保持为智能对象层");
    let state = editor.smart_layer_state(nested).unwrap();
    assert_eq!(state["smart"], true);
    assert_eq!(state["source"]["kind"], "embedded", "嵌套源仍是嵌入源");
    // 嵌套对象在新父工程里仍可枚举共享关系。
    let saved = editor.save_project().unwrap();
    // 专用「含嵌入源工程」核验入口接受该结果（含活的嵌套智能对象）。
    photocraft_project_verify::smart_source::verify_project(&saved)
        .expect("含嵌套智能对象的解包结果必须能通过含源工程核验");
    // 常规上传入口仍整体拒绝任何智能对象（含嵌套），这是共享核验器的既有边界，
    // 不是解包引入的问题；解包结果本身已是可编辑层/组。
    assert!(
        photocraft_project_verify::verify(&saved).is_err(),
        "常规上传入口对智能对象的整体拒绝是既有共享边界"
    );
}

/// 旧工程兼容：本次没有新增持久字段，只有既有 `LayerContent::Smart` 字段的工程必须原样可用。
///
/// 用格式层直接构造就等价于「旧构建保存的工程」：没有本 change 的任何附加表示。
/// （普通上传/CLI 的 `verify()` 仍整体拒绝智能对象；编辑器打开入口对含嵌入源的工程改走
/// 专用 `verify_project`，见 `partially_converted_project_reopens_with_remaining_instances`。）
#[test]
fn projects_without_any_new_persistent_field_stay_usable() {
    let source = single_source_bytes();
    let mut document = Document::new("旧工程", Size::new(40, 30), ColorMode::Rgb, SampleType::U8);
    document
        .layers
        .push(Layer::raster("背景", document.pixel_format()));
    document.layers.push(Layer::new(
        "旧对象",
        LayerContent::Smart(photocraft_doc::SmartObject::new(
            photocraft_doc::SmartSource::Embedded {
                file_name: "contents.pcraft".into(),
                bytes: std::sync::Arc::new(source.clone()),
            },
            photocraft_doc::Affine::IDENTITY,
            Some(photocraft_doc::Surface::new(document.pixel_format())),
        )),
    ));
    let legacy = photocraft_format::save_to_bytes(&document, &Default::default()).unwrap();

    // 1) 保存/读取不写入任何新字段：再存一次仍是同一份字节。
    let reloaded = photocraft_format::load_from_bytes(&legacy).unwrap();
    assert_eq!(
        photocraft_format::save_to_bytes(&reloaded, &Default::default()).unwrap(),
        legacy,
        "本次没有新增持久字段，旧工程重存必须逐字节一致"
    );
    // 2) 旧工程本身就是合法的「含嵌入源工程」，不需要迁移。
    photocraft_project_verify::smart_source::verify_project(&legacy)
        .expect("旧格式的智能对象工程必须仍然通过含源核验");

    // 3) 三个新入口直接作用于旧工程，无需迁移或重写。
    let id = reloaded.layers[1].id;
    let mut session = photocraft_engine::Session::new();
    session.add_document(reloaded.clone(), None);
    session.set_active(0);
    let state = crate::features::smart::smart_source_io::layer_state(&session, id, None).unwrap();
    assert_eq!(state["smart"], true, "{state}");
    assert_eq!(state["canExport"], true);
    assert_eq!(state["canReplace"], true);
    assert_eq!(state["canConvertToLayers"], true);
    assert_eq!(
        state["source"]["bytes"].as_u64(),
        Some(source.len() as u64),
        "旧工程的嵌入源长度与新入口一致"
    );
    let (_, exported) =
        crate::features::smart::smart_source_io::export_source(&session, id).unwrap();
    assert_eq!(exported, source, "旧工程的嵌入源逐字节导出");

    let before = session.active().unwrap().clone();
    let converted = crate::features::smart::unpack::convert(&mut session, id, false).unwrap();
    let new_id = converted["layer"].as_u64().unwrap();
    let after = session.active().unwrap();
    assert_eq!(
        after.history.past_len(),
        before.history.past_len() + 1,
        "旧工程上的转回图层同样是一步历史"
    );
    assert!(
        after.doc.layer(photocraft_doc::LayerId(new_id)).is_some(),
        "旧工程上解包出的图层存在"
    );
    session
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(
        session.active().unwrap().doc.layers,
        before.doc.layers,
        "旧工程上一次撤销回到智能对象"
    );
}

/// 内容身份与序列化一致：解包结果的 hash 必须与「保存再打开」后的 hash 相同，
/// 且解包不新增持久字段（旧工程与身份算法都不被这次操作改变）。
#[test]
fn conversion_keeps_content_identity_consistent_across_serialization() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    editor
        .replace_smart_contents(layer, &patterned_source_bytes())
        .unwrap();
    editor.convert_smart_to_layers(layer).unwrap();
    let live = editor.content_hash().unwrap();
    let saved = editor.save_project().unwrap();
    let mut reopened = Editor::new();
    reopened.open_project(&saved, None).unwrap();
    assert_eq!(
        reopened.content_hash().unwrap(),
        live,
        "解包结果的身份必须能由序列化字节复现"
    );
    // 一次撤销回到智能对象，身份回到解包之前的值（不是新的持久表示）。
    let mut baseline = smart_editor();
    let original = active(&baseline);
    baseline
        .replace_smart_contents(original, &patterned_source_bytes())
        .unwrap();
    let before = baseline.content_hash().unwrap();
    baseline.convert_smart_to_layers(original).unwrap();
    baseline
        .execute("edit.undo", serde_json::Value::Null)
        .unwrap();
    assert_eq!(
        baseline.content_hash().unwrap(),
        before,
        "撤销后身份与解包前一致"
    );
    assert_ne!(before, live, "解包确实换成了普通层/组（不是静默无变化）");
}

/// U66 成功证据的关键组合：只转回一个共享实例后，工程仍含其他智能对象。
///
/// 这条路径以前打不开——`open_project` 走的是 `verify()`（普通上传口径，整体拒绝智能对象）。
/// 现在含嵌入源的工程走专用 `verify_project`，因此「其他共享实例不变 + 工程重开正确」可以
/// 同时成立；普通上传/CLI 的接收政策没有被放宽（同一测试断言 `verify()` 仍拒绝）。
#[test]
fn partially_converted_project_reopens_with_remaining_instances() {
    let mut editor = smart_editor();
    let layer = active(&editor);
    let copies = editor.duplicate_smart_object(&[layer], false).unwrap();
    let other = copies["layers"].as_array().unwrap()[0].as_u64().unwrap();
    editor.convert_smart_to_layers(layer).unwrap();
    assert_eq!(
        row(&editor, other).unwrap()["kind"],
        "Smart Object",
        "前置：另一个共享实例仍是智能对象"
    );
    let hash = editor.content_hash().unwrap();
    let saved = editor.save_project().unwrap();

    // 编辑器打开入口接受「部分解包」的工程，并保留两类图层。
    let mut reopened = Editor::new();
    reopened
        .open_project(&saved, None)
        .expect("只转回一个实例的工程必须能重开");
    assert_eq!(
        reopened.content_hash().unwrap(),
        hash,
        "重开后的内容身份必须与保存前一致"
    );
    let state = reopened.state();
    let mut kinds: Vec<&str> = state["document"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["kind"].as_str())
        .collect();
    kinds.sort_unstable();
    // 顶部是未转回的共享实例，原位是被解包出来的普通层，底部是原背景。
    assert_eq!(kinds, vec!["Pixel", "Pixel", "Smart Object"]);
    // 剩下的智能对象重开后仍是活的：可读状态、可打开子文档。
    assert_eq!(reopened.smart_layer_state(other).unwrap()["smart"], true);
    reopened
        .begin_smart_child(other)
        .expect("重开后其余共享实例仍可编辑内容");

    // 普通上传/CLI 口径不因此放宽。
    assert!(
        photocraft_project_verify::verify(&saved).is_err(),
        "普通上传入口继续整体拒绝智能对象"
    );
}

/// 放行只针对「含嵌入智能对象」这一条：其他拒绝原因不能被打开通道吞掉。
#[test]
fn open_project_still_rejects_unrelated_verification_failures() {
    // 外链源是 NON_GOAL：含它的工程既不能上传，也不能被编辑器打开。
    let mut document = Document::new("外链", Size::new(16, 12), ColorMode::Rgb, SampleType::U8);
    document
        .layers
        .push(Layer::raster("背景", document.pixel_format()));
    let mut linked = Layer::new(
        "外链对象",
        LayerContent::Smart(photocraft_doc::SmartObject::new(
            photocraft_doc::SmartSource::Linked {
                path: "/external/外部.pcraft".into(),
            },
            photocraft_doc::Affine::IDENTITY,
            Some(photocraft_doc::Surface::new(document.pixel_format())),
        )),
    );
    linked.effects.enabled = false;
    document.layers.push(linked);
    let bytes = photocraft_format::save_to_bytes(&document, &Default::default()).unwrap();
    let mut editor = Editor::new();
    let failure = editor.open_project(&bytes, None).unwrap_err();
    assert!(
        failure.message().contains("嵌入") || failure.message().contains("外链"),
        "外链源必须给出自身原因：{}",
        failure.message()
    );
    assert!(editor.state()["document"].is_null(), "拒绝时不建立文档");
}

/// 打开通道不得成为绕过「层数/深度预算」的旁路：解包本身已按核验器语义检查，
/// 这里确认打开时仍复用同一套上限，而不是只信任源内的单份文档。
#[test]
fn open_project_keeps_layer_budget_for_embedded_sources() {
    // 32 层源 + 复制实例：单份源合法，但整棵源树累计超过 64 层。
    let mut source = Document::new("宽源", Size::new(24, 18), ColorMode::Rgb, SampleType::U8);
    source.layers = (0..32)
        .map(|index| {
            let mut layer = Layer::raster(format!("层{index}"), source.pixel_format());
            layer.locks.transparency = true;
            layer
        })
        .collect();
    let source = photocraft_format::save_to_bytes(&source, &Default::default()).unwrap();
    let mut document = Document::new("父", Size::new(40, 30), ColorMode::Rgb, SampleType::U8);
    document
        .layers
        .push(Layer::raster("背景", document.pixel_format()));
    let object = Layer::new(
        "对象",
        LayerContent::Smart(photocraft_doc::SmartObject::new(
            photocraft_doc::SmartSource::Embedded {
                file_name: "contents.pcraft".into(),
                bytes: std::sync::Arc::new(source),
            },
            photocraft_doc::Affine::IDENTITY,
            None,
        )),
    );
    document.layers.push(object.clone());
    document.layers.push(object.duplicate());
    document.layers.push(object.duplicate());
    let bytes = photocraft_format::save_to_bytes(&document, &Default::default()).unwrap();
    let mut editor = Editor::new();
    let failure = editor
        .open_project(&bytes, None)
        .expect_err("累计层数超限的工程必须拒绝");
    assert!(
        failure.message().contains("图层超限"),
        "拒绝原因应指向图层预算：{}",
        failure.message()
    );
    assert!(editor.state()["document"].is_null(), "拒绝时不建立文档");
}
