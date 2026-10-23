//! 文字域的命令白名单与参数校验（U67/U68/U69）。
//!
//! 域入口 `crate::editor::text` 的 `type_commands`/`type_query` 只接受这里列出的命令 id：这是
//! 「逐能力开放」的实际作用点，不是把 `type.` 或 `edit.` 整个前缀放开。校验在调用内核前完成，
//! 非法参数既不产生草稿，也不进历史。
//!
//! 白名单里的每个 id 都必须同时存在于上游命令注册表（`capability` 的测试会核对），并且只有在
//! 参数、WASM、React 与核验都接通后才加入；平台暂缓项（竖排、沿路径排字、默认样式读写、
//! 光标命中）永远不加入。
//!
//! 两张表各自不重复，但读/写双态命令（`edit.checkSpelling` 的列表与替换、
//! `type.resolveMissingFonts` 的列出与应用）按动作分别出现在两张表里：查询入口只接受读动作，
//! 写入入口只接受写动作。

use serde_json::Value;

/// 读取类命令：返回投影数据，不写文档、不进历史。
pub const TYPE_QUERIES: &[&str] = &[
    "type.info",
    "type.fonts",
    "type.characterStyle.list",
    "type.paragraphStyle.list",
    "edit.checkSpelling",
    "edit.findAndReplaceText",
    "type.resolveMissingFonts",
];

/// 写入类命令：每次调用最多一步历史。
pub const TYPE_COMMANDS: &[&str] = &[
    // U67：段落/字符样式库、OpenType、点/段落转换、字体替换。
    "type.characterStyle.new",
    "type.characterStyle.duplicate",
    "type.characterStyle.delete",
    "type.characterStyle.rename",
    "type.characterStyle.set",
    "type.characterStyle.apply",
    "type.characterStyle.redefine",
    "type.characterStyle.clearOverride",
    "type.paragraphStyle.new",
    "type.paragraphStyle.duplicate",
    "type.paragraphStyle.delete",
    "type.paragraphStyle.rename",
    "type.paragraphStyle.set",
    "type.paragraphStyle.apply",
    "type.paragraphStyle.redefine",
    "type.paragraphStyle.clearOverride",
    "type.openType.standardLigatures",
    "type.openType.contextualAlternates",
    "type.openType.discretionaryLigatures",
    "type.openType.swash",
    "type.openType.oldstyle",
    "type.openType.stylisticAlternates",
    "type.openType.titlingAlternates",
    "type.openType.ornaments",
    "type.openType.ordinals",
    "type.openType.fractions",
    "type.convertToPointText",
    "type.convertToParagraphText",
    "type.replaceAllMissingFonts",
    "type.resolveMissingFonts",
    // U68：抗锯齿、变形、转路径/形状与栅格化。
    "type.antiAlias.none",
    "type.antiAlias.sharp",
    "type.antiAlias.crisp",
    "type.antiAlias.strong",
    "type.antiAlias.smooth",
    "type.antiAlias.windows",
    "type.antiAlias.windowsLcd",
    "type.warpText",
    "type.createWorkPath",
    "type.convertToShape",
    "type.rasterizeTypeLayer",
    // U69：文字蒙版、查找替换、拼写。
    "type.createSelection",
    "edit.findAndReplaceText",
    "edit.checkSpelling",
];

/// 抗锯齿方式（与上游 `AntiAlias` 枚举同名）。
pub const ANTIALIAS_MODES: &[&str] = &["none", "sharp", "crisp", "strong", "smooth", "windows", "windowsLcd"];

/// 文字变形样式（上游 `photocraft_text::warp` 的短 id，外加关闭）。
pub const WARP_STYLES: &[&str] = &[
    "none",
    "arc",
    "arcLower",
    "arcUpper",
    "arch",
    "bulge",
    "shellLower",
    "shellUpper",
    "flag",
    "wave",
    "fish",
    "rise",
    "fisheye",
    "inflate",
    "squeeze",
    "twist",
];

/// 拼写检查动作。`list`/`suggest` 只读，其余写文档或本机词典。
pub const SPELL_ACTIONS: &[&str] = &["list", "change", "changeAll", "addToDictionary", "removeFromDictionary", "suggest"];
const SPELL_READ_ACTIONS: &[&str] = &["list", "suggest"];

/// 查找替换动作（`find` 只移动搜索游标，不属于内容写入）。
const FIND_ACTIONS: &[&str] = &["changeAll", "find", "change", "changeFind"];

/// 文字蒙版选区运算。
const MASK_OPERATIONS: &[&str] = &["new", "add", "subtract", "intersect"];

/// 上限：单次参数里的有界长度（不是工程预算，只拒绝恶意参数）。
const MAX_QUERY_CHARS: usize = 4096;
const MAX_WORD_CHARS: usize = 200;
const MAX_NAME_CHARS: usize = 200;
const MAX_LIST: usize = 256;

pub fn is_query(id: &str) -> bool {
    TYPE_QUERIES.contains(&id)
}

pub fn is_command(id: &str) -> bool {
    TYPE_COMMANDS.contains(&id)
}

fn bad(id: &str, message: impl std::fmt::Display) -> crate::error::EditorError {
    crate::error::EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    params.as_object().ok_or_else(|| "参数必须是对象".to_string())
}

/// 只允许列出的键：未开放的参数被明确拒绝，而不是静默忽略。
fn allow_keys(params: &Value, allowed: &[&str]) -> Result<(), String> {
    if let Some(key) = object(params)?.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{key} 不是该命令已开放的参数"));
    }
    Ok(())
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn bounded_text(value: Option<&Value>, max: usize) -> bool {
    text_of(value).is_some_and(|text| !text.is_empty() && text.chars().count() <= max)
}

fn optional_bool(params: &Value, key: &str) -> Result<(), String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Bool(_)) => Ok(()),
        Some(_) => Err(format!("{key} 必须是布尔值")),
    }
}

fn layer_id(params: &Value) -> Result<(), String> {
    match params.get("layer") {
        None | Some(Value::Null) => Ok(()),
        Some(value) => value.as_u64().filter(|id| *id > 0).map(|_| ()).ok_or_else(|| "layer 必须是图层 id".into()),
    }
}

fn layer_ids(params: &Value) -> Result<(), String> {
    match params.get("layers") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(ids)) if !ids.is_empty() && ids.len() <= 64 && ids.iter().all(|id| id.as_u64().is_some_and(|id| id > 0)) => Ok(()),
        Some(_) => Err("layers 必须是 1–64 个图层 id".into()),
    }
}

/// 字符范围：`[起始字符, 结束字符]`，闭区间语义由内核按字符索引解释。
fn char_range(params: &Value) -> Result<(), String> {
    match params.get("range") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(pair)) if pair.len() == 2 && pair.iter().all(|n| n.as_u64().is_some()) => Ok(()),
        Some(_) => Err("range 必须是 [起始字符, 结束字符]".into()),
    }
}

/// 单图层目标命令（上游 `LP`）。
fn only_layer(params: &Value) -> Result<(), String> {
    allow_keys(params, &["layer"])?;
    layer_id(params)
}

/// 可作用于多个文字层的格式命令（上游 `FP`/`OT`/样式命令）。
fn layer_targets(params: &Value, allowed: &[&str]) -> Result<(), String> {
    allow_keys(params, allowed)?;
    layer_id(params)?;
    layer_ids(params)?;
    char_range(params)
}

fn entries(params: &Value, key: &str) -> Result<(), String> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Array(list)) if list.len() <= MAX_LIST => Ok(()),
        Some(Value::Object(map)) if map.len() <= MAX_LIST => Ok(()),
        Some(_) => Err(format!("{key} 必须是有界列表")),
    }
}

/// 字体替换映射：缺失字体 → 已安装字体，两侧都是有界短字符串。
fn font_map(params: &Value) -> Result<(), String> {
    match params.get("map") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(map)) if map.len() <= MAX_LIST => {
            let ok = map.iter().all(|(from, to)| {
                !from.trim().is_empty()
                    && from.chars().count() <= MAX_NAME_CHARS
                    && to.as_str().is_some_and(|to| !to.trim().is_empty() && to.chars().count() <= MAX_NAME_CHARS)
            });
            if ok { Ok(()) } else { Err("字体替换映射必须是「缺失字体 → 已安装字体」的有界字符串".into()) }
        }
        Some(_) => Err(format!("字体替换映射最多 {MAX_LIST} 项")),
    }
}

fn warp(params: &Value) -> Result<(), String> {
    let style = params.get("style").and_then(Value::as_str).unwrap_or("arc");
    if !WARP_STYLES.iter().any(|known| known.eq_ignore_ascii_case(style)) {
        return Err(format!("未知的文字变形样式 {style:?}"));
    }
    for key in ["bend", "horizontalDistortion", "verticalDistortion"] {
        if let Some(value) = params.get(key) {
            let number = value.as_f64().filter(|n| n.is_finite() && (-100.0..=100.0).contains(n));
            if number.is_none() {
                return Err(format!("{key} 必须是 -100–100 内的有限数值"));
            }
        }
    }
    match params.get("orientation") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(axis)) if matches!(axis.as_str(), "horizontal" | "vertical") => Ok(()),
        Some(_) => Err("orientation 必须是 horizontal 或 vertical".into()),
    }
}

/// 查找替换：`find` 只移动搜索游标（不写内容），`change*` 才改文本；读/写入口按动作分工。
fn find_replace(params: &Value, write: bool) -> Result<(), String> {
    allow_keys(params, &["find", "replace", "action", "caseSensitive", "wholeWord", "forward", "allLayers", "layer"])?;
    if !bounded_text(params.get("find"), MAX_QUERY_CHARS) {
        return Err(format!("查找内容必须是 1–{MAX_QUERY_CHARS} 个字符"));
    }
    match params.get("replace") {
        None | Some(Value::Null) => {}
        Some(Value::String(text)) if text.chars().count() <= MAX_QUERY_CHARS => {}
        Some(_) => return Err(format!("替换内容最多 {MAX_QUERY_CHARS} 个字符")),
    }
    let action = text_of(params.get("action")).unwrap_or("changeAll");
    if !FIND_ACTIONS.contains(&action) {
        return Err(format!("未知的查找动作 {action:?}"));
    }
    // 查找只移动搜索游标，不能经由写入口发布内容变化；替换必须走写入口。
    if write == (action == "find") {
        return Err(if write { "纯查找请走文字查询入口".into() } else { "替换请走文字命令入口".into() });
    }
    for key in ["caseSensitive", "wholeWord", "forward", "allLayers"] {
        optional_bool(params, key)?;
    }
    layer_id(params)
}

fn spelling(params: &Value, write: bool) -> Result<(), String> {
    allow_keys(params, &["action", "layer", "allLayers", "ignore", "suggestions", "word", "start", "end", "replace"])?;
    let action = text_of(params.get("action")).unwrap_or("list");
    if !SPELL_ACTIONS.contains(&action) {
        return Err(format!("未知的拼写动作 {action:?}"));
    }
    if write == SPELL_READ_ACTIONS.contains(&action) {
        return Err(if write { "列出/建议请走文字查询入口".into() } else { "修改请走文字命令入口".into() });
    }
    if let Some(word) = params.get("word")
        && !bounded_text(Some(word), MAX_WORD_CHARS)
    {
        return Err(format!("单词必须是 1–{MAX_WORD_CHARS} 个字符"));
    }
    match action {
        "change" => {
            layer_id(params)?;
            for key in ["start", "end"] {
                if params.get(key).and_then(Value::as_u64).is_none() {
                    return Err(format!("逐个替换需要字符位置 {key}"));
                }
            }
            if params.get("replace").and_then(Value::as_str).is_none() {
                return Err("逐个替换需要 replace 文本".into());
            }
        }
        "changeAll" => {
            if !bounded_text(params.get("word"), MAX_WORD_CHARS) {
                return Err("全部替换需要 word".into());
            }
            if params.get("replace").and_then(Value::as_str).is_none() {
                return Err("全部替换需要 replace 文本".into());
            }
        }
        "addToDictionary" | "removeFromDictionary" | "suggest" => {
            if !bounded_text(params.get("word"), MAX_WORD_CHARS) {
                return Err(format!("{action} 需要单词"));
            }
        }
        _ => {}
    }
    if let Some(ignore) = params.get("ignore") {
        let ok = ignore
            .as_array()
            .is_some_and(|words| words.len() <= MAX_LIST && words.iter().all(|word| bounded_text(Some(word), MAX_WORD_CHARS)));
        if !ok {
            return Err("ignore 必须是有界单词列表".into());
        }
    }
    if let Some(count) = params.get("suggestions") {
        if !count.as_u64().is_some_and(|n| n <= 20) {
            return Err("suggestions 必须是 0–20".into());
        }
    }
    optional_bool(params, "allLayers")
}

fn type_mask(params: &Value) -> Result<(), String> {
    allow_keys(params, &["layer", "removeLayer", "operation", "antialias"])?;
    layer_id(params)?;
    optional_bool(params, "removeLayer")?;
    match params.get("operation") {
        None | Some(Value::Null) => {}
        Some(Value::String(operation)) if MASK_OPERATIONS.contains(&operation.as_str()) => {}
        Some(_) => return Err("operation 必须是 new/add/subtract/intersect".into()),
    }
    match params.get("antialias") {
        None | Some(Value::Null) => {}
        Some(Value::String(mode)) if ANTIALIAS_MODES.contains(&mode.as_str()) => {}
        Some(_) => return Err("antialias 必须是已开放的抗锯齿方式".into()),
    }
    // 没有 layer 时上游会用 `type.create` 的键新建临时文字；本域只从**已有文字层**取字形，
    // 不接受另一套文字创建参数（避免绕过文字草稿与内容身份）。
    if params.get("layer").and_then(Value::as_u64).is_none() {
        return Err("文字蒙版需要先选择文字层".into());
    }
    Ok(())
}

fn open_type(params: &Value) -> Result<(), String> {
    layer_targets(params, &["layer", "layers", "on", "range"])?;
    optional_bool(params, "on")
}

/// 样式命令的键集合随动作变化；`list` 与写入动作用同一套目标校验。
fn style_command(id: &str, params: &Value) -> Result<(), String> {
    let action = id.rsplit('.').next().unwrap_or_default();
    match action {
        "list" | "clearOverride" => layer_targets(params, &["layer", "layers", "range"]),
        "new" => {
            layer_targets(params, &["name", "attrs", "fromSelection", "apply", "layer", "layers", "range"])?;
            optional_bool(params, "fromSelection")?;
            optional_bool(params, "apply")
        }
        "duplicate" | "delete" => {
            allow_keys(params, &["id"])?;
            if params.get("id").and_then(Value::as_u64).is_none() {
                return Err("该样式命令需要 id".into());
            }
            Ok(())
        }
        "rename" => {
            allow_keys(params, &["id", "name"])?;
            if params.get("id").and_then(Value::as_u64).is_none() {
                return Err("重命名样式需要 id".into());
            }
            if !bounded_text(params.get("name"), MAX_NAME_CHARS) {
                return Err(format!("样式名必须是 1–{MAX_NAME_CHARS} 个字符"));
            }
            Ok(())
        }
        "set" => {
            layer_targets(params, &["id", "name", "attrs", "replace", "clear", "layer", "layers", "range"])?;
            if params.get("id").and_then(Value::as_u64).is_none() {
                return Err("修改样式需要 id".into());
            }
            if let Some(name) = params.get("name")
                && !bounded_text(Some(name), MAX_NAME_CHARS)
            {
                return Err(format!("样式名必须是 1–{MAX_NAME_CHARS} 个字符"));
            }
            if let Some(replace) = params.get("replace")
                && !replace.is_boolean()
            {
                return Err("replace 必须是布尔值".into());
            }
            let clear = params.get("clear");
            let ok = clear.is_none_or(|clear| {
                clear.as_array().is_some_and(|fields| fields.len() <= 64 && fields.iter().all(|field| text_of(Some(field)).is_some_and(|field| !field.is_empty())))
            });
            if !ok {
                return Err("clear 必须是字段名列表".into());
            }
            style_attrs(params)
        }
        "apply" => {
            layer_targets(params, &["id", "clearOverrides", "layer", "layers", "range"])?;
            match params.get("id") {
                None | Some(Value::Null) => {}
                Some(value) if value.as_u64().is_some() => {}
                Some(_) => return Err("id 必须是样式 id（0/null 表示无样式）".into()),
            }
            optional_bool(params, "clearOverrides")
        }
        "redefine" => {
            layer_targets(params, &["id", "layer", "layers", "range"])?;
            match params.get("id") {
                None | Some(Value::Null) => Ok(()),
                Some(value) if value.as_u64().is_some() => Ok(()),
                Some(_) => Err("id 必须是样式 id".into()),
            }
        }
        other => Err(format!("未知的样式动作 {other}")),
    }
}

fn style_attrs(params: &Value) -> Result<(), String> {
    match params.get("attrs") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::Object(attrs)) if !attrs.is_empty() && attrs.len() <= 64 => Ok(()),
        Some(Value::Object(_)) => Err("attrs 不能为空且最多 64 项".into()),
        Some(_) => Err("attrs 必须是对象".into()),
    }
}

/// 校验一条域写命令的参数；调用方保证 id 已在 [`TYPE_COMMANDS`] 内。
pub fn validate(id: &str, params: &Value) -> crate::error::Result<()> {
    check(id, params).map_err(|message| bad(id, message))
}

fn check(id: &str, params: &Value) -> Result<(), String> {
    if id.starts_with("type.antiAlias.") {
        layer_targets(params, &["layer", "layers", "range"])
    } else if id.starts_with("type.openType.") {
        open_type(params)
    } else if id.starts_with("type.characterStyle.") || id.starts_with("type.paragraphStyle.") {
        style_command(id, params)
    } else {
        match id {
            "type.createWorkPath" | "type.convertToShape" | "type.rasterizeTypeLayer" | "type.convertToPointText"
            | "type.convertToParagraphText" => only_layer(params),
            "type.warpText" => {
                layer_targets(params, &["layer", "layers", "style", "orientation", "bend", "horizontalDistortion", "verticalDistortion"])?;
                warp(params)
            }
            "type.createSelection" => type_mask(params),
            "edit.findAndReplaceText" => find_replace(params, true),
            "edit.checkSpelling" => spelling(params, true),
            // `replaceAllMissingFonts` 使用默认字族，不接受映射；`resolveMissingFonts` 必须带映射才是写入。
            "type.replaceAllMissingFonts" => {
                allow_keys(params, &[])?;
                Ok(())
            }
            "type.resolveMissingFonts" => {
                allow_keys(params, &["map"])?;
                if params.get("map").is_none() {
                    return Err("应用字体替换需要 map".to_string());
                }
                font_map(params)
            }
            _ => Err(format!("{id} 不是本域已开放的命令")),
        }
    }
}

/// 校验一条域查询的参数；调用方保证 id 已在 [`TYPE_QUERIES`] 内。
pub fn validate_query(id: &str, params: &Value) -> crate::error::Result<()> {
    check_query(id, params).map_err(|message| bad(id, message))
}

fn check_query(id: &str, params: &Value) -> Result<(), String> {
    match id {
        "type.info" => only_layer(params),
        "type.fonts" => {
            allow_keys(params, &["family"])?;
            match params.get("family") {
                None | Some(Value::Null) => Ok(()),
                Some(Value::String(family)) if !family.trim().is_empty() && family.chars().count() <= MAX_NAME_CHARS => Ok(()),
                Some(_) => Err("family 必须是有界字体族名".into()),
            }
        }
        "type.characterStyle.list" | "type.paragraphStyle.list" => {
            layer_targets(params, &["layer", "layers", "range"])?;
            entries(params, "range")
        }
        "edit.checkSpelling" => spelling(params, false),
        "edit.findAndReplaceText" => find_replace(params, false),
        "type.resolveMissingFonts" => {
            allow_keys(params, &[])?;
            font_map(params)
        }
        _ => Err(format!("{id} 不是本域已开放的查询")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn allowlists_stay_within_the_two_documented_groups() {
        // 每张表内部不重复；读/写双态命令按动作分别出现在两张表里是设计的一部分。
        for list in [TYPE_COMMANDS, TYPE_QUERIES] {
            let mut seen = std::collections::HashSet::new();
            for id in list {
                assert!(seen.insert(*id), "{id} 在同一张白名单里重复登记");
            }
        }
        // 双态命令必须同时登记两侧：读入口拒绝写动作，写入口拒绝读动作。
        for dual in ["edit.checkSpelling", "edit.findAndReplaceText", "type.resolveMissingFonts"] {
            assert!(is_command(dual) && is_query(dual), "{dual} 应同时登记读写两侧");
        }
        // 排除项永远不在白名单里。
        for excluded in [
            "type.orientation.vertical",
            "type.attachToPath",
            "type.detachFromPath",
            "type.pasteLoremIpsum",
            "type.saveDefaultTypeStyles",
            "type.loadDefaultTypeStyles",
            "type.updateAllTextLayers",
            "type.insertText",
            "type.hitTest",
            "type.caret",
            "type.navigate",
            "type.increaseSize",
        ] {
            assert!(!is_command(excluded) && !is_query(excluded), "{excluded} 属于明确排除范围");
        }
    }

    #[test]
    fn write_and_read_entries_reject_each_others_commands() {
        assert!(is_command("type.convertToShape"));
        assert!(!is_query("type.convertToShape"));
        assert!(is_query("type.info"));
        assert!(!is_command("type.info"));
        assert!(validate("type.info", &json!({})).is_err());
        assert!(validate_query("type.convertToShape", &json!({})).is_err());
    }

    #[test]
    fn warp_bounds_and_styles_are_checked_before_the_kernel() {
        assert!(validate("type.warpText", &json!({"layer": 1, "style": "arc", "bend": 50})).is_ok());
        assert!(validate("type.warpText", &json!({"layer": 1, "style": "none"})).is_ok());
        for bad in [
            json!({"layer": 1, "style": "spiral"}),
            json!({"layer": 1, "bend": 101}),
            json!({"layer": 1, "bend": "50"}),
            json!({"layer": 1, "horizontalDistortion": -1000}),
            json!({"layer": 1, "orientation": "diagonal"}),
            // 变形不接受另一套文字创建参数。
            json!({"layer": 1, "text": "偷偷新建"}),
        ] {
            assert!(validate("type.warpText", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn find_and_replace_needs_a_query_and_a_known_action() {
        assert!(validate("edit.findAndReplaceText", &json!({"find": "旧", "replace": "新"})).is_ok());
        // 纯查找只移动搜索游标：读入口接受，写入口拒绝。
        assert!(validate("edit.findAndReplaceText", &json!({"find": "旧", "action": "find"})).is_err());
        assert!(validate_query("edit.findAndReplaceText", &json!({"find": "旧", "action": "find"})).is_ok());
        assert!(validate_query("edit.findAndReplaceText", &json!({"find": "旧", "replace": "新"})).is_err());
        for bad in [
            json!({"replace": "新"}),
            json!({"find": ""}),
            json!({"find": "a", "action": "delete"}),
            json!({"find": "a", "caseSensitive": 1}),
            json!({"find": "a", "layer": "x"}),
            // 不接受借参数开放其它能力。
            json!({"find": "a", "font": "Inter"}),
        ] {
            assert!(validate("edit.findAndReplaceText", &bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn spelling_needs_positions_for_single_changes_and_lists_nothing_else() {
        assert!(validate("edit.checkSpelling", &json!({"action": "change", "layer": 1, "start": 0, "end": 2, "replace": "hi"})).is_ok());
        assert!(validate("edit.checkSpelling", &json!({"action": "change", "layer": 1, "replace": "hi"})).is_err());
        assert!(validate("edit.checkSpelling", &json!({"action": "changeAll", "word": "helo", "replace": "hello"})).is_ok());
        assert!(validate("edit.checkSpelling", &json!({"action": "nonsense"})).is_err());
        assert!(validate("edit.checkSpelling", &json!({"action": "list"})).is_err());
        // 读入口只接受列出/建议，拒绝写动作。
        assert!(validate_query("edit.checkSpelling", &json!({"action": "list"})).is_ok());
        assert!(validate_query("edit.checkSpelling", &json!({"action": "suggest", "word": "helo"})).is_ok());
        assert!(validate_query("edit.checkSpelling", &json!({"action": "change", "layer": 1, "start": 0, "end": 1, "replace": "x"})).is_err());
        assert!(validate_query("edit.checkSpelling", &json!({"action": "list", "suggestions": 999})).is_err());
    }

    #[test]
    fn type_mask_requires_a_real_type_layer_target() {
        assert!(validate("type.createSelection", &json!({"layer": 4})).is_ok());
        assert!(validate("type.createSelection", &json!({"layer": 4, "operation": "add", "antialias": "crisp"})).is_ok());
        assert!(validate("type.createSelection", &json!({"layer": 4, "operation": "union"})).is_err());
        assert!(validate("type.createSelection", &json!({"text": "新建", "x": 1, "y": 2})).is_err());
        assert!(validate("type.createSelection", &json!({})).is_err());
    }

    #[test]
    fn style_commands_bound_names_and_ids() {
        assert!(validate("type.characterStyle.apply", &json!({"id": 1, "layer": 3})).is_ok());
        assert!(validate("type.paragraphStyle.apply", &json!({"id": null, "layer": 3})).is_ok());
        assert!(validate("type.paragraphStyle.rename", &json!({"id": 1, "name": "正文"})).is_ok());
        assert!(validate("type.paragraphStyle.rename", &json!({"id": 1})).is_err());
        assert!(validate("type.paragraphStyle.rename", &json!({"id": 1, "name": ""})).is_err());
        assert!(validate("type.characterStyle.set", &json!({"id": 1, "attrs": {"size": 12}})).is_ok());
        assert!(validate("type.characterStyle.set", &json!({"id": 1, "attrs": []})).is_err());
        assert!(validate("type.characterStyle.new", &json!({"name": "标题", "apply": true, "layer": 2})).is_ok());
        assert!(validate("type.characterStyle.delete", &json!({"id": 2})).is_ok());
        assert!(validate("type.characterStyle.delete", &json!({})).is_err());
        // 样式命令不接受其它能力的长相参数。
        assert!(validate("type.characterStyle.new", &json!({"name": "x", "warp": "arc"})).is_err());
    }

    #[test]
    fn font_replacement_lists_or_maps_bounded_families() {
        assert!(validate_query("type.resolveMissingFonts", &json!({})).is_ok());
        assert!(validate("type.resolveMissingFonts", &json!({"map": {"Gone": "Inter"}})).is_ok());
        assert!(validate("type.resolveMissingFonts", &json!({"map": {"Gone": ""}})).is_err());
        assert!(validate("type.resolveMissingFonts", &json!({"map": []})).is_err());
        assert!(validate("type.resolveMissingFonts", &json!({})).is_err());
        assert!(validate("type.replaceAllMissingFonts", &json!({})).is_ok());
        assert!(validate("type.replaceAllMissingFonts", &json!({"map": {"Gone": "Inter"}})).is_err());
    }

    #[test]
    fn target_only_commands_refuse_other_keys() {
        assert!(validate("type.convertToShape", &json!({"layer": 1})).is_ok());
        assert!(validate("type.convertToShape", &json!({"layer": 1, "size": 40})).is_err());
        assert!(validate("type.convertToShape", &json!({"layers": [1]})).is_err());
        assert!(validate("type.antiAlias.crisp", &json!({"layers": [1, 2]})).is_ok());
        assert!(validate("type.antiAlias.crisp", &json!({"layer": 0})).is_err());
        assert!(validate("type.antiAlias.crisp", &json!({"layer": 1, "mode": "smooth"})).is_err());
        assert!(validate("type.openType.standardLigatures", &json!({"layer": 1, "on": false, "range": [0, 2]})).is_ok());
        assert!(validate("type.openType.standardLigatures", &json!({"layer": 1, "on": 1})).is_err());
    }
}
