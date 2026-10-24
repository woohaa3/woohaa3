//! 跨域命令门的回归（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 4.4）。
//!
//! 三层断言：
//! 1. **真实文档 + 渲染像素**：门禁拒绝后不变量真的守住了（只看错误码不够）；
//! 2. **所有写入口**：`execute`、笔迹草稿、文字草稿、滤镜草稿都被覆盖；
//! 3. **跨语言一致性**：与 `packages/protocol/src/features/modes/gate-fixtures.json` 逐项一致，
//!    界面矩阵与内核拒绝不会各说一套。

use serde_json::{json, Value};

use crate::Editor;

fn fixture() -> Value {
    // CARGO_MANIFEST_DIR = rust/crates/editor-core
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/protocol/src/features/modes/gate-fixtures.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("读取 {}: {error}", path.display()));
    serde_json::from_str(&text).expect("解析 gate-fixtures.json")
}

fn open() -> Editor {
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 12, "name": "gate"})).unwrap();
    editor
}

fn fill_document(editor: &mut Editor, color: &str) {
    editor.execute("select.rect", json!({"x": 0, "y": 0, "width": 16, "height": 12, "mode": "replace"})).unwrap();
    editor.execute("edit.fillBackground", json!({"color": color})).unwrap();
    editor.execute("select.deselect", json!({})).unwrap();
}

fn indexed() -> Editor {
    let mut editor = open();
    fill_document(&mut editor, "#3366cc");
    editor.execute("image.mode.grayscale", json!({})).unwrap();
    editor.execute("image.mode.indexedColor", json!({"colors": 8, "dither": "none"})).unwrap();
    editor
}

fn bitmap() -> Editor {
    let mut editor = open();
    fill_document(&mut editor, "#3366cc");
    editor.execute("image.mode.grayscale", json!({})).unwrap();
    editor.execute("image.mode.bitmap", json!({"method": "threshold"})).unwrap();
    editor
}

fn grayscale() -> Editor {
    let mut editor = open();
    fill_document(&mut editor, "#3366cc");
    editor.execute("image.mode.grayscale", json!({})).unwrap();
    editor
}

fn duotone() -> Editor {
    let mut editor = open();
    fill_document(&mut editor, "#3366cc");
    editor.execute("image.mode.grayscale", json!({})).unwrap();
    editor.execute("image.mode.duotone", json!({"type": "monotone"})).unwrap();
    editor
}

/// 渲染后的去重颜色（用于核对不变量，而不是只看错误码）。
fn distinct_colors(editor: &Editor) -> Vec<String> {
    let preview = editor.render_preview(16).unwrap();
    let mut colors: Vec<String> = preview
        .pixels
        .chunks_exact(4)
        .map(|pixel| format!("#{:02x}{:02x}{:02x}", pixel[0], pixel[1], pixel[2]))
        .collect();
    colors.sort();
    colors.dedup();
    colors
}

fn channels(color: &str) -> [u8; 3] {
    let byte = |index: usize| u8::from_str_radix(&color[index..index + 2], 16).unwrap();
    [byte(1), byte(3), byte(5)]
}

fn stroke_params() -> Value {
    json!({
        "points": [{"x": 2, "y": 2, "pressure": 1}, {"x": 12, "y": 9, "pressure": 1}],
        "brush": {"size": 5, "hardness": 1, "opacity": 1, "flow": 1, "color": [1.0, 0.0, 1.0, 1.0]}
    })
}

fn stroke(editor: &mut Editor) -> Result<Value, crate::error::EditorError> {
    let params = stroke_params();
    editor.execute("paint.stroke", params)
}

#[test]
fn indexed_documents_reject_colour_writes_and_keep_their_palette() {
    let mut editor = indexed();
    let palette: Vec<String> = editor.mode_info().unwrap()["colorTable"]["colors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    let before = distinct_colors(&editor);
    assert!(before.iter().all(|color| palette.contains(color)), "转换后应只有表内颜色：{before:?}");

    let error = stroke(&mut editor).expect_err("索引色文档不得接受任意颜色的绘制");
    assert_eq!(error.code(), "command-failed");
    assert!(error.message().contains("索引色"), "{}", error.message());
    assert!(error.message().contains("颜色表"), "{}", error.message());

    // 真的没写进去：像素集合没有新增表外颜色。
    let after = distinct_colors(&editor);
    assert_eq!(after, before);
    assert!(after.iter().all(|color| palette.contains(color)), "绘制被拒绝后仍出现了表外颜色：{after:?}");
}

#[test]
fn bitmap_documents_reject_non_binary_writes() {
    let mut editor = bitmap();
    let before = distinct_colors(&editor);
    assert!(before.iter().all(|color| color == "#000000" || color == "#ffffff"), "{before:?}");

    let error = stroke(&mut editor).expect_err("位图文档不得接受非黑白写入");
    assert!(error.message().contains("位图"), "{}", error.message());

    let after = distinct_colors(&editor);
    assert_eq!(after, before, "被拒绝的绘制不得改变像素");
    assert!(after.iter().all(|color| color == "#000000" || color == "#ffffff"), "{after:?}");
}

#[test]
fn every_colour_writing_command_listed_by_the_contract_is_rejected() {
    // 只挡画笔是假门禁：文字、填充、路径、滤镜、调整层都写任意 RGB，必须一起拒绝。
    let contract = fixture();
    for mode in super::RESTRICTED_MODES {
        let commands: Vec<String> = contract["colourWritingCommands"][*mode]
            .as_array()
            .unwrap_or_else(|| panic!("fixture 缺少 {mode} 的命令清单"))
            .iter()
            .map(|value| value.as_str().unwrap().to_string())
            .collect();
        assert!(!commands.is_empty(), "{mode} 的命令清单不能为空");
        for command in commands {
            let (mut editor, params) = match (*mode, command.as_str()) {
                ("indexed", "paint.stroke") => (indexed(), stroke_params()),
                ("bitmap", "paint.stroke") => (bitmap(), stroke_params()),
                ("indexed", "paint.pencil") => (indexed(), stroke_params()),
                ("bitmap", "paint.pencil") => (bitmap(), stroke_params()),
                ("indexed", "paint.cloneStamp") => (indexed(), stroke_params()),
                ("bitmap", "paint.cloneStamp") => (bitmap(), stroke_params()),
                ("indexed", "paint.healingBrush") => (indexed(), stroke_params()),
                ("bitmap", "paint.healingBrush") => (bitmap(), stroke_params()),
                ("indexed", "paint.smudge") => (indexed(), stroke_params()),
                ("bitmap", "paint.smudge") => (bitmap(), stroke_params()),
                (_, "type.create") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({"x": 2, "y": 6, "text": "X", "color": "#ff00ff"})),
                (_, "edit.fillForeground") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({"color": "#ff00ff"})),
                (_, "edit.fillBackground") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({"color": "#ff00ff"})),
                (_, "path.fill") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({"color": "#ff00ff"})),
                (_, "path.stroke") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({})),
                (_, "filter.blur.gaussianBlur") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({"radius": 3})),
                (_, "image.adjustments.brightnessContrast") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({"brightness": 90})),
                (_, "layer.newAdjustmentLayer.curves") => (if *mode == "indexed" { indexed() } else { bitmap() }, json!({})),
                (_, other) => panic!("fixture 新增了未覆盖的命令：{other}"),
            };
            let before = distinct_colors(&editor);
            let error = editor
                .execute(&command, params)
                .unwrap_err_or_else(&format!("{mode} 下 {command} 应被拒绝"));
            assert!(error.message().contains(if *mode == "indexed" { "索引色" } else { "位图" }), "{command}: {}", error.message());
            assert_eq!(distinct_colors(&editor), before, "{command} 被拒绝后不得改变像素");
        }
    }
}

/// 让 `Result` 上的断言读起来更直白（避免 `expect` 的空值分支）。
trait UnwrapErrOrElse {
    fn unwrap_err_or_else(self, message: &str) -> crate::error::EditorError;
}

impl UnwrapErrOrElse for Result<Value, crate::error::EditorError> {
    fn unwrap_err_or_else(self, message: &str) -> crate::error::EditorError {
        match self {
            Err(error) => error,
            Ok(_) => panic!("{message}"),
        }
    }
}

#[test]
fn every_restricted_mode_is_listed_by_the_contract() {
    // 内核的受限模式清单与 fixture 的键必须一一对应：fixture 里少一个，界面就少一条关闭提示；
    // 多一个，界面会声明一个内核并不存在的限制。
    let contract = fixture();
    let mut listed: Vec<&str> = contract["closedByMode"].as_object().unwrap().keys().map(String::as_str).collect();
    listed.sort_unstable();
    let mut restricted = super::RESTRICTED_MODES.to_vec();
    restricted.sort_unstable();
    assert_eq!(listed, restricted, "fixture 的 closedByMode 键与 RESTRICTED_MODES 不一致");
    // 枚举值本身也要与清单同源，否则 `label()` 和常量会各自漂移。
    let mut labels: Vec<&str> = super::Restriction::all().iter().map(|restriction| restriction.label()).collect();
    labels.sort_unstable();
    assert_eq!(labels, restricted, "Restriction::all() 与 RESTRICTED_MODES 不一致");
}

#[test]
fn the_tool_contract_matches_the_kernel_gate() {
    // 界面矩阵的关闭集合必须与内核判据一一对应，否则用户会看到「可用但点了必失败」。
    let contract = fixture();
    let tools = contract["tools"].as_object().unwrap();
    for mode in super::RESTRICTED_MODES {
        let closed: Vec<&str> = contract["closedByMode"][*mode]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        // 每个关闭工具的代表命令都必须真的被内核拒绝（用一个临时文档逐条验）。
        for tool in &closed {
            let commands = tools[*tool].as_array().unwrap();
            assert!(!commands.is_empty(), "{mode}/{tool} 必须有代表命令");
        }
        // 未列入 `closedByMode` 的工具不得有任何代表命令被拒。
        for (tool, commands) in tools {
            if closed.contains(&tool.as_str()) || commands.as_array().unwrap().is_empty() {
                continue;
            }
            for command in commands.as_array().unwrap() {
                let Some(command) = command.as_str() else { continue };
                // 门禁不碰的结构性命令（如 move/marquee）没有代表命令；这里只检查有代表的。
                let params = stroke_params();
                assert!(
                    !super::writes_colour(command, &params),
                    "{mode}/{tool} 的代表命令 {command} 会被拒绝，但矩阵未关闭它"
                );
            }
        }
    }
}

#[test]
fn grayscale_and_duotone_still_accept_colour_writes() {
    // 实测：上游会把彩色写入收敛为灰阶（nonGray=0），不破坏不变量。挡掉它们是无谓的功能损失。
    for mut editor in [grayscale(), duotone()] {
        let before = distinct_colors(&editor);
        stroke(&mut editor).expect("灰度/双色调文档应接受绘制");
        let after = distinct_colors(&editor);
        assert_ne!(after, before, "绘制应当真的改变了像素");
        for color in &after {
            let [r, g, b] = channels(color);
            assert!(r == g && g == b, "灰阶/双色调只能留下灰色：{color}");
        }
    }
}

#[test]
fn rgb_documents_are_untouched_by_the_gate() {
    let mut editor = open();
    fill_document(&mut editor, "#3366cc");
    let before = distinct_colors(&editor);
    stroke(&mut editor).expect("RGB 文档必须照常绘制");
    let after = distinct_colors(&editor);
    assert_ne!(after, before, "绘制必须真的改变了像素");
    let added: Vec<&String> = after.iter().filter(|color| !before.contains(color)).collect();
    assert!(!added.is_empty(), "RGB 文档应新增颜色");
    assert!(
        added.iter().any(|color| { let [r, g, b] = channels(color); !(r == g && g == b) }),
        "RGB 文档应能写下彩色：{added:?}"
    );
}

#[test]
fn masks_and_selections_are_never_gated() {
    // 掩版与选区不引入新的 RGB 颜色：挡掉它们只会让索引色文档连蒙版都做不了。
    //
    // 断言的是「不新增表外 RGB」而不是「合成像素不变」：在蒙版上落笔本来就会让那一块变透明
    // （合成本该跟着变），而被守住的跨域不变量是**不往像素层写任意颜色**。
    for mut editor in [indexed(), bitmap()] {
        let before = distinct_colors(&editor);
        editor.execute("layer.layerMask.revealAll", json!({})).unwrap();
        editor
            .execute(
                "paint.stroke",
                json!({
                    "points": [{"x": 2, "y": 2, "pressure": 1}, {"x": 12, "y": 9, "pressure": 1}],
                    "brush": {"size": 5, "hardness": 1, "opacity": 1, "flow": 1},
                    "target": "mask"
                }),
            )
            .expect("掩版绘制必须被允许");
        editor.execute("select.rect", json!({"x": 1, "y": 1, "width": 4, "height": 4, "mode": "replace"})).unwrap();
        editor.execute("select.deselect", json!({})).unwrap();
        let after = distinct_colors(&editor);
        for color in &after {
            assert!(
                before.contains(color) || color == "#000000" || color == "#ffffff",
                "蒙版绘制写进了表外颜色：{color}（before={before:?} after={after:?}）"
            );
        }
    }
}

#[test]
fn every_write_entry_point_is_gated_not_just_execute() {
    // 笔迹、文字与滤镜草稿各有自己的预览会话；只挡 `execute` 会让用户画完/调完才失败。
    let mut editor = indexed();
    let before = distinct_colors(&editor);
    let error = editor.begin_stroke(stroke_params()).expect_err("落笔前就该拒绝");
    assert!(error.message().contains("索引色"), "{}", error.message());
    // 没有草稿：提交会报「没有正在绘制的笔迹」，而不是把一笔失败的颜色提交上去。
    let error = editor.commit_stroke().expect_err("被拒绝后不应存在待提交笔迹");
    assert!(error.message().contains("没有正在绘制的笔迹"), "{}", error.message());
    assert_eq!(distinct_colors(&editor), before);

    let error = editor
        .begin_text(json!({"x": 2, "y": 6, "text": "X", "color": "#ff00ff"}))
        .expect_err("文字草稿入口也要拒绝");
    assert!(error.message().contains("索引色"), "{}", error.message());
    // 没有草稿：继续编辑会报「没有活动文字编辑」。
    let error = editor.preview_text(json!({"text": "Y"})).expect_err("被拒绝后不应存在文字草稿");
    assert!(error.message().contains("没有活动文字编辑"), "{}", error.message());

    let error = editor
        .begin_filter("filter.blur.gaussianBlur", json!({"radius": 3}))
        .expect_err("滤镜草稿入口也要拒绝");
    assert!(error.message().contains("索引色"), "{}", error.message());
    assert_eq!(distinct_colors(&editor), before);
}

#[test]
fn the_mode_commands_themselves_are_still_allowed() {
    // 门禁不能把离开该模式的命令一起挡掉，否则文档会被永久锁死。
    let mut editor = indexed();
    editor.execute("image.mode.rgb", json!({})).expect("必须能转回 RGB");
    stroke(&mut editor).expect("转回 RGB 后必须能绘制");
}

#[test]
fn undecided_colour_models_are_not_gated() {
    // CMYK/Lab 不在本域范围：本域不判定它们的工具支持，也就不能凭空拒绝。
    let mut editor = Editor::new();
    editor.execute("file.new", json!({"width": 16, "height": 12, "mode": "cmyk"})).unwrap();
    fill_document(&mut editor, "#3366cc");
    stroke(&mut editor).expect("范围外颜色模型不由本域拒绝");
}
