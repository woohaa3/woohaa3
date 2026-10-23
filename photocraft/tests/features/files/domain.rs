//! 本域（U01–U04）原生回归：不依赖浏览器、WASM 或 GPU。
//!
//! 覆盖 spec 的特有拒绝条件与实际结果语义：
//! - U01：尺寸/分辨率/背景生效、可绘画、保存重开一致；非法尺寸、非 RGB 模式、第二个文档被拒；
//! - U02：图片字节建文档、损坏字节不留半成品；整份复制自包含且与原文互不影响；
//! - U03：恢复保留文档身份与标签名、净变化清零、一步可撤销、非工程字节拒绝；
//! - U04：File Info 有界且一步撤销、预设/最近设置校验与簿记不进文档内容。
use crate::capability::command_allowed;
use crate::error::EditorError;
use crate::Editor;
use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
use serde_json::{json, Value};

fn sample_png(width: u32, height: u32) -> Vec<u8> {
    let doc = Document::with_background(
        "sample",
        Size { width, height },
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default())
        .expect("export sample png")
        .bytes
}

fn created_editor(params: Value) -> Editor {
    let mut editor = Editor::new();
    editor.create_document(params).expect("create document");
    editor
}

fn recent_settings(editor: &mut Editor) -> Vec<Value> {
    editor.recent_documents().expect("recent documents")["recent"]
        .as_array()
        .expect("recent list")
        .clone()
}

// ---------------------------------------------------------------- U01 新建

#[test]
fn new_blank_document_reports_actual_size_dpi_and_background() {
    let mut editor = Editor::new();
    let report = editor
        .create_document(json!({
            "width": 640,
            "height": 480,
            "resolution": 300,
            "background": "transparent",
            "name": "  海报  ",
        }))
        .expect("create document");

    assert_eq!(report["width"], 640);
    assert_eq!(report["height"], 480);
    assert_eq!(report["resolution"], 300.0);
    assert_eq!(report["mode"], "rgb");
    assert_eq!(report["depth"], 8);
    assert_eq!(report["background"], "transparent");
    assert_eq!(report["name"], "海报", "文档名去空白后落库");
    assert_eq!(report["recentRecorded"], true);
    // 返回的是内核真实状态，不是界面回填的期望值。
    assert_eq!(report["state"]["document"]["width"], 640);
    assert_eq!(report["state"]["document"]["height"], 480);
    assert_eq!(report["state"]["document"]["resolution"], 300.0);

    let state = editor.state();
    assert_eq!(state["document"]["width"], 640);
    assert_eq!(state["document"]["height"], 480);
    assert_eq!(state["document"]["mode"], "Rgb");
    assert_eq!(state["document"]["depth"], 8);
    assert_eq!(state["document"]["resolution"], 300.0);
    assert_eq!(state["document"]["name"], "海报");
    assert_eq!(state["session"]["documents"][0]["dirty"], false, "新建即基线");
}

#[test]
fn new_document_is_paintable_and_reopens_from_project_bytes() {
    let mut editor = created_editor(json!({"width": 48, "height": 32, "background": "#3366cc"}));
    editor
        .execute(
            "paint.stroke",
            json!({"points":[[4,5],[10,9]],"size":3,"hardness":1,"opacity":1,"flow":1,"color":"#ff0000","target":"pixels"}),
        )
        .expect("paint on new document");
    let painted = editor.content_hash().expect("content hash");

    let bytes = editor.save_project().expect("save project");
    assert!(photocraft_format::is_pcraft(&bytes));

    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).expect("reopen project");
    assert_eq!(reopened.state()["document"]["width"], 48);
    assert_eq!(reopened.state()["document"]["height"], 32);
    assert_eq!(reopened.content_hash().expect("hash"), painted, "保存重开保持内容身份");
}

#[test]
fn invalid_size_mode_depth_and_extra_keys_are_refused_without_creating_a_document() {
    for (params, needle) in [
        (json!({"width": 0, "height": 10}), "至少为 1"),
        (json!({"width": 10}), "缺少 `height`"),
        (json!({"width": 9000, "height": 10}), "单边上限"),
        (json!({"width": 10, "height": 8193}), "单边上限"),
        (json!({"width": 10, "height": 10, "resolution": 0}), "resolution"),
        (json!({"width": 10, "height": 10, "mode": "cmyk"}), "RGB"),
        (json!({"width": 10, "height": 10, "depth": 16}), "8 位"),
        (json!({"width": 10, "height": 10, "background": "mauve"}), "background"),
        (json!({"width": 10, "height": 10, "colour": "#fff"}), "未知的参数"),
        (json!({"width": "wide", "height": 10}), "必须是有限数值"),
    ] {
        let mut editor = Editor::new();
        let error = editor.create_document(params).expect_err("must be refused");
        assert!(
            error.message().contains(needle),
            "拒绝原因应包含 {needle}，实际：{}",
            error.message()
        );
        assert!(!editor.has_document(), "失败不得留下半成品文档");
        assert_eq!(editor.state()["session"]["documents"].as_array().unwrap().len(), 0);
    }
}

#[test]
fn a_second_document_in_the_same_session_is_refused_and_keeps_the_first() {
    let mut editor = created_editor(json!({"width": 16, "height": 16, "name": "原文档"}));
    let before = editor.state();
    let hash = editor.content_hash().expect("hash");

    for error in [
        editor.create_document(json!({"width": 8, "height": 8})).expect_err("second document"),
        editor
            .create_document_from_image("粘贴", &sample_png(8, 8))
            .expect_err("second document from image"),
    ] {
        assert!(error.message().contains("独立文档槽位"), "{}", error.message());
    }
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().expect("hash"), hash);
}

#[test]
fn document_name_and_background_defaults_are_stable() {
    let report = Editor::new()
        .create_document(json!({"width": 8, "height": 8}))
        .expect("defaults");
    assert_eq!(report["name"], "未命名");
    assert_eq!(report["resolution"], 72.0);
    assert_eq!(report["background"], "white");
    // 空字符串与纯空白同样落到默认名，不产生空标签。
    assert_eq!(
        Editor::new()
            .create_document(json!({"width": 8, "height": 8, "name": "   "}))
            .expect("blank name")["name"],
        "未命名"
    );
}

// ------------------------------------------------------- U02 图片来源与复制

#[test]
fn image_bytes_create_a_document_at_the_real_decoded_size() {
    let mut editor = Editor::new();
    let report = editor
        .create_document_from_image("  剪贴板  ", &sample_png(40, 24))
        .expect("create from image");
    assert_eq!(report["width"], 40);
    assert_eq!(report["height"], 24);
    assert_eq!(report["name"], "剪贴板");
    assert_eq!(report["source"], "image-bytes");
    assert_eq!(editor.state()["document"]["width"], 40);

    let unnamed = Editor::new()
        .create_document_from_image("", &sample_png(12, 9))
        .expect("default name");
    assert_eq!(unnamed["name"], "剪贴板图像");
}

/// 文件选择器的 `accept` 列表必须与本 WASM 真正能解码的格式一致。
///
/// 面板列出 png/jpeg/webp/tiff/bmp/gif；这里逐个用真实编码器产出字节再交给内核解码，
/// 证明「能选到」就等于「能建文档」——否则用户选了 JPEG 只会得到一次失败。
#[test]
fn document_from_image_decodes_every_format_the_picker_offers() {
    let doc = Document::with_background(
        "sample",
        Size { width: 21, height: 13 },
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.3, 0.5, 0.7),
    );
    for (extension, expected) in [
        ("png", (21u64, 13u64)),
        ("jpg", (21, 13)),
        ("webp", (21, 13)),
        ("tiff", (21, 13)),
        ("bmp", (21, 13)),
        ("gif", (21, 13)),
    ] {
        let bytes = photocraft_io::export(&doc, extension, &photocraft_io::ExportOptions::default())
            .unwrap_or_else(|error| panic!("export {extension}: {error}"))
            .bytes;
        let report = Editor::new()
            .create_document_from_image("pick", &bytes)
            .unwrap_or_else(|error| panic!("decode {extension}: {}", error.message()));
        assert_eq!(
            (report["width"].as_u64().unwrap(), report["height"].as_u64().unwrap()),
            expected,
            "{extension} 应解码为编码时的尺寸"
        );
    }
}

#[test]
fn corrupt_image_bytes_are_refused_and_leave_an_empty_session() {
    let mut editor = Editor::new();
    let error = editor
        .create_document_from_image("bad.png", b"not an image")
        .expect_err("corrupt bytes");
    assert_eq!(error.code(), "import-failed");
    assert!(!editor.has_document(), "解码失败不得留下半成品文档");

    // 失败后同一候选实例仍可用于合法输入（错误恢复不需要重建标签）。
    editor
        .create_document_from_image("ok.png", &sample_png(8, 8))
        .expect("retry after failure");
    assert_eq!(editor.state()["document"]["width"], 8);
}

#[test]
fn duplicate_is_self_contained_and_independent_of_the_source() {
    let mut editor = created_editor(json!({"width": 32, "height": 24, "name": "原件"}));
    editor.execute("layer.new.group", json!({"name": "组"})).expect("group");
    editor.execute("layer.new.layer", json!({"name": "素材"})).expect("layer");
    editor.execute("edit.fillForeground", json!({"color": "#3366cc"})).expect("fill");
    // spec 的成功证据点名「含组/蒙版文档」：必须真的覆盖蒙版，不能只测到组。
    editor
        .execute("layer.layerMask.revealAll", json!({}))
        .expect("add layer mask");
    let masked = editor.state()["document"]["layers"]
        .as_array()
        .unwrap()
        .iter()
        .any(|layer| !layer["maskEnabled"].is_null());
    assert!(masked, "测试前提：文档确实带了图层蒙版");
    editor.execute("layer.select", json!({"layer": editor.state()["document"]["layers"][0]["id"]})).expect("select layer");
    editor.execute("layer.duplicate", json!({})).ok();
    let hash = editor.content_hash().expect("hash");
    let revision = editor.revision().expect("revision");
    let dirty = editor.state()["session"]["documents"][0]["dirty"].clone();
    let layers = editor.state()["document"]["layers"].as_array().unwrap().len();

    let bytes = editor.duplicate_document_bytes(None).expect("duplicate bytes");
    assert!(photocraft_format::is_pcraft(&bytes));

    // 复制不推进原文档的修订/基线，也不改变其内容身份与未保存状态。
    assert_eq!(editor.revision().expect("revision"), revision);
    assert_eq!(editor.content_hash().expect("hash"), hash);
    assert_eq!(editor.state()["session"]["documents"][0]["dirty"], dirty);

    let mut copy = Editor::new();
    copy.open_project(&bytes, None).expect("open duplicate");
    assert_eq!(copy.state()["document"]["width"], 32);
    assert_eq!(
        copy.state()["document"]["layers"].as_array().unwrap().len(),
        layers,
        "复制保留规范层树"
    );
    // 蒙版属于「规范层树/资源」，必须随副本一起走，不能只剩一个空图层。
    let copy_layers = copy.state()["document"]["layers"].as_array().unwrap().clone();
    assert!(
        copy_layers.iter().any(|layer| layer["maskEnabled"] == true && layer["hasMask"] == true),
        "副本必须保留图层蒙版"
    );
    assert_eq!(copy.state()["document"]["name"], "原件 副本");

    // 副本里的修改不回写原文：两边各自独立。
    copy.execute("edit.fillForeground", json!({"color": "#ff0000"})).expect("edit copy");
    assert_eq!(editor.content_hash().expect("hash"), hash, "原文内容不变");
    assert_ne!(copy.content_hash().expect("hash"), hash, "副本确实被修改");

    // 关闭原文后副本仍可用（字节是快照，不引用原文状态）。
    editor.close();
    assert!(!editor.has_document());
    assert_eq!(copy.state()["document"]["width"], 32);
}

#[test]
fn duplicate_accepts_an_explicit_name_and_rejects_overlong_ones() {
    let editor = created_editor(json!({"width": 8, "height": 8, "name": "原件"}));
    let bytes = editor.duplicate_document_bytes(Some("  另存名称  ")).expect("duplicate");
    let mut copy = Editor::new();
    copy.open_project(&bytes, None).expect("open");
    assert_eq!(copy.state()["document"]["name"], "另存名称");

    let overlong = "名".repeat(256);
    let error = editor.duplicate_document_bytes(Some(&overlong)).expect_err("overlong name");
    assert!(error.message().contains("255"), "{}", error.message());

    let empty = Editor::new();
    assert_eq!(
        empty.duplicate_document_bytes(None).expect_err("no document").code(),
        "no-document"
    );
}

// ------------------------------------------------------------ U03 恢复与关闭

#[test]
fn restore_uses_the_declared_baseline_and_keeps_document_identity() {
    let mut editor = created_editor(json!({"width": 24, "height": 18, "name": "工作稿"}));
    editor.execute("edit.fillForeground", json!({"color": "#112233"})).expect("first paint");
    let baseline = editor.save_project().expect("baseline bytes");
    let baseline_hash = editor.content_hash().expect("hash");
    let document_id = editor.state()["document"]["layers"][0]["id"].clone();

    editor.execute("edit.fillForeground", json!({"color": "#ff0000"})).expect("second paint");
    let dirty = editor.state();
    assert_eq!(dirty["session"]["documents"][0]["dirty"], true);
    let changed_hash = editor.content_hash().expect("hash");
    assert_ne!(changed_hash, baseline_hash);

    let restored = editor
        .restore_saved_baseline(&baseline, None)
        .expect("restore baseline");
    assert_eq!(restored["restored"], true);
    assert_eq!(restored["width"], 24);
    assert_eq!(restored["height"], 18);
    assert_eq!(restored["documentContentHash"], baseline_hash);

    let state = editor.state();
    assert_eq!(state["document"]["name"], "工作稿", "标签名保持");
    assert_eq!(state["document"]["layers"][0]["id"], document_id, "文档身份保持");
    assert_eq!(state["session"]["documents"][0]["dirty"], false, "恢复后净变化清零");

    // 恢复是一步可撤销的编辑步骤：撤销回到恢复前的内容。
    editor.undo().expect("undo restore");
    assert_eq!(editor.content_hash().expect("hash"), changed_hash);
    editor.redo().expect("redo restore");
    assert_eq!(editor.content_hash().expect("hash"), baseline_hash);
}

#[test]
fn restore_refuses_non_project_bytes_and_keeps_the_current_document() {
    let mut editor = created_editor(json!({"width": 16, "height": 16}));
    editor.execute("edit.fillForeground", json!({"color": "#445566"})).expect("paint");
    let before = editor.state();
    let hash = editor.content_hash().expect("hash");

    assert_eq!(
        editor.restore_saved_baseline(b"not a project", None).expect_err("refuse").code(),
        "not-a-project"
    );
    // 损坏的工程容器也拒绝，且不改变现场。
    let mut corrupt = editor.save_project().expect("project");
    corrupt.truncate(corrupt.len() / 2);
    assert_eq!(
        editor.restore_saved_baseline(&corrupt, None).expect_err("corrupt").code(),
        "load-failed"
    );
    assert_eq!(editor.state(), before);
    assert_eq!(editor.content_hash().expect("hash"), hash);

    let mut empty = Editor::new();
    assert_eq!(
        empty
            .restore_saved_baseline(&sample_png(4, 4), None)
            .expect_err("no document")
            .code(),
        "no-document"
    );
}

// -------------------------------------------------------------- U04 元数据

#[test]
fn file_info_round_trips_known_fields_and_is_one_undo_step() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let written = editor
        .file_info(json!({
            "title": "封面",
            "author": "摄影组",
            "authorTitle": "编辑",
            "description": "用于首页",
            "keywords": ["海报", "样张"],
            "copyright": "© 2026",
            "copyrightStatus": "copyrighted",
            "copyrightUrl": "https://example.com/license",
        }))
        .expect("write file info");
    assert_eq!(written["title"], "封面");
    assert_eq!(written["keywords"], json!(["海报", "样张"]));
    assert_eq!(written["copyrightStatus"], "copyrighted");

    // 只读查询（无写入字段）不新增历史步骤。
    let history = editor.state()["document"]["history"].clone();
    let read = editor.file_info(Value::Null).expect("read file info");
    assert_eq!(read["title"], "封面");
    assert_eq!(editor.state()["document"]["history"], history);

    editor.undo().expect("undo file info");
    let after_undo = editor.file_info(json!({})).expect("read after undo");
    assert_eq!(after_undo["title"], "", "撤销回到无元数据状态");

    editor.redo().expect("redo file info");
    assert_eq!(editor.file_info(Value::Null).expect("read")["title"], "封面");
}

#[test]
fn file_info_refuses_unknown_or_oversized_fields_without_writing() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let history = editor.state()["document"]["history"].clone();
    for (params, needle) in [
        (json!({"titel": "拼错"}), "未知的 File Info 字段"),
        (json!({"title": "x".repeat(4097)}), "不能超过 4096"),
        (json!({"keywords": "不是数组"}), "字符串数组"),
        (json!({"keywords": (0..257).map(|i| format!("k{i}")).collect::<Vec<_>>()}), "最多 256"),
        (json!({"copyrightStatus": "maybe"}), "copyrightStatus"),
        (json!({"title": "含\0空字符"}), "不能超过"),
        (json!({"title": 42}), "必须是字符串"),
    ] {
        let error = editor.file_info(params).expect_err("must be refused");
        assert!(
            error.message().contains(needle),
            "拒绝原因应包含 {needle}，实际：{}",
            error.message()
        );
        assert_eq!(editor.state()["document"]["history"], history, "拒绝不得新增历史");
    }
    assert_eq!(editor.file_info(Value::Null).expect("read")["title"], "");
}

/// 元数据是可保存内容但**不属于内容身份**：写入后 `dirty` 变 true，内容指纹不变。
///
/// 两件事必须分开：内容指纹回答「像素/结构变了吗」，`dirty` 回答「有没有未保存的东西」。
/// 若用指纹驱动 `dirty`，改个标题就会显示为「已保存」，用户关掉窗口就丢掉版权信息。
#[test]
fn file_info_marks_dirty_without_changing_content_identity() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let hash = editor.content_hash().expect("hash");
    editor.file_info(json!({"title": "只改元数据"})).expect("write");
    assert_eq!(editor.content_hash().expect("hash"), hash, "元数据不属于内容身份");
    // 元数据是可保存的内容，属于未保存变化；但内容指纹不变，作者标签不会变成像素差异。
    assert_eq!(editor.state()["session"]["documents"][0]["dirty"], true);
}

/// 界面把所有字段（含未修改的空串）一起提交：空串必须**清空**字段而不是被当成「未提供」。
///
/// 这是 U04「元数据保存/导出按格式支持矩阵保留或报告损失」的前提：如果清空无效，用户删掉的
/// 版权信息仍会被写进导出文件，界面却显示已清空。
#[test]
fn file_info_blank_values_clear_the_field() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    editor
        .file_info(json!({"title": "封面", "copyright": "© 2026", "keywords": ["a", "b"]}))
        .expect("write");
    let written = editor.file_info(Value::Null).expect("read");
    assert_eq!(written["title"], "封面");
    assert_eq!(written["copyright"], "© 2026");
    assert_eq!(written["keywords"], json!(["a", "b"]));

    // 与面板一致：提交整张表，被清空的字段是空串 / 空数组。
    let cleared = editor
        .file_info(json!({
            "title": "", "author": "", "authorTitle": "", "description": "",
            "keywords": [], "copyright": "", "copyrightStatus": "unknown", "copyrightUrl": "",
        }))
        .expect("clear");
    assert_eq!(cleared["title"], "");
    assert_eq!(cleared["copyright"], "");
    assert_eq!(cleared["keywords"], json!([]));
    assert_eq!(cleared["copyrightStatus"], "unknown");

    // 清空是真实写入：再读仍然为空，且撤销能恢复原值。
    let reread = editor.file_info(Value::Null).expect("read after clear");
    assert_eq!(reread["title"], "");
    assert_eq!(reread["keywords"], json!([]));
    editor.undo().expect("undo clear");
    assert_eq!(
        editor.file_info(Value::Null).expect("read after undo")["title"],
        "封面",
        "清空是一步可撤销的编辑"
    );
}

// ------------------------------------------------- U04 预设与最近设置

/// **无变化不新增历史**：重复提交同一份 File Info 不得压入空历史步。
///
/// 上游 `file.fileInfo` 只要收到任一已知键就无条件 `session.edit("File Info", …)`，
/// 连写两次相同值时历史会变成 `["Open", "File Info", "File Info"]`，撤销两次才回到初始态。
/// 本域的包装在写前比较可观察字段，完全一致时降级为只读查询。
#[test]
fn repeated_file_info_write_without_changes_adds_no_history() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let params = json!({"title": "封面", "author": "摄影组"});
    editor.file_info(params.clone()).expect("first write");
    let history_after_first = editor.state()["document"]["history"].clone();
    let hash_after_first = editor.content_hash().expect("hash");

    // 第一次写入后是一步可撤销的编辑。
    assert!(editor.state()["document"]["canUndo"].as_bool().unwrap_or(false));

    // 重复提交完全相同的内容：不新增历史，也不改内容身份。
    let again = editor.file_info(params.clone()).expect("repeat write");
    assert_eq!(again["title"], "封面");
    assert_eq!(
        editor.state()["document"]["history"],
        history_after_first,
        "无变化的 File Info 提交不得压入新历史"
    );
    assert_eq!(editor.content_hash().expect("hash"), hash_after_first);

    // 只撤销一次就回到写入前的初始态（若多压了一步空历史，这里会仍停在「封面」）。
    editor.undo().expect("undo");
    assert_eq!(
        editor.file_info(Value::Null).expect("read")["title"],
        "",
        "只能有一步历史：撤销一次必须回到未写入状态"
    );

    // 真正改变内容时仍然是一步新历史。
    editor.redo().expect("redo");
    editor
        .file_info(json!({"title": "封面（改）"}))
        .expect("real change");
    assert_eq!(editor.file_info(Value::Null).expect("read")["title"], "封面（改）");
    editor.undo().expect("undo change");
    assert_eq!(editor.file_info(Value::Null).expect("read")["title"], "封面");
}

// ------------------------------------------------- U04 预设与最近设置
/// File Info 是**可保存内容**：写入后保存工程并重开，已知字段必须原样回来。
///
/// 这是 U04「预设重载保持参数，最近项重开真实字节，元数据保存/导出按格式支持矩阵保留或报告
/// 损失」里「保存」那一半的证据。此前只有内存内往返测试，没有跨保存/重开验证。
#[test]
fn file_info_survives_project_save_reopen_and_duplicate() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    editor
        .file_info(json!({
            "title": "封面", "author": "摄影组", "copyright": "© 2026",
            "keywords": ["海报", "样张"],
        }))
        .expect("write file info");
    let hash = editor.content_hash().expect("hash");

    // 保存 → 重开：字段与工程字节都完整。
    let bytes = editor.save_project().expect("save project");
    let mut reopened = Editor::new();
    reopened.open_project(&bytes, None).expect("reopen project");
    let info = reopened.file_info(Value::Null).expect("read reopened");
    assert_eq!(info["title"], "封面");
    assert_eq!(info["author"], "摄影组");
    assert_eq!(info["copyright"], "© 2026");
    assert_eq!(info["keywords"], json!(["海报", "样张"]));
    // 元数据不改变内容身份：重开后的指纹与写入后一致（元数据走 metadata，不进像素树）。
    assert_eq!(
        reopened.content_hash().expect("hash"),
        editor.content_hash().expect("hash"),
        "元数据不得改变内容身份"
    );
    assert_eq!(editor.content_hash().expect("hash"), hash);

    // 整份复制同样带上元数据（副本是自包含工程字节）。
    let duplicate = editor.duplicate_document_bytes(None).expect("duplicate");
    let mut copy = Editor::new();
    copy.open_project(&duplicate, None).expect("open duplicate");
    assert_eq!(
        copy.file_info(Value::Null).expect("read copy")["title"],
        "封面",
        "副本必须保留 File Info"
    );
}

/// 按格式保留/损失矩阵必须与**真实编码器行为**一致，而不是只声明在文档里。
///
/// `FILE_INFO_FORMAT_SUPPORT` 声明 pcraft/png/jpeg/webp/tiff 保留 File Info、OpenRaster 丢弃。
/// 这里用真实导出 + 真实导入验证前三个平面格式与工程格式，并确认 OpenRaster 确实丢，
/// 保证界面提示与落盘结果不会互相矛盾。
#[test]
fn file_info_retention_matches_the_declared_matrix() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    editor
        .file_info(json!({"title": "封面", "author": "摄影组"}))
        .expect("write file info");

    // 矩阵声明保留的平坦格式：导出后重新打开必须还能读到标题。
    for extension in ["png", "jpeg", "webp", "tiff"] {
        let bytes = {
            let doc = &editor.active_doc().expect("document").doc;
            photocraft_io::export(doc, extension, &photocraft_io::ExportOptions::default())
                .unwrap_or_else(|error| panic!("export {extension}: {error}"))
                .bytes
        };
        let mut reopened = Editor::new();
        reopened
            .open_image("roundtrip", None, &bytes)
            .unwrap_or_else(|error| panic!("reimport {extension}: {}", error.message()));
        assert_eq!(
            reopened.file_info(Value::Null).expect("read")["title"],
            "封面",
            "{extension} 按矩阵应保留 File Info"
        );
    }

    // 矩阵声明 OpenRaster 不保存元数据：必须真的丢，界面才能据此提示损失。
    let ora = {
        let doc = &editor.active_doc().expect("document").doc;
        photocraft_io::export(doc, "ora", &photocraft_io::ExportOptions::default())
            .expect("export ora")
            .bytes
    };
    let mut reopened = Editor::new();
    reopened.open_image("roundtrip", None, &ora).expect("reimport ora");
    assert_eq!(
        reopened.file_info(Value::Null).expect("read")["title"],
        "",
        "OpenRaster 按矩阵不保存 File Info，界面必须提示损失"
    );
}

#[test]
fn document_presets_save_list_and_delete_without_touching_the_document() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let hash = editor.content_hash().expect("hash");
    let revision = editor.revision().expect("revision");

    let saved = editor
        .document_presets(
            "save",
            json!({
                "name": "  方形海报  ",
                "settings": {"width": 1080, "height": 1080, "resolution": 300, "background": "transparent"},
            }),
        )
        .expect("save preset");
    assert_eq!(saved["preset"]["name"], "方形海报");
    assert_eq!(saved["preset"]["settings"]["width"], 1080);
    assert_eq!(saved["preset"]["settings"]["resolution"], 300.0);

    let list = editor.document_presets("list", Value::Null).expect("list");
    assert_eq!(list["presets"].as_array().unwrap().len(), 1);
    assert_eq!(list["presets"][0]["name"], "方形海报");

    // 同名重复保存被拒，已有预设保持不变。
    let duplicate = editor
        .document_presets(
            "save",
            json!({"name": "方形海报", "settings": {"width": 10, "height": 10}}),
        )
        .expect_err("duplicate name");
    assert!(
        duplicate.message().contains("already exists"),
        "{}",
        duplicate.message()
    );
    assert_eq!(
        editor.document_presets("list", Value::Null).expect("list")["presets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let deleted = editor
        .document_presets("delete", json!({"name": "方形海报"}))
        .expect("delete");
    assert_eq!(deleted["deleted"], "方形海报");
    assert_eq!(
        editor.document_presets("list", Value::Null).expect("list")["presets"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // 预设是本机簿记：文档内容、修订与指针状态都不受影响。
    assert_eq!(editor.content_hash().expect("hash"), hash);
    assert_eq!(editor.revision().expect("revision"), revision);
    assert_eq!(editor.state()["session"]["documents"][0]["dirty"], false);
}

#[test]
fn document_presets_refuse_settings_the_runtime_cannot_reopen() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    for (params, needle) in [
        (json!({"name": "", "settings": {"width": 10, "height": 10}}), "1–255"),
        (json!({"name": "   ", "settings": {"width": 10, "height": 10}}), "1–255"),
        (json!({"name": "名".repeat(256), "settings": {"width": 10, "height": 10}}), "1–255"),
        (json!({"name": "无设置"}), "缺少 `settings`"),
        (json!({"name": "设置非对象", "settings": "1080×1080"}), "必须是对象"),
        (json!({"name": "缺宽", "settings": {"height": 10}}), "缺少 `width`"),
        (json!({"name": "超大", "settings": {"width": 9000, "height": 10}}), "单边上限"),
        (json!({"name": "非 RGB", "settings": {"width": 10, "height": 10, "mode": "lab"}}), "RGB"),
        (json!({"name": "16 位", "settings": {"width": 10, "height": 10, "depth": 16}}), "8 位"),
        (json!({"name": "坏背景", "settings": {"width": 10, "height": 10, "background": "mauve"}}), "background"),
        (json!({"name": "未知键", "settings": {"width": 10, "height": 10, "bleed": 3}}), "未知的参数"),
    ] {
        let error = editor
            .document_presets("save", params)
            .expect_err("must be refused");
        assert!(
            error.message().contains(needle),
            "拒绝原因应包含 {needle}，实际：{}",
            error.message()
        );
    }
    for params in [json!({"name": ""}), json!({})] {
        let error = editor
            .document_presets("delete", params)
            .expect_err("must be refused");
        assert!(
            error.message().contains("1–255") || error.message().contains("缺少 `name`"),
            "{}",
            error.message()
        );
    }
    // 不存在的预设名由引擎拒绝，界面据此提示「预设已被删除」。
    let missing = editor
        .document_presets("delete", json!({"name": "从未保存"}))
        .expect_err("unknown preset");
    assert!(
        missing.message().contains("No such document preset"),
        "{}",
        missing.message()
    );
    assert_eq!(
        editor.document_presets("list", Value::Null).expect("list")["presets"],
        json!([])
    );
}

#[test]
fn unknown_preset_action_is_refused_with_a_stable_code() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let error = editor
        .document_presets("rename", Value::Null)
        .expect_err("unknown action");
    assert_eq!(error.code(), "command-failed");
    assert!(error.message().contains("未知的预设操作"));
}

#[test]
fn recent_settings_are_newest_first_deduplicated_and_bounded() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    // 新建自动记录一次。
    let recent = recent_settings(&mut editor);
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0]["width"], 8);
    assert_eq!(recent[0]["mode"], "rgb");
    assert_eq!(recent[0]["depth"], 8);
    assert_eq!(recent[0]["background"], "white");

    // 重复设置折叠到最前，不新增条目。
    editor
        .record_recent_document(json!({"width": 8, "height": 8}))
        .expect("record duplicate");
    assert_eq!(recent_settings(&mut editor).len(), 1);

    editor
        .record_recent_document(json!({"width": 64, "height": 32, "resolution": 150}))
        .expect("record new");
    let recent = recent_settings(&mut editor);
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0]["width"], 64, "最新在前");
    assert_eq!(recent[1]["width"], 8);

    // 超过 20 条时丢弃最旧，且始终最新在前。
    for width in 100..140 {
        editor
            .record_recent_document(json!({"width": width, "height": 10}))
            .expect("record");
    }
    let recent = recent_settings(&mut editor);
    assert_eq!(recent.len(), 20);
    assert_eq!(recent[0]["width"], 139);
    assert!(recent.iter().all(|entry| entry["width"].as_u64().unwrap() >= 120));

    // 最近设置是簿记：不写文档内容，也不制造未保存变化。
    assert_eq!(editor.state()["session"]["documents"][0]["dirty"], false);
}

/// 界面（`presetParams` / `recentSettingsParams`）真实发送的设置形状必须一次通过内核。
///
/// 回归背景：`DocumentSettings` 只接受设置字段，`name` 属于预设名（外层）。早期实现把新建参数
/// （含 `name`）直接当作预设/最近设置发送，内核以「未知的参数 `name`」整体拒绝，导致「保存预设」
/// 与「最近新建」在真实 WASM 上必然失败——单测里如果替身不校验形状就发现不了。
#[test]
fn ui_shaped_preset_and_recent_settings_are_accepted_by_the_kernel() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));

    // 与 `packages/editor/src/features/files/model.ts` 的 `presetParams` 完全同形。
    let saved = editor
        .document_presets(
            "save",
            json!({
                "name": "界面形状",
                "settings": {
                    "width": 1080, "height": 1080, "resolution": 300, "mode": "rgb", "depth": 8,
                    "background": "transparent", "unit": "px", "resolutionUnit": "in",
                },
            }),
        )
        .expect("UI-shaped preset settings must pass the kernel gate");
    assert_eq!(saved["preset"]["settings"]["width"], 1080);
    assert_eq!(saved["preset"]["settings"]["resolution"], 300.0);
    assert_eq!(saved["preset"]["settings"]["background"], "transparent");
    assert!(
        saved["preset"]["settings"].get("name").is_none(),
        "预设设置里不应出现文档名"
    );

    // 与 `recentSettingsParams` 完全同形（无 `name`、无显示单位）。
    editor
        .record_recent_document(json!({
            "width": 640, "height": 480, "resolution": 72, "mode": "rgb", "depth": 8,
            "background": "white",
        }))
        .expect("UI-shaped recent settings must pass the kernel gate");
    let recent = recent_settings(&mut editor);
    assert_eq!(recent[0]["width"], 640);
    assert!(recent[0].get("name").is_none(), "最近设置里不应出现文档名");

    // 反向护栏：把文档名混进设置仍然被拒，避免将来又复用新建参数。
    for error in [
        editor
            .document_presets(
                "save",
                json!({"name": "混入名称", "settings": {"width": 10, "height": 10, "name": "x"}}),
            )
            .expect_err("name inside settings must stay rejected"),
        editor
            .record_recent_document(json!({"width": 10, "height": 10, "name": "x"}))
            .expect_err("name inside recent settings must stay rejected"),
    ] {
        assert!(
            error.message().contains("未知的参数 `name`"),
            "{}",
            error.message()
        );
    }
}

#[test]
fn recent_settings_refuse_values_outside_the_shared_limits() {
    let mut editor = created_editor(json!({"width": 8, "height": 8}));
    let before = recent_settings(&mut editor);
    for (settings, needle) in [
        (json!({"width": 0, "height": 10}), "至少为 1"),
        (json!({"width": 10, "height": 9000}), "单边上限"),
        (json!({"width": 10, "height": 10, "resolution": 99_999}), "resolution"),
        (json!({"width": 10, "height": 10, "background": "mauve"}), "background"),
        (json!({"width": 10, "height": 10, "mode": "gray"}), "RGB"),
        (json!({"width": 10}), "缺少 `height`"),
        (json!({"width": 10, "height": 10, "bleed": 1}), "未知的参数"),
        (json!("宽度 10"), "必须是对象"),
    ] {
        let error = editor
            .record_recent_document(settings)
            .expect_err("must be refused");
        assert!(
            error.message().contains(needle),
            "拒绝原因应包含 {needle}，实际：{}",
            error.message()
        );
    }
    assert_eq!(recent_settings(&mut editor), before, "拒绝不得改动最近列表");
}

// --------------------------------------------------------------- 命令门与协作

#[test]
fn new_commands_are_enabled_and_native_only_ones_stay_closed() {
    for id in [
        "file.new",
        "file.close",
        "document.presets.list",
        "document.presets.save",
        "document.presets.delete",
        "document.recent.list",
        "document.recent.add",
        "file.fileInfo",
    ] {
        assert!(command_allowed(id), "{id} 应已启用");
    }
    // 原生保存路径与整会话文档槽位未提供：这些命令保持关闭，不由本域伪造。
    for id in ["file.revert", "file.closeAll", "file.closeOthers"] {
        assert!(
            !command_allowed(id),
            "{id} 依赖缺失的宿主端口，必须保持关闭"
        );
    }
}

#[test]
fn draft_gates_block_document_creation_and_restore() {
    let mut editor = created_editor(json!({"width": 16, "height": 16}));
    let baseline = editor.save_project().expect("baseline");
    // 滤镜草稿：新建、复制与恢复都必须先结算。
    editor
        .begin_filter("filter.blur.gaussianBlur", json!({"radius": 2}))
        .expect("filter draft");
    let hash = editor.content_hash().expect("hash");

    for message in [
        editor.create_document(json!({"width": 8, "height": 8})).expect_err("draft gate"),
        editor.duplicate_document_bytes(None).expect_err("draft gate"),
        editor.restore_saved_baseline(&baseline, None).expect_err("draft gate"),
    ] {
        assert!(message.message().contains("滤镜草稿"), "{}", message.message());
    }
    assert_eq!(editor.content_hash().expect("hash"), hash, "被拒的草稿不提交半成品");

    editor.cancel_filter();
    editor.duplicate_document_bytes(None).expect("after cancel");
}

#[test]
fn failures_carry_stable_error_codes() {
    assert_eq!(EditorError::NoDocument.code(), "no-document");
    let mut editor = Editor::new();
    assert_eq!(
        editor.duplicate_document_bytes(None).expect_err("no document").code(),
        "no-document"
    );
    assert_eq!(
        editor
            .restore_saved_baseline(b"x", None)
            .expect_err("no document")
            .code(),
        "no-document"
    );
}






/// 剪贴板候选 MIME 必须与本 WASM 真正能解码的格式一致。
///
/// `clipboard.ts` 只接受这些 MIME，并声称「取到图像就一定建得出文档」。若其中某个格式
/// 内核解不了，用户复制它就会得到一次失败。这里逐个用真实编码器产出字节验证。
#[test]
fn clipboard_mime_types_are_all_decodable() {
    let doc = Document::with_background(
        "clip",
        Size { width: 15, height: 11 },
        ColorMode::Rgb,
        SampleType::U8,
        Color::rgb(0.2, 0.4, 0.6),
    );
    // 与 clipboard.ts 的 CLIPBOARD_IMAGE_TYPES 一一对应（MIME -> 编码扩展名）。
    for (mime, extension) in [
        ("image/png", "png"),
        ("image/tiff", "tiff"),
        ("image/bmp", "bmp"),
        ("image/webp", "webp"),
        ("image/jpeg", "jpg"),
        ("image/gif", "gif"),
    ] {
        let bytes = photocraft_io::export(&doc, extension, &photocraft_io::ExportOptions::default())
            .unwrap_or_else(|error| panic!("export {mime}: {error}"))
            .bytes;
        let report = Editor::new()
            .create_document_from_image("clip", &bytes)
            .unwrap_or_else(|error| panic!("decode {mime}: {}", error.message()));
        assert_eq!(report["width"], 15, "{mime} 应解码为编码时的宽度");
        assert_eq!(report["height"], 11, "{mime} 应解码为编码时的高度");
    }
}
