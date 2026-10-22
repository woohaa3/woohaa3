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

/// 与 JavaScript `String(Math.round(value * 1e4) / 1e4)` 一致的数值文本。
fn js_rounded(value: f64) -> Option<String> {
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
    let mut count = 0;
    let mut groups=HashMap::new();
    for layer in layers {
        lines.push(canonicalize_layer(layer, 1, &mut count,&mut groups)?);
    }
    Some(lines.join("\n"))
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
    if !matches!(kind, "pixel" | "text" | "adjustment" | "group" | "smart") {
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
    if !(photocraft_project_verify::blend_modes::PHOTOSHOP_BLEND_NAMES.contains(&blend) || blend == "pass-through") || (blend == "pass-through" && kind != "group") {
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
    let present = [!pixel.is_null(), !text.is_null(), !adjustment.is_null(),!smart.is_null()]
        .into_iter()
        .filter(|present| *present)
        .count();
    if present != if kind == "group" { 0 } else { 1 } {
        return None;
    }
    if kind != "group" && layer.get("children").is_some() {
        return None;
    }
    let body = match kind {
        "group" => {
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
        _ => canonicalize_adjustment(adjustment)?,
    };
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
        .join("|") + &locks + clipped + &fill + &effects,
    )
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
        .join(":"),
    )
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
            Some(format!(
                "adjust:hue-saturation:{}:{}:{}",
                js_rounded(hue)?,
                js_rounded(saturation)?,
                js_rounded(lightness)?
            ))
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
            Some(format!("adjust:curves:{}", rendered.join(";")))
        }
        _ => None,
    }
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

fn unit(value: &Value) -> Option<f64> {
    let number = finite_number(value)?;
    (0.0..=1.0).contains(&number).then_some(number)
}

fn short_string(value: &Value, max: usize) -> Option<&str> {
    let text = value.as_str()?;
    (!text.is_empty() && utf16_len(text) <= max).then_some(text)
}

/// UTF-16 code unit 数（与 JavaScript `String.prototype.length` 一致）。
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
#[path = "identity/tests.rs"]
mod tests;
