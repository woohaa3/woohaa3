//! 规范文档内容指纹（与 `web/contracts/src/canvas/{content-hash,image-project-content}.ts`
//! 逐字节一致）。
//!
//! 宿主与编辑器必须对「是否净变化」得到同一答案。为此本模块复刻 TypeScript 契约的规范化规则
//! 与 FNV-1a 64 指纹：
//! - 只覆盖语义内容（图层树、层内容、蒙版、混合/不透明度/显隐、顺序、变换、画布尺寸）；
//! - 排除视图与交互状态（选区、取景、活动层、工具偏好、撤销栈、保存时间、序列化容器噪声）；
//! - 非法结构返回 `None`（调用方必须当作「无法判定」，绝不当作「无变化」）；
//! - 数值按固定精度取整（1e-4），`-0` 归一化为 `0`，与 JavaScript `String(n)` 输出一致；
//! - 指纹按 **UTF-16 code unit** 迭代，与 JavaScript `charCodeAt` 一致（含中文内容）。
//!
//! 一致性由 `tests/identity_parity.rs` 的固定 fixture 保证（TS 端同 fixture 生成期望值）。

use serde_json::Value;
use std::collections::HashMap;

const POINT_PRECISION: f64 = 1e4;

/// 变量名称、图层引用与数据集名称的长度上限（UTF-16 单元，与协议 `MAX_VARIABLE_NAME_UNITS` 一致）。
const MAX_NAME_UNITS: usize = 200;
/// 数据集替换文本的上限（与协议 `MAX_VARIABLE_TEXT_UNITS` 一致）。
const MAX_TEXT_UNITS: usize = 100_000;
/// 变量/数据集/单集取值上限（与内核预算及协议常量一致）。
const MAX_VARIABLES: usize = 256;
const MAX_DATA_SETS: usize = 1024;
const MAX_VALUES_PER_SET: usize = 512;

/// 与 JavaScript `String(Math.round(value * 1e4) / 1e4)` 一致的数值文本。
///
/// 由内容描述（`features/vectors/content.rs` 的形状外观摘要）复用，避免同一套取整规则
/// 出现第二份实现。
pub(crate) fn js_rounded(value: f64) -> Option<String> {
    if !value.is_finite() {
        return None;
    }
    let scaled = (value * POINT_PRECISION).round();
    let mut rounded = scaled / POINT_PRECISION;
    if !rounded.is_finite() {
        return None;
    }
    if rounded == 0.0 {
        // `Math.round(-0.2 * 1e4) / 1e4` 是 `-0`，`String(-0)` 是 `"0"`。
        rounded = 0.0;
    }
    Some(format_number(rounded))
}

/// `f64` 的 JavaScript `String(number)` 形式（最短往返表示；整数不带小数点）。
fn format_number(value: f64) -> String {
    if value == value.trunc() && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        let mut text = format!("{value}");
        if text.contains('e') || text.contains('E') {
            // JavaScript 用 `1e-7`/`1e+21` 形式；本集成的内容数值不会落到该区间，保守回退。
            text = format!("{value:.6}");
            while text.ends_with('0') {
                text.pop();
            }
            if text.ends_with('.') {
                text.pop();
            }
        }
        text
    }
}

/// FNV-1a 64-bit（16 位小写 hex），按 UTF-16 code unit 迭代。
pub fn fnv1a64_hex(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    for unit in text.encode_utf16() {
        hash ^= u64::from(unit);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// 计算规范文档内容指纹；非法结构返回 `None`。
pub fn content_hash(content: &Value) -> Option<String> {
    canonicalize(content).map(|text| fnv1a64_hex(&text))
}

/// 把内容规范化为确定性文本（与 TS `canonicalizeImageProjectContent` 一致）。
pub fn canonicalize(content: &Value) -> Option<String> {
    let canvas_width = positive_integer(content.get("canvasWidth")?)?;
    let canvas_height = positive_integer(content.get("canvasHeight")?)?;
    let layers = content.get("layers")?.as_array()?;
    if layers.is_empty() {
        return None;
    }
    let mut lines = vec![format!("canvas:{canvas_width}x{canvas_height}")];
    if let Some(value)=content.get("patternContentHash") {
        let hash=value.as_str()?;
        if hash.len()!=16 || !hash.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {return None;}
        lines.push(format!("patterns:{hash}"));
    }
    // 通道摘要与图案摘要同形：16 位小写 hex，缺省表示没有通道（旧身份兼容）。
    if let Some(value)=content.get("channelsContentHash") {
        let hash=value.as_str()?;
        if !is_hash16(hash) {return None;}
        lines.push(format!("channels:{hash}"));
    }
    // 模式行（change: 2026-10-22-add-photocraft-image-mode-workflows，任务 3.2）。
    // 缺省模式返回 `""`，不追加；`None` 表示结构不可判定，整份内容随之不可判定。
    // `canonicalize_mode` 产出的文本已自带 `mode:` 前缀。
    match crate::features::modes::content::canonicalize_mode(content.get("mode")) {
        Some(line) if line.is_empty() => {}
        Some(line) => lines.push(line),
        None => return None,
    }
    // 文档级文字样式表摘要（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
    // 与 `patternContentHash` 同形：内核算出、宿主原样携带并校验格式；空表时本域不写该键。
    if let Some(value)=content.get("textStyles") {
        let hash=value.as_str()?;
        if !is_hash16(hash) {return None;}
        lines.push(format!("textStyles:{hash}"));
    }
    // 文档级路径（已存命名路径 / 工作路径 / 裁切路径）：**可选**后缀，空值整体省略，
    // 因此没有路径的旧工程指纹保持逐字节兼容
    // （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
    lines.push(canonicalize_saved_paths(content.get("paths"))?);
    lines.push(canonicalize_work_path(content.get("workPath"))?);
    lines.push(canonicalize_clipping_path(content.get("clippingPath"))?);
    lines.retain(|line| !line.is_empty());
    let mut count = 0;
    let mut groups=HashMap::new();
    for layer in layers {
        lines.push(canonicalize_layer(layer, 1, &mut count,&mut groups)?);
    }
    // 动画贡献（change: 2026-10-22-add-photocraft-animation-workflows）：只有内容里真的带
    // `animation` 字段时才追加一行。旧工程没有该字段，规范文本逐字节不变、指纹因此保持兼容。
    if let Some(animation) = content.get("animation") {
        lines.push(canonicalize_animation(animation)?);
    }
    // 变量与数据集：省略或空对象保持旧指纹形状；一旦存在就逐项进入文本。
    if let Some(value) = content.get("variables") {
        if !value.is_null() {
            lines.push(canonicalize_variables(value)?);
        }
    }
    Some(lines.join("\n"))
}

/// 动画内容（时间轴 + 视频帧栈）的规范文本，与 TS `canonicalizeAnimationContent` 逐字节一致。
///
/// 字段集只含**内容**：时间轴的 `fps`/`duration`、视频层的 `fps`/`showAltered`/帧栈。播放头与
/// 工作区范围是会话视图，不在此列（与 `animation_content_json` 的取舍一致）。
///
/// 用长度前缀而不是 JSON：条目名可以是任意字符，长度前缀让拼接无歧义，也避免嵌套转义导致
/// 规范文本随深度指数增长（与既有 `group:[len:child]` 的做法一致）。
fn canonicalize_animation(animation: &Value) -> Option<String> {
    let timeline = match animation.get("timeline") {
        None | Some(Value::Null) => "-".to_string(),
        Some(value) => {
            let fps = finite_number(value.get("fps")?)?;
            let duration = positive_integer(value.get("duration")?)?;
            format!("{},{}", js_rounded(fps)?, duration)
        }
    };
    let layers = animation.get("layers")?.as_array()?;
    if layers.len() > photocraft_project_verify::MAX_LAYERS {
        return None;
    }
    let mut entries = String::from("[");
    for layer in layers {
        entries.push_str(&canonicalize_animation_layer(layer)?);
    }
    entries.push(']');
    Some(format!("animation:{timeline}:{}:{entries}", utf16_len(&entries)))
}

/// 一个动画条目：`名字@帧栈[子结条]`，全部带长度前缀。
fn canonicalize_animation_layer(layer: &Value) -> Option<String> {
    let name = layer.get("name")?.as_str()?;
    if utf16_len(name) > 200 {
        return None;
    }
    let video = match layer.get("video") {
        None | Some(Value::Null) => "-".to_string(),
        Some(value) => canonicalize_animation_video(value)?,
    };
    let mut body = format!("{}:{name}@{video}", utf16_len(name));
    match layer.get("children") {
        None | Some(Value::Null) => {}
        Some(Value::Array(children)) => {
            if children.len() > photocraft_project_verify::MAX_LAYERS {
                return None;
            }
            let mut nested = String::from("[");
            for child in children {
                nested.push_str(&canonicalize_animation_layer(child)?);
            }
            nested.push(']');
            body.push_str(&format!("#{}:{nested}", utf16_len(&nested)));
        }
        Some(_) => return None,
    }
    Some(format!("{}:{body}", utf16_len(&body)))
}

/// 一个视频帧栈：`fps,showAltered,帧列表[;原始帧列表]`。
fn canonicalize_animation_video(video: &Value) -> Option<String> {
    let fps = finite_number(video.get("fps")?)?;
    let show_altered = video.get("showAltered")?.as_bool()?;
    let frames = canonicalize_animation_frames(video.get("frames")?)?;
    let mut out = format!("{},{},{}", js_rounded(fps)?, if show_altered { 1 } else { 0 }, frames);
    if let Some(original) = video.get("original") {
        if !original.is_null() {
            out.push(';');
            out.push_str(&canonicalize_animation_frames(original)?);
        }
    }
    Some(out)
}

fn canonicalize_animation_frames(frames: &Value) -> Option<String> {
    let frames = frames.as_array()?;
    if frames.len() > 120 {
        return None;
    }
    let mut out = String::from("[");
    for frame in frames {
        let hash = frame.get("contentHash")?.as_str()?;
        if !is_hash16(hash) {
            return None;
        }
        let width = non_negative_integer(frame.get("width")?)?;
        let height = non_negative_integer(frame.get("height")?)?;
        let format = short_string(frame.get("format")?, 32)?;
        if format.contains(|c: char| c == ',' || c == ';' || c == '[' || c == ']' || c == ':' || c == '@' || c == '#') {
            return None;
        }
        out.push_str(&format!("{hash},{width},{height},{format};"));
    }
    out.push(']');
    Some(format!("{}:{out}", utf16_len(&out)))
}

/// 变量/数据集的规范文本。
///
/// 行格式（与协议 `canonicalizeImageProjectContent` 逐字节一致）：
///
/// ```text
/// variables:[<def>…][<set>…]
/// def|名称|图层 id|种类[|method|align|clip]
/// set|名称|[<值>…]
/// value|变量名|kind|payload
/// ```
///
/// 名称按 UTF-16 长度预置，避免分隔符歧义；未知种类返回 `None`（无法判定 ≠ 无变化）。
fn canonicalize_variables(variables: &Value) -> Option<String> {
    let defs = variables.get("defs")?.as_array()?;
    let data_sets = variables.get("dataSets")?.as_array()?;
    if defs.is_empty() && data_sets.is_empty() {
        return None;
    }
    if defs.len() > MAX_VARIABLES || data_sets.len() > MAX_DATA_SETS {
        return None;
    }
    let mut def_lines = Vec::with_capacity(defs.len());
    for def in defs {
        let name = non_empty_short(def.get("name")?, MAX_NAME_UNITS)?;
        let layer = non_empty_short(def.get("layer")?, 200)?;
        let kind = def.get("type")?.as_str()?;
        let tail = match kind {
            "visibility" | "textReplacement" => String::new(),
            "pixelReplacement" => {
                let method = def.get("method")?.as_str()?;
                if !matches!(method, "fit" | "fill" | "asIs" | "conform") {
                    return None;
                }
                let align = def.get("align")?.as_str()?;
                if !matches!(
                    align,
                    "topLeft" | "topCenter" | "topRight" | "centerLeft" | "center"
                        | "centerRight" | "bottomLeft" | "bottomCenter" | "bottomRight"
                ) {
                    return None;
                }
                let clip = def.get("clip")?.as_bool()?;
                format!("|{method}|{align}|{}", if clip { 1 } else { 0 })
            }
            _ => return None,
        };
        def_lines.push(format!(
            "def|{}:{name}|{}:{layer}|{kind}{tail}",
            utf16_len(name),
            utf16_len(layer)
        ));
    }
    let mut set_lines = Vec::with_capacity(data_sets.len());
    for set in data_sets {
        let name = non_empty_short(set.get("name")?, MAX_NAME_UNITS)?;
        let values = set.get("values")?.as_array()?;
        if values.len() > MAX_VALUES_PER_SET {
            return None;
        }
        let mut value_lines = Vec::with_capacity(values.len());
        for value in values {
            let variable = non_empty_short(value.get("variable")?, MAX_NAME_UNITS)?;
            let kind = value.get("kind")?.as_str()?;
            let payload = value.get("value")?;
            let text = match kind {
                "visibility" => {
                    let show = payload.as_bool()?;
                    format!("{}", if show { 1 } else { 0 })
                }
                "text" => {
                    let body = payload.as_str()?;
                    if utf16_len(body) > MAX_TEXT_UNITS {
                        return None;
                    }
                    format!("{}:{body}", utf16_len(body))
                }
                "pixels" => {
                    let key = non_empty_short(payload, MAX_NAME_UNITS)?;
                    format!("{}:{key}", utf16_len(key))
                }
                _ => return None,
            };
            value_lines.push(format!(
                "value|{}:{variable}|{kind}|{text}",
                utf16_len(variable)
            ));
        }
        set_lines.push(format!(
            "set|{}:{name}|[{}]",
            utf16_len(name),
            value_lines
                .iter()
                .map(|line| format!("{}:{line}", utf16_len(line)))
                .collect::<String>()
        ));
    }
    Some(format!(
        "variables:[{}][{}]",
        def_lines
            .iter()
            .map(|line| format!("{}:{line}", utf16_len(line)))
            .collect::<String>(),
        set_lines
            .iter()
            .map(|line| format!("{}:{line}", utf16_len(line)))
            .collect::<String>()
    ))
}

fn canonicalize_layer(layer: &Value, depth: usize, count: &mut usize,groups:&mut HashMap<u64,String>) -> Option<String> {
    *count += 1;
    if depth > photocraft_project_verify::MAX_DOCUMENT_DEPTH || *count > photocraft_project_verify::MAX_LAYERS {
        return None;
    }
    let id = short_string(layer.get("id")?, 200)?;
    let name = layer.get("name")?.as_str()?;
    if utf16_len(name) > 200 {
        return None;
    }
    let kind = layer.get("kind")?.as_str()?;
    // `artboard` 是带裁切矩形的组（U56）：与组一样参与内容身份，不能因为它是画板就返回 `None`
    // ——那会让整份工程的 hash 计算失败，画板工程既无法导出也无法判断「是否净变化」。
    if !matches!(kind, "pixel" | "text" | "adjustment" | "group" | "artboard" | "smart" | "shape" | "fill") {
        return None;
    }
    let visible = layer.get("visible")?.as_bool()?;
    let opacity = unit(layer.get("opacity")?)?;
    let fill = layer.get("fill").map(unit).unwrap_or(Some(1.0))?;
    let fill = if fill == 1.0 { String::new() } else { format!("|fill:{}", js_rounded(fill)?) };
    let effects = match layer.get("effects") {
        None | Some(Value::Null) => String::new(),
        Some(value) => {
            let enabled=value.get("enabled")?.as_bool()?;
            let hash=value.get("contentHash")?.as_str()?;
            if !is_hash16(hash) {return None;}
            format!("|effects:{}:{hash}", if enabled {1} else {0})
        }
    };
    let blend = layer.get("blend")?.as_str()?;
    // 画板与组一样是容器，因此同样允许 `pass-through`（U56）。
    let kind_is_group = kind == "group" || kind == "artboard";
    if !(photocraft_project_verify::blend_modes::PHOTOSHOP_BLEND_NAMES.contains(&blend) || blend == "pass-through") || (blend == "pass-through" && !kind_is_group) {
        return None;
    }
    let transform = canonicalize_transform(layer.get("transform")?)?;
    let mask_value = layer.get("mask")?;
    let mask = canonicalize_mask(mask_value)?;
    let locks = canonicalize_locks(layer.get("locks"))?;
    let clipped = match layer.get("clipped") {
        None | Some(Value::Bool(false)) => "",
        Some(Value::Bool(true)) => "|clipped",
        _ => return None,
    };
    let pixel = layer.get("pixel")?;
    let text = layer.get("text")?;
    let adjustment = layer.get("adjustment")?;
    let smart=layer.get("smart").unwrap_or(&Value::Null);
    let shape=layer.get("shape").unwrap_or(&Value::Null);
    let fill_layer=layer.get("fillLayer").unwrap_or(&Value::Null);
    let present = [!pixel.is_null(), !text.is_null(), !adjustment.is_null(),!smart.is_null(),!shape.is_null(),!fill_layer.is_null()]
        .into_iter()
        .filter(|present| *present)
        .count();
    let is_group_like = kind == "group" || kind == "artboard";
    if present != if is_group_like { 0 } else { 1 } {
        return None;
    }
    if !is_group_like && layer.get("children").is_some() {
        return None;
    }
    let body = match kind {
        "group" | "artboard" => {
            let children = layer.get("children")?.as_array()?.iter()
                .map(|child| canonicalize_layer(child, depth + 1, count,groups))
                .collect::<Option<Vec<_>>>()?;
            format!("group:[{}]", children.iter().map(|child| format!("{}:{child}", utf16_len(child))).collect::<String>())
        }
        "pixel" => canonicalize_pixel(pixel)?,
        "text" => canonicalize_text(text)?,
        "smart" => {
            let body=canonicalize_smart(smart)?;
            let group=positive_integer(smart.get("contentsGroup")?)?;
            let identity=format!("{}:{}",smart.get("sourceContentHash")?.as_str()?,smart.get("sourceName")?.as_str()?);
            if let Some(previous)=groups.get(&group) {if *previous!=identity {return None;}}
            else {if group!=groups.len() as u64+1 {return None;}groups.insert(group,identity);}
            body
        },
        "shape" => canonicalize_shape(shape)?,
        "fill" => canonicalize_fill(fill_layer)?,
        _ => canonicalize_adjustment(adjustment)?,
    };
    // 矢量蒙版是可选后缀：旧工程没有该字段，指纹因此保持兼容。
    let vector = canonicalize_vector_mask(layer.get("vectorMask"))?;
    Some(
        [
            "layer".to_string(),
            id.to_string(),
            name.to_string(),
            kind.to_string(),
            if visible { "1" } else { "0" }.to_string(),
            js_rounded(opacity)?,
            blend.to_string(),
            transform,
            mask,
            body,
        ]
        .join("|") + &locks + clipped + &fill + &effects + &vector,
    )
}

/// 已存命名路径：`paths:[<UTF-16 长度>:<名字>:<摘要>…]`，按 `(名字, 摘要)` 的码点序稳定排序。
///
/// 省略（`undefined`/`null`）返回空串，保持旧工程指纹不变；结构非法返回 `None`。
fn canonicalize_saved_paths(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else { return Some(String::new()) };
    if value.is_null() {
        return Some(String::new());
    }
    let list = value.as_array()?;
    // 空列表与省略等价：没有已存路径的工程不该因为「空数组 vs 缺字段」而被判成有净变化。
    if list.is_empty() {
        return Some(String::new());
    }
    let mut entries: Vec<(String, String)> = Vec::with_capacity(list.len());
    for entry in list {
        let name = entry.get("name")?.as_str()?;
        if name.trim().is_empty() || name.chars().count() > 200 {
            return None;
        }
        let hash = entry.get("contentHash")?.as_str()?;
        if !is_hash16(hash) {
            return None;
        }
        entries.push((name.to_string(), hash.to_string()));
    }
    entries.sort_by(|left, right| {
        // 与 TypeScript 的 `String` 比较（UTF-16 code unit 序）逐字节一致，而不是 Rust 的 UTF-8 字节序。
        left.0
            .encode_utf16()
            .cmp(right.0.encode_utf16())
            .then_with(|| left.1.cmp(&right.1))
    });
    let body = entries
        .iter()
        .map(|(name, hash)| format!("{}:{name}:{hash}", utf16_len(name)))
        .collect::<String>();
    Some(format!("paths:[{body}]"))
}

/// 工作路径：只有几何摘要（名字恒为内核的工作路径）。
fn canonicalize_work_path(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else { return Some(String::new()) };
    if value.is_null() {
        return Some(String::new());
    }
    let hash = value.get("contentHash")?.as_str()?;
    if !is_hash16(hash) {
        return None;
    }
    Some(format!("work:{hash}"))
}

/// 裁切路径引用：名字 + 平直度（与核验器同一范围 `0..=100`）。
fn canonicalize_clipping_path(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else { return Some(String::new()) };
    if value.is_null() {
        return Some(String::new());
    }
    let name = value.get("name")?.as_str()?;
    if name.trim().is_empty() || name.chars().count() > 200 {
        return None;
    }
    let flatness = finite_number(value.get("flatness")?)?;
    if !(0.0..=100.0).contains(&flatness) {
        return None;
    }
    Some(format!("clip:{}:{name}:{}", utf16_len(name), js_rounded(flatness)?))
}

/// 形状层：路径几何以内容摘要参与身份（几何权威在内核，不在叠加层）。
///
/// `appearanceHash` 是**可选后缀**：填充/描边/规范参数的摘要。省略时只按几何比较，
/// 因此旧内容描述（以及只关心几何的调用方）指纹逐字节不变；本 change 之后内核产出的
/// 形状层总会带上它，改填充或描边会改变指纹（任务 3.2）。
fn canonicalize_shape(shape: &Value) -> Option<String> {
    let hash = shape.get("contentHash")?.as_str()?;
    if !is_hash16(hash) {
        return None;
    }
    let look = match shape.get("appearanceHash") {
        None | Some(Value::Null) => String::new(),
        Some(value) => {
            let appearance = value.as_str()?;
            if !is_hash16(appearance) {
                return None;
            }
            format!(":appearance:{appearance}")
        }
    };
    Some(format!("shape:{hash}{look}"))
}

/// 填充层：参数就是内容（像素只是缓存），逐字段有界并归一化到固定精度。
///
/// 文本格式（与 TS `canonicalizeFillContent` 逐字节一致，`写在前面的长度` 避免分隔符歧义）：
///
/// ```text
/// fill:solid:<#rrggbb>:<alpha>
/// fill:gradient:<style>:<angle>:<scale>:<reverse>:<dither>:<align>:<offsetX>,<offsetY>:[<at>:<#rrggbb>:<alpha>…]:[<at>:<alpha>…]:[<mid>…]
/// fill:pattern:<名称长度>:<名称>:<id 长度>:<id>:<scale>:<angle>:<link>:<phaseX>,<phaseY>
/// ```
///
/// 颜色只取 `#rrggbb` + 单独的 alpha：填充的 `c` 数组在非 RGB 文档里长度不同，直接序列化会
/// 让同一语义颜色在不同模式下产生不同指纹。
fn canonicalize_fill(value: &Value) -> Option<String> {
    let kind = value.get("kind")?.as_str()?;
    let parameters = value.get("parameters")?;
    if parameters.get("kind")?.as_str()? != kind {
        return None;
    }
    match kind {
        "solid" => {
            let color = parameters.get("color")?.as_str()?;
            if !is_hex_color(color) {
                return None;
            }
            Some(format!("fill:solid:{color}:{}", js_rounded(unit(parameters.get("alpha")?)?)?))
        }
        "gradient" => {
            let style = parameters.get("style")?.as_str()?;
            if !matches!(style, "linear" | "radial" | "angle" | "reflected" | "diamond") {
                return None;
            }
            let stops = parameters.get("stops")?.as_array()?;
            if stops.len() < 2 || stops.len() > 1024 {
                return None;
            }
            let mut rendered = Vec::with_capacity(stops.len());
            let mut previous = f64::NEG_INFINITY;
            for stop in stops {
                let at = unit(stop.get("at")?)?;
                if at < previous {
                    return None;
                }
                previous = at;
                let color = stop.get("color")?.as_str()?;
                if !is_hex_color(color) {
                    return None;
                }
                rendered.push(format!("{}:{color}:{}", js_rounded(at)?, js_rounded(unit(stop.get("alpha")?)?)?));
            }
            let opacity = parameters.get("opacityStops")?.as_array()?;
            if opacity.len() > 1024 {
                return None;
            }
            let mut opacities = Vec::with_capacity(opacity.len());
            for stop in opacity {
                opacities.push(format!("{}:{}", js_rounded(unit(stop.get("at")?)?)?, js_rounded(unit(stop.get("alpha")?)?)?));
            }
            let midpoints = parameters.get("midpoints")?.as_array()?;
            if midpoints.len() >= stops.len().max(1) {
                return None;
            }
            let mids: Option<Vec<String>> = midpoints.iter().map(|mid| js_rounded(unit(mid)?)).collect();
            let offset = parameters.get("offset")?.as_array().filter(|offset| offset.len() == 2)?;
            let dx = finite_number(&offset[0])?;
            let dy = finite_number(&offset[1])?;
            if dx.abs() > 1.0e5 || dy.abs() > 1.0e5 {
                return None;
            }
            let scale = finite_number(parameters.get("scale")?)?;
            // 与核验器同一区间：越界内容无法判为「可保存」。
            if !(0.1..=1.5).contains(&scale) {
                return None;
            }
            let angle = finite_number(parameters.get("angle")?)?;
            if !angle.is_finite() {
                return None;
            }
            let reverse = parameters.get("reverse")?.as_bool()?;
            let dither = parameters.get("dither")?.as_bool()?;
            let align = parameters.get("align")?.as_bool()?;
            Some(format!(
                "fill:gradient:{style}:{}:{}:{}:{}:{}:{},{}:[{}]:[{}]:[{}]",
                js_rounded(angle)?,
                js_rounded(scale)?,
                if reverse { 1 } else { 0 },
                if dither { 1 } else { 0 },
                if align { 1 } else { 0 },
                js_rounded(dx)?,
                js_rounded(dy)?,
                rendered.join(";"),
                opacities.join(";"),
                mids?.join(";"),
            ))
        }
        "pattern" => {
            let name = short_string(parameters.get("name")?, 200)?;
            // 图案 **id** 是工程资源键；改名不该改变已应用填充的语义，但换图案必须改变。
            let id = short_string(parameters.get("pattern")?, 200)?;
            let scale = finite_number(parameters.get("scale")?)?;
            if !(scale > 0.0 && scale <= 10.0) {
                return None;
            }
            let angle = finite_number(parameters.get("angle")?)?;
            if !(-360.0..=360.0).contains(&angle) {
                return None;
            }
            let link = parameters.get("link")?.as_bool()?;
            let phase = parameters.get("phase")?.as_array().filter(|phase| phase.len() == 2)?;
            let px = finite_number(&phase[0])?;
            let py = finite_number(&phase[1])?;
            if px.abs() > 1.0e7 || py.abs() > 1.0e7 {
                return None;
            }
            Some(format!(
                "fill:pattern:{}:{name}:{}:{id}:{}:{}:{}:{},{}",
                utf16_len(name),
                utf16_len(id),
                js_rounded(scale)?,
                js_rounded(angle)?,
                if link { 1 } else { 0 },
                js_rounded(px)?,
                js_rounded(py)?,
            ))
        }
        _ => None,
    }
}

/// 矢量蒙版摘要：`""` 表示没有；`None` 表示非法。
fn canonicalize_vector_mask(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else { return Some(String::new()); };
    if value.is_null() {
        return Some(String::new());
    }
    let enabled = value.get("enabled")?.as_bool()?;
    let linked = match value.get("linked") {
        None => true,
        Some(flag) => flag.as_bool()?,
    };
    let hash = value.get("contentHash")?.as_str()?;
    if !is_hash16(hash) {
        return None;
    }
    // 密度/羽化是可选后缀：省略时与旧指纹一致，出现时按 0..=1 / 0..=1000 的同一范围裁定。
    let mut extra = String::new();
    if let Some(density) = value.get("density") {
        if !density.is_null() {
            let amount = finite_number(density)?;
            if !(0.0..=1.0).contains(&amount) {
                return None;
            }
            extra.push_str(&format!(":density:{}", js_rounded(amount)?));
        }
    }
    if let Some(feather) = value.get("feather") {
        if !feather.is_null() {
            let radius = finite_number(feather)?;
            if !(0.0..=1000.0).contains(&radius) {
                return None;
            }
            extra.push_str(&format!(":feather:{}", js_rounded(radius)?));
        }
    }
    Some(format!(
        "|vector:{}:{hash}{}{extra}",
        if enabled { "1" } else { "0" },
        if linked { "" } else { ":unlinked" }
    ))
}

fn canonicalize_locks(value: Option<&Value>) -> Option<String> {
    let Some(value) = value else {return Some(String::new())};
    let locks=value.as_object()?;
    let keys=["transparency","pixels","position","artboard","all"];
    if locks.keys().any(|key| !keys.contains(&key.as_str())) || locks.values().any(|value| !value.is_boolean()) {return None;}
    let flags:String=keys.iter().map(|key|if locks.get(*key).and_then(Value::as_bool)==Some(true) {'1'} else {'0'}).collect();
    Some(if flags.contains('1') {format!("|locks:{flags}")} else {String::new()})
}

fn canonicalize_transform(transform: &Value) -> Option<String> {
    let translate_x = finite_number(transform.get("translateX")?)?;
    let translate_y = finite_number(transform.get("translateY")?)?;
    let scale = finite_number(transform.get("scale")?)?;
    if scale <= 0.0 {
        return None;
    }
    let rotation = finite_number(transform.get("rotationDegrees")?)?;
    let flip_h = transform.get("flipHorizontal")?.as_bool()?;
    let flip_v = transform.get("flipVertical")?.as_bool()?;
    Some(
        [
            js_rounded(translate_x)?,
            js_rounded(translate_y)?,
            js_rounded(scale)?,
            js_rounded(rotation)?,
            if flip_h { "1" } else { "0" }.to_string(),
            if flip_v { "1" } else { "0" }.to_string(),
        ]
        .join(","),
    )
}

/// `"none"` 表示无蒙版；`None` 表示非法。
fn canonicalize_mask(mask: &Value) -> Option<String> {
    if mask.is_null() {
        return Some("none".to_string());
    }
    let enabled = mask.get("enabled")?.as_bool()?;
    let linked = match mask.get("linked") {None => true,Some(value) => value.as_bool()?};
    let origin = mask.get("origin")?.as_str()?;
    if !matches!(origin, "selection" | "paint") {
        return None;
    }
    let hash = mask.get("contentHash")?.as_str()?;
    if !is_hash16(hash) {
        return None;
    }
    Some(format!(
        "mask:{}:{origin}:{hash}{}",
        if enabled { "1" } else { "0" },
        if linked {""} else {":unlinked"}
    ))
}

fn canonicalize_pixel(pixel: &Value) -> Option<String> {
    let source = pixel.get("sourceAssetId")?;
    let source_text = if source.is_null() {
        None
    } else {
        Some(short_string(source, 200)?)
    };
    let hash = pixel.get("contentHash")?.as_str()?;
    if !is_hash16(hash) {
        return None;
    }
    Some(format!("pixel:{}:{hash}", source_text.unwrap_or("-")))
}

fn canonicalize_smart(value:&Value)->Option<String> {
    let object=value.as_object()?;
    let keys=["sourceContentHash","sourceName","contentsGroup","transform"];
    if object.len()!=4 || object.keys().any(|key|!keys.contains(&key.as_str())) {return None;}
    let hash=value.get("sourceContentHash")?.as_str()?;
    if !is_hash16(hash) {return None;}
    let name=short_string(value.get("sourceName")?,200)?;
    if name.chars().any(|c|c.is_control() || matches!(c,'/'|'\\'|':'))
        || !name.rsplit_once('.').is_some_and(|(stem,ext)|!stem.trim_matches(|c:char|(c.is_whitespace() && c!='\u{0085}') || c=='\u{feff}').is_empty() && ext.eq_ignore_ascii_case("pcraft")) {return None;}
    let group=positive_integer(value.get("contentsGroup")?)?;
    if group>photocraft_project_verify::MAX_LAYERS as u64 {return None;}
    let transform=value.get("transform")?.as_array().filter(|a|a.len()==6)?.iter().map(finite_number).collect::<Option<Vec<_>>>()?;
    let det=transform[0]*transform[3]-transform[1]*transform[2];
    if !det.is_finite() || det.abs()<1e-12 {return None;}
    let affine=affine_identity(&transform)?;
    Some(format!("smart:{group}:{hash}:{affine}:{}:{name}",utf16_len(name)))
}
/// 使用 IEEE-754 位而非十进制取整，保留微小剪切；负零与零等价。
pub(crate) fn affine_identity(values:&[f64])->Option<String> {
    values.iter().map(|n|if n.is_finite() {Some((if *n==0.0 {0.0} else {*n}).to_le_bytes().iter().map(|b|format!("{b:02x}")).collect::<String>())} else {None}).collect()
}

fn canonicalize_text(text: &Value) -> Option<String> {
    let body = text.get("text")?.as_str()?;
    if utf16_len(body) > 100_000 {
        return None;
    }
    let family = short_string(text.get("fontFamily")?, 200)?;
    let size = finite_number(text.get("fontSize")?)?;
    if size <= 0.0 {
        return None;
    }
    let color = text.get("color")?.as_str()?;
    if !is_hex_color(color) {
        return None;
    }
    let bold = text.get("bold")?.as_bool()?;
    let align = text.get("align")?.as_str()?;
    if !matches!(align, "left" | "center" | "right") {
        return None;
    }
    let prefix=match text.get("box") {
        None | Some(Value::Null)=>"text".to_string(),
        Some(boxed)=>{
            let values=boxed.as_array().filter(|v|v.len()==4)?;
            let numbers=values.iter().map(finite_number).collect::<Option<Vec<_>>>()?;
            if numbers.iter().any(|n|n.abs()>8192.0) || numbers[2]<=0.0 || numbers[3]<=0.0 {return None;}
            format!("text-box:{}",numbers.into_iter().map(js_rounded).collect::<Option<Vec<_>>>()?.join(","))
        }
    };
    // 排版参数（P7）：省略或取默认值时保持旧指纹文本形状。
    let mut typography: Vec<String> = Vec::new();
    match text.get("leading") {
        None | Some(Value::Null) => {}
        Some(value) => {
            let leading = finite_number(value)?;
            if !(0.0..=5000.0).contains(&leading) {
                return None;
            }
            typography.push(format!("leading:{}", js_rounded(leading)?));
        }
    }
    if let Some(value) = text.get("tracking") {
        let tracking = finite_number(value)?;
        if !(-1000.0..=10000.0).contains(&tracking) {
            return None;
        }
        if tracking != 0.0 {
            typography.push(format!("tracking:{}", js_rounded(tracking)?));
        }
    }
    if let Some(value) = text.get("baselineShift") {
        let baseline = finite_number(value)?;
        if baseline.abs() > 5000.0 {
            return None;
        }
        if baseline != 0.0 {
            typography.push(format!("baseline:{}", js_rounded(baseline)?));
        }
    }
    if let Some(value) = text.get("kerning") {
        let kerning = value.as_str()?;
        if !matches!(kerning, "metrics" | "optical" | "off") {
            return None;
        }
        if kerning != "metrics" {
            typography.push(format!("kerning:{kerning}"));
        }
    }
    // 本 change 新增的排版内容（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
    // 取值与默认值折叠都在 `features/type/content.rs`；这里按同一「可选后缀」约定校验并追加，
    // 缺省时一律不写，旧工程指纹因此保持兼容。
    if let Some(value) = text.get("kern") {
        let kern = finite_number(value)?;
        if !(-1000.0..=1000.0).contains(&kern) {
            return None;
        }
        if kern != 0.0 {
            typography.push(format!("kern:{}", js_rounded(kern)?));
        }
    }
    // 每项都带自己的默认值：与默认值相等时**不写**，这样「显式写成默认」与「不写」
    // 得到同一个指纹（宿主可能显式回填 0/1.2，内核则折叠掉它们）。
    for (key, label, default) in [
        ("firstLineIndent", "indent1", 0.0f64),
        ("startIndent", "indentStart", 0.0),
        ("endIndent", "indentEnd", 0.0),
        ("spaceBefore", "spaceBefore", 0.0),
        ("spaceAfter", "spaceAfter", 0.0),
        ("autoLeading", "autoLeading", 1.2),
    ] {
        if let Some(value) = text.get(key) {
            let number = finite_number(value)?;
            if number.abs() > 5000.0 {
                return None;
            }
            // 段落缩进/段距可以为负（悬挂缩进），但自动行距必须是正数。
            if key == "autoLeading" && number <= 0.0 {
                return None;
            }
            let rounded = js_rounded(number)?;
            if rounded != js_rounded(default)? {
                typography.push(format!("{label}:{rounded}"));
            }
        }
    }
    for (key, label, allowed) in [
        ("paragraphAlign", "paraAlign", &["Left", "Center", "Right", "JustifyLeft", "JustifyCenter", "JustifyRight", "JustifyAll"][..]),
        ("direction", "direction", &["Auto", "Ltr", "Rtl"][..]),
        ("antialias", "antialias", &["None", "Sharp", "Crisp", "Strong", "Smooth", "Windows", "WindowsLcd"][..]),
    ] {
        if let Some(value) = text.get(key) {
            let name = value.as_str()?;
            if !allowed.contains(&name) {
                return None;
            }
            typography.push(format!("{label}:{name}"));
        }
    }
    if let Some(value) = text.get("hyphenate") {
        let hyphenate = value.as_bool()?;
        if hyphenate {
            typography.push("hyphenate:1".to_string());
        }
    }
    if let Some(value) = text.get("styleSheet") {
        let id = positive_integer(value)?;
        typography.push(format!("styleSheet:{id}"));
    }
    // 应用的**字符样式**引用（本域 `type.characterStyle.apply` 写入 `CharStyle::style_sheet`）。
    // 应用样式会把样式的解析值写进 run（例如下划线），但 run 自己的 size/color 可能完全不变；
    // 不摘要这个引用就会「换了样式却不判脏」。样式表定义本身由文档级 `textStyles` 覆盖。
    if let Some(value) = text.get("charStyleSheet") {
        let id = positive_integer(value)?;
        typography.push(format!("charStyleSheet:{id}"));
    }
    if let Some(value) = text.get("features") {
        let features = value.as_array()?;
        if features.len() > 64 {
            return None;
        }
        let mut tags = Vec::with_capacity(features.len());
        for feature in features {
            // 形状是 `tag=value`；tag 是 OpenType 的四字符标记。
            let text = feature.as_str()?;
            let (tag, value) = text.split_once('=')?;
            if tag.len() != 4 || !tag.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return None;
            }
            let value: u16 = value.parse().ok()?;
            tags.push(format!("{tag}={value}"));
        }
        tags.sort();
        typography.push(format!("features:{}", tags.join(",")));
    }
    if let Some(value) = text.get("warp") {
        let style = value.get("style")?.as_str()?;
        if !style.starts_with("warp") || style.len() > 32 {
            return None;
        }
        let bend = finite_number(value.get("value")?)?;
        let horizontal_distortion = finite_number(value.get("horizontalDistortion")?)?;
        let vertical_distortion = finite_number(value.get("verticalDistortion")?)?;
        if [bend, horizontal_distortion, vertical_distortion].iter().any(|n| n.abs() > 1000.0) {
            return None;
        }
        let horizontal = value.get("horizontal")?.as_bool()?;
        typography.push(format!(
            "warp:{style}:{}:{}:{}:{}",
            js_rounded(bend)?,
            js_rounded(horizontal_distortion)?,
            js_rounded(vertical_distortion)?,
            if horizontal { 1 } else { 0 }
        ));
    }
    // 整层字符属性（本域新增）。这些字段在整层写入时只有一个 run，`charRuns` 不会出现，
    // 因此必须由平铺键覆盖；默认值一律折叠，旧工程指纹不变。
    for (key, label, default) in [
        ("weight", "weight", 400.0f64),
        ("horizontalScale", "hScale", 1.0),
        ("verticalScale", "vScale", 1.0),
    ] {
        if let Some(value) = text.get(key) {
            let number = finite_number(value)?;
            if !number.is_finite() || number.abs() > 10_000.0 {
                return None;
            }
            let rounded = js_rounded(number)?;
            if rounded != js_rounded(default)? {
                typography.push(format!("{label}:{rounded}"));
            }
        }
    }
    for (key, label, default) in [
        ("underline", "underline", false),
        ("strikethrough", "strikethrough", false),
        ("italic", "italic", false),
        ("fauxBold", "fauxBold", false),
        ("fauxItalic", "fauxItalic", false),
        ("ligatures", "ligatures", true),
        ("discretionaryLigatures", "dligatures", false),
    ] {
        if let Some(value) = text.get(key) {
            let flag = value.as_bool()?;
            if flag != default {
                typography.push(format!("{label}:{}", if flag { 1 } else { 0 }));
            }
        }
    }
    if let Some(value) = text.get("caps") {
        let name = value.as_str()?;
        if !["Normal", "SmallCaps", "AllCaps"].contains(&name) {
            return None;
        }
        if name != "Normal" {
            typography.push(format!("caps:{name}"));
        }
    }
    if let Some(value) = text.get("language") {
        // `null` = 未指定语言；字符串必须是可打印 ASCII 的有界语言标签。
        match value {
            Value::Null => {}
            Value::String(tag) => {
                if tag.is_empty() || tag.len() > 64 || !tag.bytes().all(|b| b.is_ascii_graphic()) {
                    return None;
                }
                typography.push(format!("language:{tag}"));
            }
            _ => return None,
        }
    }
    if let Some(value) = text.get("fontVariations") {
        let axes = value.as_array()?;
        if axes.len() > 32 {
            return None;
        }
        let mut entries = Vec::with_capacity(axes.len());
        for axis in axes {
            let text = axis.as_str()?;
            let (name, amount) = text.split_once('=')?;
            // 字体轴名是四个 ASCII 字符（`wght`/`wdth`/`opsz`…）。
            if name.is_empty() || name.len() > 4 || !name.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return None;
            }
            let amount: f64 = amount.parse().ok()?;
            if !amount.is_finite() {
                return None;
            }
            entries.push(format!("{name}={amount}"));
        }
        entries.sort();
        typography.push(format!("variations:{}", entries.join("+")));
    }
    // 逐 run 摘要（只用在一层有多个 run 时）：`6;5=tracking:300`。
    //
    // 为什么需要它：`type.setStyle` 的 `range` 可以只改中间几个字符，只写首 run 的平铺字段会让
    // 这类改动不进指纹（用户改完关窗口不会被提示保存）。取值与折叠默认值在
    // `features/type/content.rs`；这里只校验结构与取值域，不二次量化——数值已由产生方按
    // `js_rounded` 的同一精度写好，二次取整反而可能与宿主不一致。
    for (key, is_paragraph) in [("charRuns", false), ("paragraphRuns", true)] {
        if let Some(value) = text.get(key) {
            let runs = canonicalize_runs(value, is_paragraph)?;
            typography.push(format!("{key}={runs}"));
        }
    }
    let suffix = if typography.is_empty() { String::new() } else { format!(":{}", typography.join(":")) };
    Some(
        [
            prefix,
            js_rounded(size)?,
            color.to_string(),
            if bold { "1" } else { "0" }.to_string(),
            align.to_string(),
            family.to_string(),
            body.to_string(),
        ]
        .join(":")
            + &suffix,
    )
}

/// 逐 run 摘要的校验与规范化：`6;5=tracking:300`。
///
/// 结构：`;` 分隔 run，每个 run 是 `len` 或 `len=字段:值,字段:值`。字段集合由字符/段落分别限定，
/// 枚举取值也在这里收敛——非法结构一律返回 `None`（调用方按「无法判定」处理，绝不当作无变化）。
///
/// 规范化只做「拆分再按固定顺序拼回」，不重新量化数值：数值由产生方（`features/type/content.rs`
/// 与宿主 `content.ts`）按同一 `js_rounded` 精度写成文本，再取整反而可能让两侧不一致。
fn canonicalize_runs(value: &Value, paragraph: bool) -> Option<String> {
    /// 每层的 run 数预算：run 数最多是字符数，但对摘要没有意义的碎片不该无限膨胀。
    const MAX_RUNS: usize = 4096;
    let text = value.as_str()?;
    if text.is_empty() || text.len() > 65536 {
        return None;
    }
    let char_keys = [
        "baseline", "caps", "charStyle", "color", "dligatures", "family", "fauxBold",
        "fauxItalic", "features", "hScale", "italic", "kern", "kerning", "language", "leading",
        "ligatures", "size", "strikethrough", "tracking", "underline", "variations", "vScale",
        "weight",
    ];
    let paragraph_keys = [
        "align",
        "autoLeading",
        "direction",
        "hyphenate",
        "indent1",
        "indentEnd",
        "indentStart",
        "spaceAfter",
        "spaceBefore",
        "styleSheet",
    ];
    let keys = if paragraph { &paragraph_keys[..] } else { &char_keys[..] };
    let runs: Vec<&str> = text.split(';').collect();
    if runs.len() > MAX_RUNS {
        return None;
    }
    let mut normalized = Vec::with_capacity(runs.len());
    for run in runs {
        let (len, rest) = match run.split_once('=') {
            Some((len, rest)) => (len, Some(rest)),
            None => (run, None),
        };
        // run 长度是 UTF-8 字节数：非空的十进制整数，且不超过正文上限。
        if len.is_empty() || !len.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let length: u64 = len.parse().ok()?;
        if length > 100_000 {
            return None;
        }
        let Some(rest) = rest else {
            normalized.push(length.to_string());
            continue;
        };
        let mut pairs: Vec<(String, String)> = Vec::new();
        for pair in rest.split(',') {
            let (key, value) = pair.split_once(':')?;
            if !keys.contains(&key) || value.is_empty() {
                return None;
            }
            // 枚举取值收敛到内核枚举名；其余字段是数值，`features` 是 `tag=value` 用 `+` 连接。
            let valid = match key {
                "kerning" => ["metrics", "optical", "off"].contains(&value),
                "align" => [
                    "Left",
                    "Center",
                    "Right",
                    "JustifyLeft",
                    "JustifyCenter",
                    "JustifyRight",
                    "JustifyAll",
                ]
                .contains(&value),
                "direction" => ["Auto", "Ltr", "Rtl"].contains(&value),
                "hyphenate" | "underline" | "strikethrough" | "italic" | "ligatures"
                | "dligatures" | "fauxBold" | "fauxItalic" => ["0", "1"].contains(&value),
                "caps" => ["Normal", "SmallCaps", "AllCaps"].contains(&value),
                "family" => {
                    let chars = value.chars().count();
                    chars > 0 && chars <= 200 && !value.contains('\0')
                }
                "language" => value.len() <= 64 && value.bytes().all(|b| b.is_ascii_graphic()),
                "color" => is_hex_color(value),
                "features" => value.split('+').all(|feature| {
                    feature.split_once('=').is_some_and(|(tag, amount)| {
                        tag.len() == 4
                            && tag.bytes().all(|b| b.is_ascii_alphanumeric())
                            && amount.parse::<u16>().is_ok()
                    })
                }),
                "variations" => value.split('+').all(|axis| {
                    axis.split_once('=').is_some_and(|(name, amount)| {
                        !name.is_empty()
                            && name.len() <= 4
                            && name.bytes().all(|b| b.is_ascii_alphanumeric())
                            && amount.parse::<f64>().is_ok_and(f64::is_finite)
                    })
                }),
                _ => value.parse::<f64>().is_ok_and(f64::is_finite),
            };
            if !valid {
                return None;
            }
            pairs.push((key.to_string(), value.to_string()));
        }
        // 同一 run 内按字段名排序（稳定排序，键相同则保持写入顺序）：顺序不同不该换指纹。
        pairs.sort_by(|a, b| a.0.cmp(&b.0));
        let mut text = String::with_capacity(rest.len());
        for (index, (key, value)) in pairs.iter().enumerate() {
            if index > 0 {
                text.push(',');
            }
            text.push_str(key);
            text.push(':');
            text.push_str(value);
        }
        normalized.push(format!("{length}={text}"));
    }
    Some(normalized.join(";"))
}

fn canonicalize_adjustment(adjustment: &Value) -> Option<String> {
    let kind = adjustment.get("kind")?.as_str()?;
    let parameters = adjustment.get("parameters")?;
    let parameter_kind = parameters.get("kind")?.as_str()?;
    if kind != parameter_kind {
        return None;
    }
    match kind {
        "brightness-contrast" => {
            let brightness = finite_number(parameters.get("brightness")?)?;
            let contrast = finite_number(parameters.get("contrast")?)?;
            Some(format!(
                "adjust:brightness-contrast:{}:{}",
                js_rounded(brightness)?,
                js_rounded(contrast)?
            ))
        }
        "hue-saturation" => {
            let hue = finite_number(parameters.get("hue")?)?;
            let saturation = finite_number(parameters.get("saturation")?)?;
            let lightness = finite_number(parameters.get("lightness")?)?;
            // U42 的新增持久参数**追加**在既有前缀之后，并且只在非默认值时出现：
            // 旧工程（没有 colorize / 六个色域）继续得到逐字节相同的前缀与同一指纹。
            let mut tail = String::new();
            if let Some(value) = parameters.get("colorize")
                && value.as_bool()? {
                tail.push_str(":colorize");
            }
            for (index, key) in ["reds", "yellows", "greens", "cyans", "blues", "magentas"].iter().enumerate() {
                let Some(range) = parameters.get(key) else { continue };
                let hue = finite_number(range.get("hue")?)?;
                let saturation = finite_number(range.get("saturation")?)?;
                let lightness = finite_number(range.get("lightness")?)?;
                let bounds = match range.get("range") {
                    None | Some(Value::Null) => None,
                    Some(value) => {
                        let values = value.as_array().filter(|values| values.len() == 4)?;
                        Some(values.iter().map(|value| finite_number(value)).collect::<Option<Vec<_>>>()?)
                    }
                };
                // 中性色域（没有位移且范围就是该色域的默认四滑杆）等同于「没有这一项」：
                // 投影总是带出六个色域，若把中性项也写进规范串，旧工程的指纹会在重开时漂移。
                let center = 60.0 * index as f64;
                let default_bounds = [center - 45.0, center - 15.0, center + 15.0, center + 45.0];
                let neutral = hue == 0.0
                    && saturation == 0.0
                    && lightness == 0.0
                    && bounds.as_ref().is_none_or(|bounds| {
                        bounds.iter().zip(default_bounds).all(|(a, b)| (*a - b).abs() < 1e-6)
                    });
                if neutral {
                    continue;
                }
                tail.push_str(&format!(
                    ":{key}/{}/{}/{}",
                    js_rounded(hue)?,
                    js_rounded(saturation)?,
                    js_rounded(lightness)?
                ));
                if let Some(bounds) = bounds {
                    let rendered = bounds.iter().map(|value| js_rounded(*value)).collect::<Option<Vec<_>>>()?;
                    tail.push_str(&format!("/{}", rendered.join(",")));
                }
            }
            Some(format!(
                "adjust:hue-saturation:{}:{}:{}{tail}",
                js_rounded(hue)?,
                js_rounded(saturation)?,
                js_rounded(lightness)?
            ))
        }
        "levels" => {
            // 色阶：输入/输出端点与伽马，四通道展开成固定顺序。
            //
            // U41 新增的输出黑/白场只在非默认值时追加（`/outBlack,outWhite`）：旧工程与旧
            // 调整层的规范串因此逐字节不变，已保存的 `documentContentHash` 不会漂移。
            let channel = |name: &str| -> Option<String> {
                let value = parameters.get(name)?;
                let black = finite_number(value.get("inBlack")?)?;
                let gamma = finite_number(value.get("gamma")?)?;
                let white = finite_number(value.get("inWhite")?)?;
                let mut rendered = format!(
                    "{},{},{}",
                    js_rounded(black)?,
                    js_rounded(gamma)?,
                    js_rounded(white)?
                );
                let out_black = value.get("outBlack").and_then(finite_number).unwrap_or(0.0);
                let out_white = value.get("outWhite").and_then(finite_number).unwrap_or(255.0);
                if out_black != 0.0 || out_white != 255.0 {
                    rendered.push_str(&format!(
                        "/{},{}",
                        js_rounded(out_black)?,
                        js_rounded(out_white)?
                    ));
                }
                Some(rendered)
            };
            Some(format!(
                "adjust:levels:{}",
                ["master", "red", "green", "blue"]
                    .iter()
                    .map(|name| channel(name))
                    .collect::<Option<Vec<_>>>()?
                    .join(";")
            ))
        }
        "vibrance" => {
            let vibrance = finite_number(parameters.get("vibrance")?)?;
            let saturation = finite_number(parameters.get("saturation")?)?;
            Some(format!(
                "adjust:vibrance:{}:{}",
                js_rounded(vibrance)?,
                js_rounded(saturation)?
            ))
        }
        "black-white" => {
            let mut weights = Vec::new();
            for key in ["reds", "yellows", "greens", "cyans", "blues", "magentas"] {
                weights.push(js_rounded(finite_number(parameters.get(key)?)?)?);
            }
            let tint = match parameters.get("tint") {
                None | Some(Value::Null) => "-".to_string(),
                Some(value) => short_string(value, 32)?.to_string(),
            };
            Some(format!("adjust:black-white:{}:{tint}", weights.join(",")))
        }
        "curves" => {
            let points = parameters.get("rgb")?.as_array()?;
            if points.is_empty() {
                return None;
            }
            let mut rendered = Vec::with_capacity(points.len());
            for point in points {
                let x = finite_number(point.get("x")?)?;
                let y = finite_number(point.get("y")?)?;
                if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                    return None;
                }
                rendered.push(format!("{},{}", js_rounded(x)?, js_rounded(y)?));
            }
            // U41 的铅笔曲线是持久参数：同一条样条的点模式与铅笔模式不是同一内容。
            // 默认的点模式不追加后缀，旧工程指纹保持不变。
            let pencil = match parameters.get("pencil") {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool()?,
            };
            Some(format!(
                "adjust:curves:{}{}",
                rendered.join(";"),
                if pencil { ":pencil" } else { "" }
            ))
        }
        // U43/U44：新增逐类调整与整条命令。这里只覆盖**保存后会重新读回**的调整层参数；
        // 直接作用于像素的命令没有可重编的层，不进入内容身份。
        "exposure" => {
            let exposure = finite_number(parameters.get("exposure")?)?;
            let offset = finite_number(parameters.get("offset")?)?;
            let gamma = finite_number(parameters.get("gamma")?)?;
            Some(format!(
                "adjust:exposure:{}:{}:{}",
                js_rounded(exposure)?,
                js_rounded(offset)?,
                js_rounded(gamma)?
            ))
        }
        "color-balance" => {
            let tone = |key: &str| -> Option<String> {
                let values = parameters.get(key)?.as_array().filter(|values| values.len() == 3)?;
                let rendered = values
                    .iter()
                    .map(|value| js_rounded(finite_number(value)?))
                    .collect::<Option<Vec<_>>>()?;
                Some(rendered.join(","))
            };
            let preserve = match parameters.get("preserveLuminosity") {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool()?,
            };
            Some(format!(
                "adjust:color-balance:{}:{}:{}:{}",
                tone("shadows")?,
                tone("midtones")?,
                tone("highlights")?,
                if preserve { 1 } else { 0 }
            ))
        }
        "photo-filter" => {
            let color = hex_color_parameter(parameters.get("color")?)?;
            let density = unit_percent(parameters.get("density")?)?;
            let preserve = match parameters.get("preserveLuminosity") {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool()?,
            };
            Some(format!(
                "adjust:photo-filter:{color}:{}:{}",
                js_rounded(density)?,
                if preserve { 1 } else { 0 }
            ))
        }
        "channel-mixer" => {
            let row = |key: &str| -> Option<String> {
                let values = parameters.get(key)?.as_array().filter(|values| values.len() == 4)?;
                let rendered = values
                    .iter()
                    .map(|value| js_rounded(unit_percent(value)?))
                    .collect::<Option<Vec<_>>>()?;
                Some(rendered.join(","))
            };
            let monochrome = match parameters.get("monochrome") {
                None | Some(Value::Null) => false,
                Some(value) => value.as_bool()?,
            };
            Some(format!(
                "adjust:channel-mixer:{}:{}:{}:{}",
                row("red")?,
                row("green")?,
                row("blue")?,
                if monochrome { 1 } else { 0 }
            ))
        }
        "invert" => Some("adjust:invert".to_string()),
        "posterize" => {
            let levels = finite_number(parameters.get("levels")?)?;
            Some(format!("adjust:posterize:{}", js_rounded(levels)?))
        }
        "threshold" => {
            let level = finite_number(parameters.get("level")?)?;
            Some(format!("adjust:threshold:{}", js_rounded(level)?))
        }
        "gradient-map" => {
            let stops = parameters.get("stops")?.as_array()?;
            if !(2..=64).contains(&stops.len()) {
                return None;
            }
            let mut rendered = Vec::with_capacity(stops.len());
            let mut previous = f64::NEG_INFINITY;
            for stop in stops {
                let pair = stop.as_array().filter(|pair| pair.len() == 2)?;
                let position = unit(&pair[0])?;
                if position <= previous {
                    return None;
                }
                previous = position;
                let color = hex_color_parameter(&pair[1])?;
                rendered.push(format!("{},{}", js_rounded(position)?, color));
            }
            let flag = |key: &str| -> Option<bool> {
                match parameters.get(key) {
                    None | Some(Value::Null) => Some(false),
                    Some(value) => value.as_bool(),
                }
            };
            Some(format!(
                "adjust:gradient-map:{}:{}:{}",
                rendered.join(";"),
                if flag("reverse")? { 1 } else { 0 },
                if flag("dither")? { 1 } else { 0 }
            ))
        }
        "selective-color" => {
            let method = parameters.get("method")?.as_str()?;
            if !matches!(method, "relative" | "absolute") {
                return None;
            }
            let mut rendered = Vec::new();
            for key in ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"] {
                let values = parameters.get(key)?.as_array().filter(|values| values.len() == 4)?;
                let row = values
                    .iter()
                    .map(|value| js_rounded(finite_number(value)?))
                    .collect::<Option<Vec<_>>>()?;
                rendered.push(row.join(","));
            }
            Some(format!("adjust:selective-color:{method}:{}", rendered.join(";")))
        }
        _ => None,
    }
}

/// 颜色参数：`"#rrggbb"` 或 `[r, g, b]`（0–1），统一投影成小写十六进制。
fn hex_color_parameter(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return (text.len() == 7 && text.starts_with('#')
            && text[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
            .then(|| text.to_string());
    }
    let triple = value.as_array().filter(|values| values.len() == 3)?;
    let mut channels = [0u8; 3];
    for (index, channel) in triple.iter().enumerate() {
        let value = unit(channel)?;
        channels[index] = (value * 255.0).round() as u8;
    }
    Some(format!("#{:02x}{:02x}{:02x}", channels[0], channels[1], channels[2]))
}

/// 百分比参数：有限数值（通道混合器等按 0.1% 网格保存）。
fn unit_percent(value: &Value) -> Option<f64> {
    let number = finite_number(value)?;
    ((-1e6..=1e6).contains(&number)).then_some(number)
}

fn is_hash16(value: &str) -> bool {
    value.len() == 16 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `true` 时返回数值本身；只接受有限浮点（JSON 里 `1` 与 `1.0` 都是数字）。
fn finite_number(value: &Value) -> Option<f64> {
    let number = value.as_f64()?;
    number.is_finite().then_some(number)
}

fn positive_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 || number.fract() != 0.0 {
        return None;
    }
    Some(number as u64)
}

/// 允许 `0` 的非负整数（空帧的 `content_bounds()` 宽高就是 0）。
fn non_negative_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number < 0.0 || number.fract() != 0.0 {
        return None;
    }
    Some(number as u64)
}

fn unit(value: &Value) -> Option<f64> {
    let number = finite_number(value)?;
    (0.0..=1.0).contains(&number).then_some(number)
}

fn short_string(value: &Value, max: usize) -> Option<&str> {
    let text = value.as_str()?;
    (!text.is_empty() && utf16_len(text) <= max).then_some(text)
}

/// 变量相关字段的「非空 + UTF-16 长度」检查（与协议 `isNonEmptyShortString` 一致）。
fn non_empty_short(value: &Value, max: usize) -> Option<&str> {
    short_string(value, max)
}

/// UTF-16 code unit 数（与 JavaScript `String.prototype.length` 一致）。
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
#[path = "identity/tests.rs"]
mod tests;
