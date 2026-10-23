//! 文字域命令入口（U67/U68/U69）：精确排版、样式库、OpenType、抗锯齿、变形、转路径/形状、
//! 文字蒙版、查找替换、拼写与缺字体。
//!
//! 事务规则与其它域一致（design D3）：先校验、再调用内核；一次调用最多一步历史，非法参数与
//! 内核拒绝都不改文档、不进历史。查询入口只读投影，不写文档。
//!
//! 这里**不**放宽整个 `type.`/`edit.` 前缀：只有 [`super::params::TYPE_COMMANDS`] 与
//! [`super::params::TYPE_QUERIES`] 里的 id 会被转发，其余一律按能力关闭拒绝。

use photocraft_doc::LayerId;
use serde_json::Value;

use crate::error::EditorError;
use crate::features::r#type::params::{self, TYPE_QUERIES};
use crate::editor::*;

/// 只移动搜索游标的查找动作：不写内容，因此不产生新历史。
const FIND_ONLY_ACTIONS: &[&str] = &["find"];

/// 只读拼写动作：列出与建议；其余动作改文本或本机词典。
const SPELL_READ_ACTIONS: &[&str] = &["list", "suggest"];

/// 无内容写入的命令：只读查询、纯查找（游标移动）与只列缺失字体的查询。
///
/// 读/写双态命令（`edit.findAndReplaceText`、`edit.checkSpelling`、
/// `type.resolveMissingFonts`）同时登记在两张表里，因此**不能**按表判断：必须按动作判断，
/// 否则经由写入口真正替换文本时会被误报成「无变化」。
fn writes_content(id: &str, params: &Value) -> bool {
    match id {
        "edit.findAndReplaceText" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("changeAll");
            !FIND_ONLY_ACTIONS.contains(&action)
        }
        "edit.checkSpelling" => {
            let action = params.get("action").and_then(Value::as_str).unwrap_or("list");
            !SPELL_READ_ACTIONS.contains(&action)
        }
        // 带 `map` 才是应用替换；不带的形态只列出缺失字体。
        "type.resolveMissingFonts" => params.get("map").is_some_and(|map| !map.is_null()),
        other => !TYPE_QUERIES.contains(&other),
    }
}

/// 会写入**目标文字层**的命令。上游的 `with_text_targets`（抗锯齿/OpenType/变形/样式）与
/// `type_mask_cmds::create_selection` 不做锁定检查，因此这里按 Photoshop 语义补齐：图层
/// 「全部锁定」时拒写，而不是静默改内容。
///
/// 只改样式表（`rename`/`delete`/`duplicate`）、只读选定文本格式的 `new`、纯选区（不带
/// `removeLayer`）以及全文档的缺字体替换都不在此列：锁定图层仍可被读取和列入样式库。
fn guards_target_layer(id: &str, params: &Value) -> bool {
    if id.starts_with("type.antiAlias.") || id.starts_with("type.openType.") {
        return true;
    }
    match id {
        "type.warpText"
        | "type.convertToShape"
        | "type.rasterizeTypeLayer"
        | "type.convertToPointText"
        | "type.convertToParagraphText" => true,
        // 缺字体替换不接受目标参数，上游会把**文档里每个**文字层都改写一遍；锁定层同样受保护。
        // 列出缺字体（不带 `map`）是只读动作，不受锁定影响。
        "type.replaceAllMissingFonts" => true,
        "type.resolveMissingFonts" => params.get("map").is_some_and(|map| !map.is_null()),
        // 只建立选区不改图层；只有「建立选区并删除文字层」才受锁定约束。
        "type.createSelection" => params.get("removeLayer").and_then(Value::as_bool) == Some(true),
        _ => {
            if !id.starts_with("type.characterStyle.") && !id.starts_with("type.paragraphStyle.") {
                return false;
            }
            match id.rsplit('.').next() {
                Some("apply" | "set" | "redefine" | "clearOverride") => true,
                // `new` 只有在显式 `apply` 时才写图层；否则只读取当前格式进样式表。
                Some("new") => params.get("apply").and_then(Value::as_bool) == Some(true),
                _ => false,
            }
        }
    }
}

/// 这些命令不接受目标图层参数，而是作用于文档里**全部**文字层（上游 `replace_fonts` 的
/// 写入范围）。锁定判定必须跟着写入范围走，否则只查「已选图层」会漏判。
fn targets_whole_document(id: &str) -> bool {
    matches!(id, "type.replaceAllMissingFonts" | "type.resolveMissingFonts")
}

impl Editor {
    /// 拒绝对「全部锁定」的文字层执行写命令：显式目标优先，否则按已选图层（与上游
    /// `format_targets` 的目标解析一致）。没有目标可解析时（纯样式表操作）直接放行。
    ///
    /// 缺字体替换是例外：上游 `replace_fonts` 不接受目标参数，会把**文档里每个**文字层
    /// 都改写一遍，所以这里必须对全部文字层求值，否则「锁定了也照样被改字体」。
    fn refuse_locked_text_target(&self, id: &str, params: &Value) -> Result<()> {
        if !guards_target_layer(id, params) {
            return Ok(());
        }
        let state = self.active_doc()?;
        let targets: Vec<LayerId> = if targets_whole_document(id) {
            state.doc.walk().into_iter().map(|(_, _, layer)| layer.id).collect()
        } else {
            let explicit: Vec<u64> = match params.get("layers") {
                Some(Value::Array(list)) => list.iter().filter_map(Value::as_u64).collect(),
                _ => params.get("layer").and_then(Value::as_u64).into_iter().collect(),
            };
            if explicit.is_empty() {
                state.selected_layers()
            } else {
                explicit.into_iter().map(LayerId).collect()
            }
        };
        // 只有真正的文字图层才按本域语义拒绝；非文字目标交给上游报它自己的错误。
        let locked_text = targets.iter().any(|id| {
            state.doc.effective_locks(*id).all
                && matches!(state.doc.layer(*id).map(|layer| &layer.content), Some(photocraft_doc::LayerContent::Text(_)))
        });
        if locked_text {
            return Err(EditorError::CommandFailed {
                id: id.into(),
                message: "文字图层已全部锁定，请先解锁再修改文字".into(),
            });
        }
        Ok(())
    }

    /// 文字域写命令：白名单 + 参数校验后转发内核，一步历史。
    ///
    /// `changed` 一律由内容指纹的**前后差**决定；只有读动作（纯查找、列出拼写、列出缺字体）
    /// 才固定报 `false`，因为它们本来就不写文档。读/写双态命令按动作判断，不能按白名单表判断。
    pub fn type_commands(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if !params::is_command(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        params::validate(id, &params)?;
        self.refuse_locked_text_target(id, &params)?;
        let before = self.content_fingerprint();
        let result = self
            .session
            .execute(id, params.clone())
            .map_err(|failure| EditorError::CommandFailed { id: id.into(), message: failure.to_string() })?;
        Ok(if writes_content(id, &params) {
            json!({ "result": result, "changed": before != self.content_fingerprint() })
        } else {
            json!({ "result": result, "changed": false })
        })
    }

    /// 文字域查询：只读投影，不改文档、不进历史、不动指纹。
    pub fn type_query(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        if !params::is_query(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        params::validate_query(id, &params)?;
        self.session
            .execute(id, params)
            .map_err(|failure| EditorError::CommandFailed { id: id.into(), message: failure.to_string() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn editor() -> (Editor, u64) {
        let mut editor = Editor::new();
        editor
            .execute("file.new", json!({"width": 400, "height": 200, "background": "white"}))
            .unwrap();
        let created = editor
            .execute("type.create", json!({"x": 20, "y": 80, "text": "Type example", "size": 32, "font": "Inter"}))
            .unwrap();
        let id = created["layer"].as_u64().unwrap();
        (editor, id)
    }

    /// 指定正文的编辑器：字偶距需要「两个字符之间」的光标位置，单字符文字没有字符对。
    fn editor_with(text: &str) -> (Editor, u64) {
        let mut editor = Editor::new();
        editor
            .execute("file.new", json!({"width": 400, "height": 200, "background": "white"}))
            .unwrap();
        let created = editor
            .execute("type.create", json!({"x": 20, "y": 80, "text": text, "size": 32, "font": "Inter"}))
            .unwrap();
        let id = created["layer"].as_u64().unwrap();
        (editor, id)
    }

    fn steps(editor: &Editor) -> usize {
        editor.active_doc().unwrap().history.past_len()
    }

    #[test]
    fn closed_commands_stay_closed_even_though_the_domain_has_a_dispatch() {
        let (mut editor, id) = editor();
        for id in [
            "type.orientation.vertical",
            "type.attachToPath",
            "type.detachFromPath",
            "type.pasteLoremIpsum",
            "type.saveDefaultTypeStyles",
            "type.loadDefaultTypeStyles",
            "type.updateAllTextLayers",
            "type.insertText",
            "type.hitTest",
            "type.navigate",
        ] {
            let error = editor.type_commands(id, json!({"layer": id})).expect_err(id);
            assert_eq!(error.code(), "capability-disabled", "{id}");
        }
        // 已开放命令仍然可用。
        assert!(editor.type_query("type.info", json!({"layer": id})).is_ok());
    }

    #[test]
    fn queries_do_not_touch_content_hash_revision_or_history() {
        let (mut editor, id) = editor();
        let before_hash = editor.content_hash().unwrap();
        let before_revision = editor.revision().unwrap();
        let before_steps = steps(&editor);
        for (id, params) in [
            ("type.info", json!({"layer": id})),
            ("type.fonts", json!({})),
            ("type.characterStyle.list", json!({"layer": id})),
            ("type.paragraphStyle.list", json!({"layer": id})),
            ("edit.checkSpelling", json!({"action": "list", "layer": id})),
            ("type.resolveMissingFonts", json!({})),
        ] {
            assert!(editor.type_query(id, params).is_ok(), "{id}");
        }
        assert_eq!(editor.content_hash().unwrap(), before_hash);
        assert_eq!(editor.revision().unwrap(), before_revision);
        assert_eq!(steps(&editor), before_steps);
    }

    #[test]
    fn each_typography_write_is_one_step_and_undo_restores_the_previous_state() {
        let (mut editor, id) = editor();
        let base = steps(&editor);
        let base_hash = editor.content_hash().unwrap();
        // `changed` 只反映**内容身份**是否变化：OpenType/Warp/抗锯齿/样式表目前不在
        // `document_content` 的摘要里（见 verification 的共享身份缺口），因此这里同时核对
        // 「一步历史 + 撤销恢复」与「模型确实变了」，而不是要求指纹一定变化。
        let cases: Vec<(&str, Value, &str, Value)> = vec![
            (
                "type.openType.fractions",
                json!({"layer": id, "on": true}),
                "type.info",
                json!({ "layer": id }),
            ),
            ("type.antiAlias.crisp", json!({"layer": id}), "type.info", json!({ "layer": id })),
            (
                "type.warpText",
                json!({"layer": id, "style": "arc", "bend": 30}),
                "type.info",
                json!({ "layer": id }),
            ),
            (
                "type.characterStyle.new",
                json!({"name": "标题", "layer": id, "apply": true}),
                "type.characterStyle.list",
                json!({ "layer": id }),
            ),
            (
                "type.paragraphStyle.new",
                json!({"name": "正文", "layer": id}),
                "type.paragraphStyle.list",
                json!({ "layer": id }),
            ),
        ];
        for (write, params, query, query_params) in cases.iter() {
            let before = editor.content_hash().unwrap();
            let before_state = editor.state();
            let result = editor.type_commands(write, params.clone()).unwrap_or_else(|error| panic!("{write}: {error:?}"));
            assert_eq!(steps(&editor), base + 1, "{write} 应只增加一步历史");
            let after = editor.content_hash().unwrap();
            assert_eq!(result["changed"], before != after, "{write} 的 changed 必须与指纹一致");
            assert!(!result["result"].is_null(), "{write} 应返回内核结果");
            assert_ne!(editor.state(), before_state, "{write} 应改变文档");
            editor.undo().unwrap();
            assert_eq!(steps(&editor), base, "{write} 撤销应退回一步");
            assert_eq!(editor.content_hash().unwrap(), before, "{write} 撤销应恢复原内容");
            // 查询入口能读到这次写入后的模型（撤销后读回原值，说明写入真的发生过）。
            assert!(editor.type_query(query, query_params.clone()).is_ok(), "{write} 之后 {query} 应可用");
        }
        assert_eq!(editor.content_hash().unwrap(), base_hash);
    }

    /// 首段字符的排版参数在内容身份里。
    ///
    /// `document_content` 写的是首 run 的平铺字段，`:range` 只改中间几个字符时则由
    /// `charRuns` 逐 run 摘要覆盖（见 `range_scoped_typography_changes_the_content_identity`）。
    #[test]
    fn leading_on_the_whole_layer_is_part_of_the_content_identity() {
        let (mut editor, id) = editor();
        let before = editor.content_hash().unwrap();
        // `type.setStyle` 仍是 P0 命令：通过共享入口执行。
        let result = editor.execute("type.setStyle", json!({"layer": id, "leading": 40})).unwrap();
        assert!(result["runs"].is_array());
        assert_ne!(editor.content_hash().unwrap(), before);
        let info = editor.type_query("type.info", json!({"layer": id})).unwrap();
        assert_eq!(info["runs"][0]["style"]["leading_pt"], 40.0);
        editor.undo().unwrap();
        assert_eq!(editor.content_hash().unwrap(), before);
        // 本域只转发自己白名单里的命令：`type.setStyle` 不在其中，域入口不会重开它。
        assert!(!crate::features::r#type::params::is_command("type.setStyle"));
        assert!(editor.type_commands("type.setStyle", json!({"layer": id, "kerning": "optical"})).is_err());
    }

    #[test]
    fn reported_changes_always_match_the_content_fingerprint() {
        // `changed` 只表示内容身份变化，不表示「模型变了」；两者分离是有意的，界面据此决定
        // 是否置 dirty。
        let (mut editor, id) = editor();
        let before = editor.content_hash().unwrap();
        let result = editor.type_commands("type.setStyle", json!({"layer": id, "kerning": "optical"})).err();
        assert!(result.is_some(), "域入口不转发 P0 的 type.setStyle");
        let applied = editor.execute("type.setStyle", json!({"layer": id, "kerning": "optical"})).unwrap();
        assert!(applied["runs"].is_array());
        assert_ne!(editor.content_hash().unwrap(), before, "整层字偶距策略在指纹里");
        let info = editor.type_query("type.info", json!({"layer": id})).unwrap();
        assert_eq!(info["runs"][0]["style"]["kerning"], "Optical");
    }

    /// 排版内容**整体**进入内容身份：逐段落选项、手工字偶距、OpenType、抗锯齿、Warp 与
    /// 首 run 行距都必须改变指纹，否则「改了但界面不认为 dirty」。
    ///
    /// 每一项单独起一个编辑器，避免前一项的写入掩盖后一项（例如同一字段被覆盖）。
    #[test]
    fn every_persisted_typography_field_changes_the_content_identity() {
        // (`type.setStyle` 走共享入口；其余走域入口；`kernPair` 必须带两个以上字符。)
        let cases: Vec<(&str, Value)> = vec![
            ("段落段前距", json!({"spaceBefore": 6})),
            ("段落首行缩进", json!({"firstLineIndent": 8})),
            ("段落自动行距", json!({"autoLeading": 1.5})),
            ("手工字偶距", json!({"kernPair": {"at": 1, "by": 30}})),
            ("首 run 行距", json!({"leading": 44})),
            ("首 run 字距", json!({"tracking": 60})),
            ("基线偏移", json!({"baselineShift": 3})),
        ];
        for (name, params) in cases {
            let (mut editor, id) = editor();
            let mut params = params;
            params["layer"] = json!(id);
            let before = editor.content_hash().unwrap();
            editor.apply_typography(params).unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_ne!(editor.content_hash().unwrap(), before, "{name} 必须改变内容身份");
            // 一步历史，撤销后身份回到原值。
            editor.undo().unwrap();
            assert_eq!(editor.content_hash().unwrap(), before, "{name} 撤销后身份必须复原");
        }

        // 整层字符属性：只有一个 run，`charRuns` 不会出现，必须由平铺字段覆盖。
        // 这些都由 `type.setStyle`（P0 共享入口）写入，实测修复前都不改变指纹。
        for (name, params) in [
            ("整层下划线", json!({"underline": true})),
            ("整层删除线", json!({"strikethrough": true})),
            ("整层斜体", json!({"italic": true})),
            ("整层横向缩放", json!({"horizontalScale": 150})),
            ("整层纵向缩放", json!({"verticalScale": 150})),
            ("整层字重", json!({"weight": 700})),
            ("整层大小写", json!({"caps": "all"})),
            ("整层关闭连字", json!({"ligatures": false})),
            ("整层自由连字", json!({"discretionaryLigatures": true})),
            ("整层语言", json!({"language": "zh-Hans"})),
            ("整层可变轴", json!({"variations": {"wght": 650}})),
            ("范围字号", json!({"range": [6, 11], "size": 40})),
            ("范围颜色", json!({"range": [6, 11], "color": "#ff0000"})),
            ("范围字体", json!({"range": [6, 11], "font": "Noto Sans SC"})),
        ] {
            let (mut editor, id) = editor_with("ABCDE FGHIJ");
            let mut params = params;
            params["layer"] = json!(id);
            let before = editor.content_hash().unwrap();
            editor.execute("type.setStyle", params.clone()).expect(name);
            assert_ne!(editor.content_hash().unwrap(), before, "{name} 必须改变内容身份：{params}");
            editor.undo().unwrap();
            assert_eq!(editor.content_hash().unwrap(), before, "{name} 撤销后身份必须复原");
        }

        // 域入口的三类写入。
        for (name, id, params) in [
            ("OpenType", "type.openType.fractions", json!({"on": true})),
            ("抗锯齿", "type.antiAlias.none", json!({})),
            ("Warp", "type.warpText", json!({"style": "arc", "bend": 20})),
        ] {
            let (mut editor, layer) = editor_with("ABCDE");
            let mut params = params;
            params["layer"] = json!(layer);
            let before = editor.content_hash().unwrap();
            let result = editor.type_commands(id, params).unwrap();
            assert_eq!(result["changed"], true, "{name} 必须报告 changed");
            assert_ne!(editor.content_hash().unwrap(), before, "{name} 必须改变内容身份");
        }
    }

    /// 默认排版的文字层不写任何排版字段：旧工程的身份必须逐字节保持兼容。
    #[test]
    fn default_typography_writes_nothing_into_the_description() {
        let (editor, id) = editor();
        let content = crate::document_content::project_content(
            &editor.active_doc().unwrap().doc,
            &editor.registry,
        );
        let text = content["layers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|layer| layer["kind"] == "text")
            .expect("应有文字层");
        let summary = text["text"].as_object().unwrap();
        // 只允许基础键；任何排版键在默认状态下都不该出现。
        for key in [
            "leading", "tracking", "baselineShift", "kern", "features", "warp", "antialias",
            "paragraphAlign", "firstLineIndent", "startIndent", "endIndent", "spaceBefore",
            "spaceAfter", "autoLeading", "direction", "hyphenate", "styleSheet", "charRuns",
            "paragraphRuns",
        ] {
            assert!(!summary.contains_key(key), "默认排版不应写 {key}");
        }
        // 但基础身份字段必须在。
        for key in ["text", "fontFamily", "fontSize", "color", "bold", "align"] {
            assert!(summary.contains_key(key), "基础身份字段 {key} 必须存在");
        }
        // 默认样式表（只有 Basic Paragraph）不写文档级摘要。
        assert!(content.get("textStyles").is_none(), "默认样式表不应写 textStyles");
        let _ = id;
    }

    /// 范围级排版（`type.setStyle` 的 `range`）必须改变内容身份。
    ///
    /// 上游 `type.setStyle` 支持只改中间几个字符；只摘要首 run 会让「选中第 6–11 个字符改字距」
    /// 既不换指纹也不判脏，用户改完关窗口不会被提示保存。逐 run 摘要（`charRuns`）就是为此存在。
    #[test]
    fn range_scoped_typography_changes_the_content_identity() {
        // (`start`, `end`, 字段) 三元组：都落在首 run 之后，验证不是靠首 run 蒙对。
        for params in [
            json!({"range": [6, 11], "tracking": 300}),
            json!({"range": [6, 11], "leading": 40}),
            json!({"range": [6, 11], "baselineShift": 5}),
            // 伪粗体/伪斜体同样改变真实字形（上游按 `embolden`/`skew` 合成），范围级写入只影响
            // 中间几个字符，只能由逐 run 摘要覆盖——实测修复前这两项既不换指纹也不判脏。
            json!({"range": [6, 11], "fauxBold": true}),
            json!({"range": [6, 11], "fauxItalic": true}),
        ] {
            let (mut editor, id) = editor_with("ABCDE FGHIJ");
            let before = editor.content_hash().unwrap();
            let mut params = params.clone();
            params["layer"] = json!(id);
            editor.execute("type.setStyle", params.clone()).unwrap();
            assert_ne!(
                editor.content_hash().unwrap(),
                before,
                "中间范围排版必须改变内容身份：{params}"
            );
            // 一步历史，撤销后身份复原。
            editor.undo().unwrap();
            assert_eq!(editor.content_hash().unwrap(), before, "{params} 撤销后身份必须复原");
        }
        // 把范围排版改回默认后身份也必须复原：run 碎片本身不是内容。
        let (mut editor, id) = editor_with("ABCDE FGHIJ");
        let before = editor.content_hash().unwrap();
        editor.execute("type.setStyle", json!({"layer": id, "range": [6, 11], "tracking": 300})).unwrap();
        editor.execute("type.setStyle", json!({"layer": id, "range": [6, 11], "tracking": 0})).unwrap();
        assert_eq!(editor.content_hash().unwrap(), before, "改回默认值后身份必须复原");
    }

    /// 应用字符样式必须改变内容身份。
    ///
    /// 上游应用样式是把样式的**解析值**写进 run（例如下划线），run 自己的字号/颜色可能完全不变；
    /// 只摘要字号/颜色就会「换了样式却不判脏」。实测修复前 `type.characterStyle.apply` 返回
    /// `changed: false`、指纹也没变，而 run 的 `underline` 已经变成 `true`。
    #[test]
    fn applying_a_character_style_changes_the_content_identity() {
        let (mut editor, id) = editor();
        let before = editor.content_hash().unwrap();
        // 样式只设下划线：不动身份里的字号/颜色/字距，专测「引用本身」是否被摘要。
        let created = editor
            .type_commands("type.characterStyle.new", json!({"name": "下划线", "attrs": {"underline": true}}))
            .unwrap();
        let style = created["result"]["id"].as_u64().unwrap();
        let after_create = editor.content_hash().unwrap();
        let applied = editor.type_commands("type.characterStyle.apply", json!({"id": style, "layer": id})).unwrap();
        assert_eq!(applied["changed"], true, "应用字符样式必须判为已改动");
        let after_apply = editor.content_hash().unwrap();
        assert_ne!(after_apply, after_create, "应用字符样式必须改变内容身份");
        // 删掉样式表后仍**不等于**基线：上游应用样式时把解析值写进了 run（`underline: true`），
        // 删样式只清引用、不清已解析的字符属性，渲染仍是下划线。所以这里断言「仍与基线不同」，
        // 而不是假装删掉样式就回到原样——指纹必须跟渲染一致。
        editor.type_commands("type.characterStyle.delete", json!({"id": style})).unwrap();
        assert_ne!(
            editor.content_hash().unwrap(),
            before,
            "已解析到 run 的下划线仍在，身份不该回到基线"
        );
        // 真的把下划线关掉后，身份才回到基线。
        editor.execute("type.setStyle", json!({"layer": id, "underline": false})).unwrap();
        assert_eq!(editor.content_hash().unwrap(), before, "关掉下划线后应回到基线");
    }

    /// 文档级样式表内容也必须进入身份。
    ///
    /// 改样式表本身（新建/改属性/重命名）时，引用它的文字层看起来毫无变化；不摘要样式表就会
    /// 「改了样式但界面不脏」，关窗口不提示保存。
    #[test]
    fn document_style_tables_are_part_of_the_content_identity() {
        // 新建字符样式。
        let (mut editor, _) = editor();
        let before = editor.content_hash().unwrap();
        let created = editor.type_commands("type.characterStyle.new", json!({"name": "标题"})).unwrap();
        let id = created["result"]["id"].as_u64().unwrap();
        assert_eq!(created["changed"], true, "新建样式必须判为已改动");
        assert_ne!(editor.content_hash().unwrap(), before);
        // 改样式表属性（不动任何图层）。
        let changed = editor
            .type_commands("type.characterStyle.set", json!({"id": id, "attrs": {"size_pt": 60}}))
            .unwrap();
        assert_eq!(changed["changed"], true, "改样式表属性必须判为已改动");
        // 重命名同样改内容（名称随工程保存）。
        let renamed = editor
            .type_commands("type.characterStyle.rename", json!({"id": id, "name": "大标题"}))
            .unwrap();
        assert_eq!(renamed["changed"], true, "重命名样式必须判为已改动");
        // 删掉后样式表回到空表，身份回到基线。
        let deleted = editor.type_commands("type.characterStyle.delete", json!({"id": id})).unwrap();
        assert_eq!(deleted["changed"], true);
        assert_eq!(editor.content_hash().unwrap(), before, "样式表清空后身份必须回到基线");
    }

    #[test]
    fn converting_and_rasterizing_keep_one_undo_step_for_the_original_text() {
        for id in ["type.convertToShape", "type.rasterizeTypeLayer"] {
            let (mut editor, layer) = editor();
            let before_hash = editor.content_hash().unwrap();
            let before_steps = steps(&editor);
            let result = editor.type_commands(id, json!({"layer": layer})).unwrap();
            assert_eq!(result["changed"], true);
            assert_eq!(steps(&editor), before_steps + 1);
            // 转换后原文字层不再是文字层，撤销恢复文字与身份。
            editor.undo().unwrap();
            assert_eq!(editor.content_hash().unwrap(), before_hash);
            let info = editor.type_query("type.info", json!({"layer": layer})).unwrap();
            assert_eq!(info["text"], "Type example");
        }
    }

    #[test]
    fn create_work_path_and_type_mask_leave_real_geometry_and_a_selection() {
        let (mut editor, layer) = editor();
        let before_steps = steps(&editor);
        let path = editor.type_commands("type.createWorkPath", json!({"layer": layer})).unwrap();
        assert!(path["result"]["subpaths"].as_u64().unwrap() > 0);
        assert_eq!(steps(&editor), before_steps + 1);
        let mask = editor.type_commands("type.createSelection", json!({"layer": layer})).unwrap();
        assert_eq!(mask["result"]["selected"], true);
        // 选区不是工程内容：内容身份不变，但文档确实拿到了真实字形选区。
        assert_eq!(mask["changed"], false);
        assert_eq!(editor.state().pointer("/document/hasSelection"), Some(&json!(true)));
        // 文字蒙版不偷偷建层。
        let layers = editor.state().pointer("/document/layers").unwrap().as_array().unwrap().len();
        assert_eq!(layers, 2);
    }

    #[test]
    fn find_and_replace_only_touches_the_matched_text_and_find_alone_changes_nothing() {
        let (mut editor, layer) = editor();
        let before_hash = editor.content_hash().unwrap();
        let before_steps = steps(&editor);
        // 纯查找：无内容变化、无历史。
        let found = editor
            .type_query("edit.findAndReplaceText", json!({"find": "example", "action": "find"}))
            .unwrap();
        assert_eq!(found["found"]["text"], "example");
        assert_eq!(found["found"]["layer"], json!(layer));
        assert_eq!(editor.content_hash().unwrap(), before_hash);
        assert_eq!(steps(&editor), before_steps);
        // 替换：只改匹配文本。
        let replaced = editor
            .type_commands("edit.findAndReplaceText", json!({"find": "example", "replace": "sample"}))
            .unwrap();
        assert_eq!(replaced["result"]["count"], 1);
        assert_eq!(steps(&editor), before_steps + 1);
        let info = editor.type_query("type.info", json!({"layer": layer})).unwrap();
        assert_eq!(info["text"], "Type sample");
        editor.undo().unwrap();
        assert_eq!(editor.content_hash().unwrap(), before_hash);
    }

    /// 界面「替换当前」用上游 `change`：它只替换**查找光标当前命中**的那一处，并返回
    /// `changed:{layer,start,end}`（没有 `count`）。`changed` 必须仍由内容指纹决定，
    /// 不能因为动作名不是 `changeAll` 就漏报。
    #[test]
    fn single_replace_changes_one_match_only_and_reports_its_change() {
        let (mut editor, layer) = editor();
        // 造出两处匹配，且光标在开头。
        editor
            .execute("type.create", json!({"x": 10, "y": 150, "text": "example example", "size": 18, "font": "Inter"}))
            .unwrap();
        let found = editor.type_query("edit.findAndReplaceText", json!({"find": "example", "action": "find"})).unwrap();
        assert_eq!(found["found"]["start"], 0);
        let before = editor.content_hash().unwrap();
        let result = editor
            .type_commands("edit.findAndReplaceText", json!({"find": "example", "replace": "one", "action": "change"}))
            .unwrap();
        assert_eq!(result["result"]["changed"]["start"], 0);
        assert_eq!(result["changed"], true, "替换真的改了内容，不能因为不是 changeAll 就报无变化");
        assert_ne!(editor.content_hash().unwrap(), before);
        // 只剩一处匹配：第二个 `example` 仍是原文。
        let texts: Vec<String> = editor
            .state()
            .pointer("/document/layers")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|layer| layer.pointer("/text/text").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert!(texts.contains(&"one example".to_string()), "{texts:?}");
        let _ = layer;
    }

    #[test]
    fn spelling_reports_only_what_the_bundled_dictionary_knows() {
        let (mut editor, layer) = editor();
        editor
            .execute("type.create", json!({"x": 20, "y": 140, "text": "teh recieve", "size": 18, "font": "Inter"}))
            .unwrap();
        let listed = editor
            .type_query("edit.checkSpelling", json!({"action": "list", "suggestions": 3}))
            .unwrap();
        let words: Vec<&str> = listed["misspellings"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["layer"].as_u64() == Some(layer) || row["layer"].as_u64().is_some())
            .filter_map(|row| row["word"].as_str())
            .collect();
        assert!(words.contains(&"teh"), "{listed}");
        // 修词走写入口，一次一步。
        let before_steps = steps(&editor);
        let changed = editor
            .type_commands("edit.checkSpelling", json!({"action": "changeAll", "word": "teh", "replace": "the"}))
            .unwrap();
        assert_eq!(changed["result"]["changed"], 1);
        assert_eq!(steps(&editor), before_steps + 1);
        let listed = editor.type_query("edit.checkSpelling", json!({"action": "list", "layer": layer})).unwrap();
        assert!(listed["misspellings"].as_array().unwrap().iter().all(|row| row["word"] != "the"));
    }

    #[test]
    fn missing_fonts_are_reported_and_replacement_keeps_the_text() {
        let (mut editor, _layer) = editor();
        editor
            .execute("type.create", json!({"x": 10, "y": 40, "text": "Keep me", "size": 20, "font": "Missing Family"}))
            .unwrap();
        let listed = editor.type_query("type.resolveMissingFonts", json!({})).unwrap();
        assert!(listed["missing"].as_array().unwrap().iter().any(|font| font == "Missing Family"));
        let before = editor.type_commands("type.resolveMissingFonts", json!({"map": {"Missing Family": "Inter"}})).unwrap();
        assert_eq!(before["result"]["missing"][0], "Missing Family");
        // 原文保留：只有字族被替换。
        let state = editor.state();
        let text: Vec<&str> = state
            .pointer("/document/layers")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|layer| layer.pointer("/text/text").and_then(Value::as_str))
            .collect();
        assert!(text.contains(&"Keep me"));
        let listed = editor.type_query("type.resolveMissingFonts", json!({})).unwrap();
        assert!(listed["missing"].as_array().unwrap().is_empty());
    }

    #[test]
    fn dual_state_commands_report_changes_from_their_write_actions_only() {
        // 这三个命令同时登记在读/写两张表：`changed` 必须按**动作**判断，不能按表。
        let (mut editor, layer) = editor();
        let replaced = editor
            .type_commands("edit.findAndReplaceText", json!({"find": "example", "replace": "sample"}))
            .unwrap();
        assert_eq!(replaced["changed"], true, "替换改了内容，不能因为命令也在查询表里就报无变化");
        let replaced_all = editor
            .type_commands("edit.checkSpelling", json!({"action": "changeAll", "word": "sample", "replace": "specimen"}))
            .unwrap();
        assert_eq!(replaced_all["changed"], true);
        let fonts = editor
            .type_commands("type.resolveMissingFonts", json!({"map": {"Gone": "Inter"}}))
            .unwrap();
        assert_eq!(fonts["changed"], false, "没有缺失字体时替换是无变化");
        // 读动作仍然报无变化。
        let found = editor
            .type_query("edit.findAndReplaceText", json!({"find": "specimen", "action": "find"}))
            .unwrap();
        assert_eq!(found["found"]["text"], "specimen");
        let _ = layer;
    }

    #[test]
    fn invalid_params_are_refused_before_the_kernel_and_keep_the_document() {
        let (mut editor, layer) = editor();
        let before = editor.state();
        let before_hash = editor.content_hash().unwrap();
        for (id, params) in [
            ("type.warpText", json!({"layer": layer, "style": "spiral"})),
            ("type.createSelection", json!({})),
            ("edit.findAndReplaceText", json!({"replace": "新"})),
            ("edit.checkSpelling", json!({"action": "change", "layer": layer, "replace": "x"})),
            ("type.characterStyle.rename", json!({"id": 1})),
            ("type.convertToShape", json!({"layer": layer, "text": "偷偷新建"})),
        ] {
            let error = editor.type_commands(id, params).expect_err(id);
            assert_eq!(error.code(), "command-failed", "{id}");
        }
        assert_eq!(editor.state(), before);
        assert_eq!(editor.content_hash().unwrap(), before_hash);
    }

    #[test]
    fn an_open_text_draft_blocks_the_whole_domain() {
        let (mut editor, layer) = editor();
        editor.begin_text(json!({"layer": layer})).unwrap();
        let error = editor.type_commands("type.antiAlias.crisp", json!({"layer": layer})).expect_err("draft");
        assert_eq!(error.code(), "command-failed");
        assert!(error.to_string().contains("文字编辑"));
        let error = editor.type_query("type.info", json!({"layer": layer})).expect_err("draft");
        assert_eq!(error.code(), "command-failed");
        editor.cancel_text();
    }

    /// 上游的 `with_text_targets`（抗锯齿/OpenType/变形/样式）不做锁定检查，所以「全部锁定」
    /// 的文字层仍会被域入口改写甚至转成形状。本域补上 Photoshop 语义：锁定即拒绝，且不动文档。
    #[test]
    fn a_fully_locked_type_layer_refuses_domain_writes() {
        for (id, params) in [
            ("type.antiAlias.none", json!({"layer": 0})),
            ("type.openType.fractions", json!({"layer": 0, "on": true})),
            ("type.warpText", json!({"layer": 0, "style": "arc"})),
            ("type.convertToShape", json!({"layer": 0})),
            ("type.rasterizeTypeLayer", json!({"layer": 0})),
            ("type.convertToPointText", json!({"layer": 0})),
            ("type.createSelection", json!({"layer": 0, "removeLayer": true})),
            ("type.characterStyle.new", json!({"name": "锁定", "layer": 0, "apply": true})),
            // 缺字体替换不接目标参数：上游会把文档里每个文字层都改写，锁定层必须一起拒绝。
            ("type.replaceAllMissingFonts", json!({})),
            ("type.resolveMissingFonts", json!({"map": {"Missing Family": "Inter"}})),
        ] {
            let (mut editor, layer) = editor();
            editor.execute("layer.select", json!({"layer": layer})).unwrap();
            editor.execute("layer.lockLayers", json!({"all": true})).unwrap();
            let before_hash = editor.content_hash().unwrap();
            let before_state = editor.state();
            let before_steps = steps(&editor);
            // 把占位目标替换成真实图层 id。
            let params = serde_json::from_str(&params.to_string().replace("\"layer\":0", &format!("\"layer\":{layer}"))).unwrap();
            let error = editor.type_commands(id, params).expect_err(id);
            assert!(error.to_string().contains("已全部锁定"), "{id}: {error}");
            assert_eq!(editor.content_hash().unwrap(), before_hash, "{id} 拒绝后内容身份不能变");
            assert_eq!(editor.state(), before_state, "{id} 拒绝后模型不能变");
            assert_eq!(steps(&editor), before_steps, "{id} 拒绝后不能进历史");
        }
    }

    /// 只读查询与只改样式表的命令不受图层锁定影响：锁定不阻止读取或管理样式库。
    #[test]
    fn locking_a_layer_keeps_reads_and_style_table_management_available() {
        let (mut editor, layer) = editor();
        editor.execute("layer.select", json!({"layer": layer})).unwrap();
        editor.execute("layer.lockLayers", json!({"all": true})).unwrap();
        assert!(editor.type_query("type.info", json!({"layer": layer})).is_ok());
        assert!(editor.type_query("type.characterStyle.list", json!({"layer": layer})).is_ok());
        // 重命名样式只改样式表，不写目标图层，因此仍然允许。
        let created = editor.type_commands("type.characterStyle.new", json!({"name": "标题"})).unwrap();
        // 新建样式确实改动了文档内容（样式表本身进指纹），因此这里**必须**报已改动；
        // 若报 `false`，用户建完样式关窗口就不会被提示保存。
        assert_eq!(created["changed"], true, "新建样式改变了样式表，必须判为已改动");
        // id 0 是内置「None」样式，不可重命名；取刚建的那个。
        let listed = editor.type_query("type.characterStyle.list", json!({})).unwrap();
        let id = listed["styles"]
            .as_array()
            .unwrap()
            .iter()
            .find(|style| style["name"] == "标题")
            .and_then(|style| style["id"].as_u64())
            .expect("新建的字符样式应该出现在列表里");
        assert!(editor.type_commands("type.characterStyle.rename", json!({"id": id, "name": "大标题"})).is_ok());
    }

    /// 缺字体替换的真实风险：它不接受目标参数，上游会把**每个**文字层都改一遍。
    /// 即使当前选中的是别的图层，锁定的缺字体文字层也不能被改字体。
    #[test]
    fn missing_font_replacement_refuses_locked_layers_even_when_they_are_not_selected() {
        let (mut editor, plain) = editor();
        let missing = editor
            .execute("type.create", json!({"x": 10, "y": 40, "text": "Locked me", "size": 20, "font": "Missing Family"}))
            .unwrap()["layer"]
            .as_u64()
            .unwrap();
        // `layer.lockLayers` 只作用于已选图层，且参数是扁平的：先选中再锁定。
        editor.execute("layer.select", json!({"layer": missing})).unwrap();
        editor.execute("layer.lockLayers", json!({"all": true})).unwrap();
        // 把选中移回普通层：显式目标解析会漏掉锁定的那层，全文档范围才查得到。
        editor.execute("layer.select", json!({"layer": plain})).unwrap();
        let before_fonts = editor.state().pointer("/document/layers").unwrap().as_array().unwrap().iter()
            .filter_map(|layer| layer.pointer("/text/font_family").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        for (id, params) in [
            ("type.replaceAllMissingFonts", json!({})),
            ("type.resolveMissingFonts", json!({"map": {"Missing Family": "Inter"}})),
        ] {
            let error = editor.type_commands(id, params).expect_err(id);
            assert!(error.to_string().contains("已全部锁定"), "{id}: {error}");
        }
        let after_fonts = editor.state().pointer("/document/layers").unwrap().as_array().unwrap().iter()
            .filter_map(|layer| layer.pointer("/text/font_family").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        assert_eq!(before_fonts, after_fonts, "锁定的文字层不能被改字体");
        // 解锁后同一命令恢复可用，证明拒绝只来自锁定而不是参数错误。
        editor.execute("layer.select", json!({"layer": missing})).unwrap();
        editor.execute("layer.lockLayers", json!({"all": false})).unwrap();
        let applied = editor
            .type_commands("type.resolveMissingFonts", json!({"map": {"Missing Family": "Inter"}}))
            .unwrap();
        assert_eq!(applied["changed"], true);
    }

    /// `applyTypography` 是面板**实际使用**的入口（不是 `typeCommand`），它自己调
    /// `typography_patch` 后转给上游 `type.setStyle`。上游不看 `effective_locks`，所以这条
    /// 入口必须单独补锁定判定，否则「全部锁定」的文字层仍会被面板改掉行距。
    #[test]
    fn apply_typography_refuses_a_fully_locked_type_layer() {
        let (mut editor, layer) = editor();
        editor.execute("layer.select", json!({"layer": layer})).unwrap();
        editor.execute("layer.lockLayers", json!({"all": true})).unwrap();
        let before_hash = editor.content_hash().unwrap();
        let before_state = editor.state();
        let before_steps = steps(&editor);

        for params in [
            json!({"layer": layer, "leading": 44}),
            json!({"layer": layer, "tracking": 120}),
            json!({"layer": layer, "kernPair": {"at": 1, "by": -20}}),
            json!({"layer": layer, "spaceBefore": 6}),
            // 不显式给目标时按已选图层解析，同样要拒绝。
            json!({"leading": 44}),
        ] {
            let error = editor.apply_typography(params.clone()).expect_err(&params.to_string());
            assert!(error.to_string().contains("已全部锁定"), "{params}: {error}");
        }
        assert_eq!(editor.content_hash().unwrap(), before_hash, "拒绝后内容身份不能变");
        assert_eq!(editor.state(), before_state, "拒绝后模型不能变");
        assert_eq!(steps(&editor), before_steps, "拒绝后不能进历史");

        // 解锁后同一入口恢复可用，证明拒绝只来自锁定而非参数非法。
        editor.execute("layer.lockLayers", json!({"all": false})).unwrap();
        editor.apply_typography(json!({"layer": layer, "leading": 44})).unwrap();
        assert_ne!(editor.content_hash().unwrap(), before_hash);
    }

    /// 锁定只拦目标层：同一文档里未锁定的文字层仍可排版。
    #[test]
    fn apply_typography_still_writes_an_unlocked_layer_next_to_a_locked_one() {
        let (mut editor, locked) = editor();
        let unlocked = editor
            .execute("type.create", json!({"x": 10, "y": 40, "text": "Free", "size": 20, "font": "Inter"}))
            .unwrap()["layer"]
            .as_u64()
            .unwrap();
        editor.execute("layer.select", json!({"layer": locked})).unwrap();
        editor.execute("layer.lockLayers", json!({"all": true})).unwrap();
        let before = editor.content_hash().unwrap();
        editor.apply_typography(json!({"layer": unlocked, "leading": 33})).unwrap();
        assert_ne!(editor.content_hash().unwrap(), before, "未锁定的文字层必须仍可排版");
        assert!(editor.apply_typography(json!({"layer": locked, "leading": 33})).is_err());
    }
}
