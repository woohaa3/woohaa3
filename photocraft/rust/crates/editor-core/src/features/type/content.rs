//! 文字域对**内容身份**的贡献（change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
//!
//! 共享的 `document_content.rs` 只负责把各域的功能拼进「内容描述」；具体摘要哪些字段属本域。
//! 这里提供三个函数：
//!
//! - [`hex_color`]：共享摘要一直在用的颜色格式化（颜色本身属 P0 文字内容）；
//! - [`attach_typography`]：单个文字层的排版摘要（首 run 的平铺字段、多 run 时的逐 run 摘要、
//!   Warp、抗锯齿）；
//! - [`text_styles_digest`]：文档级样式表的摘要（字符/段落样式的内容与顺序）。
//!
//! ## 为什么既写「首 run 平铺字段」又写「逐 run 摘要」
//!
//! `leading`/`tracking`/`baselineShift`/`kerning` 四个平铺字段是上游 P7 就有的形状，宿主类型
//! `ImageProjectTextContent` 已按它们建模，不能删。
//!
//! 但只有首 run 就会漏掉真实缺陷：上游 `type.setStyle` 接受 `range: [start, end]`，可以只改中间
//! 几个字符。只看首 run 时「选中第 6–11 个字符改字距」既不改变指纹、也不把工程判脏——用户改完
//! 关掉窗口不会被提示保存。所以当一层有**多个** run 且至少一个 run 不是默认排版时，额外写
//! `charRuns`/`paragraphRuns`：**每 run 的长度 + 非默认字段**，`;` 连接、字段之间 `,`、
//! 字段内 `:`（如 `6;5=tracking:300`）。
//!
//! 单个 run 时不写这两个字段：平铺字段已经完整描述该层，指纹也保持短。
//!
//! ## 为什么默认值必须折叠成「不写字段」
//!
//! 旧工程没有这些字段，它们的指纹必须逐字节保持原样。所以：
//!
//! - 平铺字段只在与默认值不同（`leading` 与 `null` 不同）时才写；
//! - 整层**所有 run 都是默认**时不写 `charRuns`/`paragraphRuns`；
//! - 样式表为空（只有默认 Basic Paragraph）时不写 `textStyles`。
//!
//! 这样一个从未碰过排版的工程得到的摘要与加这个功能之前完全一致——
//! `typography-project-compat.mjs` 用真实工程验证了这一点。
//!
//! ## 与宿主侧的对应
//!
//! 宿主侧实现在 `packages/protocol/src/features/type/content.ts`（`canonicalizeText`）与
//! `packages/protocol/src/features/shared/content.ts`（`canonicalizeImageProjectContent`）。
//! 两侧**字段集合与拼接顺序必须一致**，否则同一份工程在宿主与内核之间会得出不同的「是否改动」
//! 结论；`type-identity.test.ts` 用本文件源码作对照断言，
//! `tests/fixtures/contract.json` 的两组 `contentHashes.typography*` / `typographyRuns*`
//! 则要求两侧复现同一串文本。
//!
//! 本文件只负责**取值与折叠默认值**；范围校验留在 `identity.rs`（内核）与 `content.ts`（宿主），
//! 参数校验留在 `params.rs`。三层各管一件事，避免同一规则写三份。

use serde_json::{json, Map, Value};

pub(super) fn hex_color(color: photocraft_doc::Color) -> String {
    let [r, g, b] = color.to_rgb();
    format!(
        "#{:02x}{:02x}{:02x}",
        (r.clamp(0.0, 1.0) * 255.0).round() as u8,
        (g.clamp(0.0, 1.0) * 255.0).round() as u8,
        (b.clamp(0.0, 1.0) * 255.0).round() as u8
    )
}

/// 与 `identity.rs` 的 `js_rounded` 同一量化：4 位小数，整数值不带小数点。
///
/// 两处必须给出同一个字符串，否则一侧写 `38`、另一侧写 `38.0`，同一排版会被判成两种内容。
fn num(value: f32) -> String {
    let value = f64::from(value);
    if !value.is_finite() {
        // 非有限值不该走到这里（校验层已拒绝）。写 `0` 而不是 NaN：serde_json 不接受 NaN。
        return "0".to_string();
    }
    let rounded = (value * 1e4).round() / 1e4;
    if rounded == rounded.trunc() && rounded.abs() < 1e15 {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

fn kind_name(kind: photocraft_doc::text::Kerning) -> &'static str {
    match kind {
        photocraft_doc::text::Kerning::Metrics => "metrics",
        photocraft_doc::text::Kerning::Optical => "optical",
        photocraft_doc::text::Kerning::Off => "off",
    }
}

fn align_name(align: photocraft_doc::text::TextAlign) -> &'static str {
    use photocraft_doc::text::TextAlign as A;
    match align {
        A::Left => "Left",
        A::Center => "Center",
        A::Right => "Right",
        A::JustifyLeft => "JustifyLeft",
        A::JustifyCenter => "JustifyCenter",
        A::JustifyRight => "JustifyRight",
        A::JustifyAll => "JustifyAll",
    }
}

fn direction_name(direction: photocraft_doc::text::TextDirection) -> &'static str {
    use photocraft_doc::text::TextDirection as D;
    match direction {
        D::Auto => "Auto",
        D::Ltr => "Ltr",
        D::Rtl => "Rtl",
    }
}

fn caps_name(caps: photocraft_doc::text::Caps) -> &'static str {
    use photocraft_doc::text::Caps as C;
    match caps {
        C::Normal => "Normal",
        C::SmallCaps => "SmallCaps",
        C::AllCaps => "AllCaps",
    }
}

fn antialias_name(antialias: photocraft_doc::text::AntiAlias) -> &'static str {
    use photocraft_doc::text::AntiAlias as A;
    match antialias {
        A::None => "None",
        A::Sharp => "Sharp",
        A::Crisp => "Crisp",
        A::Strong => "Strong",
        A::Smooth => "Smooth",
        A::Windows => "Windows",
        A::WindowsLcd => "WindowsLcd",
    }
}

/// 单个字符 run 的非默认排版，`字段:值` 形式。空 `Vec` 表示这一 run 与层摘要一致。
///
/// `base` 是层的字体族/字号/颜色（与 `TextLayer::char_runs()` 的基线同构，其余字段取默认值）。
/// 这三项只在**本 run 与层不同**时写入：整层一致时平铺的 `fontFamily`/`fontSize`/`color` 已经覆盖，
/// 但范围级改字号/颜色/字体（`type.setStyle` 的 `size`/`color`/`font` 带 `range`）会让 run 与层
/// 不同，不写就会「改了中间一段却判不出脏」。
fn char_parts(style: &photocraft_doc::text::CharStyle, base: &photocraft_doc::text::CharStyle) -> Vec<String> {
    let default = photocraft_doc::text::CharStyle::default();
    let mut parts = Vec::new();
    if style.font_family != base.font_family {
        parts.push(format!("family:{}", style.font_family));
    }
    if style.size_pt != base.size_pt {
        parts.push(format!("size:{}", num(style.size_pt)));
    }
    // 颜色用与 `hex_color` 相同的 `#rrggbb`：十进制三元组既难读又容易在不同端拼出不同文本。
    let color = hex_color(style.color);
    if color != hex_color(base.color) {
        parts.push(format!("color:{color}"));
    }
    if style.weight != base.weight {
        parts.push(format!("weight:{}", style.weight));
    }
    if style.italic != base.italic {
        parts.push(format!("italic:{}", if style.italic { "1" } else { "0" }));
    }
    if let Some(leading) = style.leading_pt {
        parts.push(format!("leading:{}", num(leading)));
    }
    if style.tracking != default.tracking {
        parts.push(format!("tracking:{}", num(style.tracking)));
    }
    if style.baseline_shift_pt != default.baseline_shift_pt {
        parts.push(format!("baseline:{}", num(style.baseline_shift_pt)));
    }
    if style.kerning != default.kerning {
        parts.push(format!("kerning:{}", kind_name(style.kerning)));
    }
    // 手工字偶距（`kernPair` 写的就是它）与 OpenType 开关同样改变重排结果。
    if style.kern != default.kern {
        parts.push(format!("kern:{}", num(style.kern)));
    }
    if !style.features.is_empty() {
        // 按 `tag=value` 排序后写入：同一组开关不因顺序不同而换指纹。
        let mut features: Vec<String> = style
            .features
            .iter()
            .map(|feature| format!("{}={}", feature.tag, feature.value))
            .collect();
        features.sort();
        parts.push(format!("features:{}", features.join("+")));
    }
    if style.underline != default.underline {
        parts.push(format!("underline:{}", if style.underline { "1" } else { "0" }));
    }
    if style.strikethrough != default.strikethrough {
        parts.push(format!("strikethrough:{}", if style.strikethrough { "1" } else { "0" }));
    }
    // 伪粗体/伪斜体：上游按 `embolden`/`skew` 合成字形，范围级写入只影响中间几个字符，
    // 平铺键只看得到首 run——漏掉这两项会让「给一段字符加伪粗体」既不换指纹也不判脏（实测过）。
    if style.faux_bold != default.faux_bold {
        parts.push(format!("fauxBold:{}", if style.faux_bold { "1" } else { "0" }));
    }
    if style.faux_italic != default.faux_italic {
        parts.push(format!("fauxItalic:{}", if style.faux_italic { "1" } else { "0" }));
    }
    if style.horizontal_scale != default.horizontal_scale {
        parts.push(format!("hScale:{}", num(style.horizontal_scale)));
    }
    if style.vertical_scale != default.vertical_scale {
        parts.push(format!("vScale:{}", num(style.vertical_scale)));
    }
    if style.caps != default.caps {
        parts.push(format!("caps:{}", caps_name(style.caps)));
    }
    if style.ligatures != default.ligatures {
        parts.push(format!("ligatures:{}", if style.ligatures { "1" } else { "0" }));
    }
    if style.discretionary_ligatures != default.discretionary_ligatures {
        parts.push(format!("dligatures:{}", if style.discretionary_ligatures { "1" } else { "0" }));
    }
    if style.language != default.language {
        parts.push(format!("language:{}", style.language.as_deref().unwrap_or("")));
    }
    if style.variations != default.variations {
        // 轴名排序后写入：同一组轴设置不因顺序不同而换指纹。
        let mut axes: Vec<String> = style
            .variations
            .iter()
            .map(|variation| format!("{}={}", variation.axis, num(variation.value)))
            .collect();
        axes.sort();
        parts.push(format!("variations:{}", axes.join("+")));
    }
    // 应用的**字符样式**引用属内容：上游应用样式时把样式的解析值写进 run（例如下划线），
    // 但 run 自己的 size/color 可能不变——只看别的字段会「换了样式却不判脏」。
    // 样式表的定义本身由文档级 `textStyles` 摘要覆盖。
    if let Some(id) = style.style_sheet {
        parts.push(format!("charStyle:{id}"));
    }
    parts
}

/// 单个段落 run 的非默认排版。空 `Vec` 表示这一段落全是默认样式。
fn paragraph_parts(style: &photocraft_doc::text::ParagraphStyle) -> Vec<String> {
    let default = photocraft_doc::text::ParagraphStyle::default();
    let mut parts = Vec::new();
    if style.align != default.align {
        parts.push(format!("align:{}", align_name(style.align)));
    }
    for (label, value, base) in [
        ("indent1", style.first_line_indent_pt, default.first_line_indent_pt),
        ("indentStart", style.start_indent_pt, default.start_indent_pt),
        ("indentEnd", style.end_indent_pt, default.end_indent_pt),
        ("spaceBefore", style.space_before_pt, default.space_before_pt),
        ("spaceAfter", style.space_after_pt, default.space_after_pt),
        ("autoLeading", style.auto_leading, default.auto_leading),
    ] {
        if value != base {
            parts.push(format!("{label}:{}", num(value)));
        }
    }
    if style.direction != default.direction {
        parts.push(format!("direction:{}", direction_name(style.direction)));
    }
    if style.hyphenate != default.hyphenate {
        parts.push(format!("hyphenate:{}", if style.hyphenate { "1" } else { "0" }));
    }
    // 应用了哪个段落样式会改变重排结果，因此属于内容。
    if let Some(id) = style.style_sheet {
        parts.push(format!("styleSheet:{id}"));
    }
    parts
}

/// `len` / `len=字段:值,字段:值` 形式的逐 run 摘要，`;` 连接。
///
/// 只有**多个 run 且至少一个 run 不是默认排版**时才返回 `Some`：单 run 的层由平铺字段描述；
/// 多个 run 但排版全默认（例如把范围排版改回默认留下的 run 碎片）在语义上等同单个默认 run，
/// 也不能写字段，否则「改回原样」会被误判成改动。
fn runs_summary(runs: Vec<(usize, Vec<String>)>) -> Option<String> {
    if runs.len() < 2 || runs.iter().all(|(_, parts)| parts.is_empty()) {
        return None;
    }
    let summaries: Vec<String> = runs
        .into_iter()
        .map(|(len, parts)| {
            if parts.is_empty() {
                len.to_string()
            } else {
                format!("{len}={}", parts.join(","))
            }
        })
        .collect();
    Some(summaries.join(";"))
}

/// 把首 run 的排版写成平铺字段；与默认值相同（`leading` 与 `null` 相同）时不写任何键。
///
/// 折叠放在这里而不是留给 `identity.rs`：摘要对象本身就是宿主可见的「内容描述」，
/// 写满默认值只会让每次桥调用都多背一份无用字段。
fn attach_flat_char(summary: &mut Map<String, Value>, style: &photocraft_doc::text::CharStyle) {
    let default = photocraft_doc::text::CharStyle::default();
    if let Some(leading) = style.leading_pt {
        summary.insert("leading".into(), json!(leading));
    }
    if style.tracking != default.tracking {
        summary.insert("tracking".into(), json!(style.tracking));
    }
    if style.baseline_shift_pt != default.baseline_shift_pt {
        summary.insert("baselineShift".into(), json!(style.baseline_shift_pt));
    }
    if style.kerning != default.kerning {
        summary.insert("kerning".into(), json!(kind_name(style.kerning)));
    }
    if style.kern != default.kern {
        summary.insert("kern".into(), json!(style.kern));
    }
    if !style.features.is_empty() {
        let mut features: Vec<String> = style
            .features
            .iter()
            .map(|feature| format!("{}={}", feature.tag, feature.value))
            .collect();
        features.sort();
        summary.insert("features".into(), json!(features));
    }
    // 应用的**字符样式**引用属内容：应用样式会把样式的解析值写进 run（例如下划线），
    // 但 run 的 size/color 可能完全不变，只靠其它字段会「换了样式却不判脏」。
    if let Some(id) = style.style_sheet {
        summary.insert("charStyleSheet".into(), json!(id));
    }
    // 其余字符属性：整层写入时只有一个 run，`charRuns` 不会出现，必须由平铺字段覆盖，
    // 否则「整层加下划线/改缩放」既不换指纹也不判脏（实测过）。
    // 逐项写成字面键：`type-identity.test.ts` 用字面量键核对两侧字段集合，
    // 变量键会让「少写一项」静默通过。
    if style.underline != default.underline {
        summary.insert("underline".into(), json!(style.underline));
    }
    if style.strikethrough != default.strikethrough {
        summary.insert("strikethrough".into(), json!(style.strikethrough));
    }
    if style.italic != default.italic {
        summary.insert("italic".into(), json!(style.italic));
    }
    if style.faux_bold != default.faux_bold {
        summary.insert("fauxBold".into(), json!(style.faux_bold));
    }
    if style.faux_italic != default.faux_italic {
        summary.insert("fauxItalic".into(), json!(style.faux_italic));
    }
    if style.weight != default.weight {
        summary.insert("weight".into(), json!(style.weight));
    }
    if style.horizontal_scale != default.horizontal_scale {
        summary.insert("horizontalScale".into(), json!(style.horizontal_scale));
    }
    if style.vertical_scale != default.vertical_scale {
        summary.insert("verticalScale".into(), json!(style.vertical_scale));
    }
    if style.caps != default.caps {
        summary.insert("caps".into(), json!(caps_name(style.caps)));
    }
    if style.ligatures != default.ligatures {
        summary.insert("ligatures".into(), json!(style.ligatures));
    }
    if style.discretionary_ligatures != default.discretionary_ligatures {
        summary.insert("discretionaryLigatures".into(), json!(style.discretionary_ligatures));
    }
    if style.language != default.language {
        summary.insert("language".into(), json!(style.language));
    }
    if style.variations != default.variations {
        let mut axes: Vec<String> = style
            .variations
            .iter()
            .map(|variation| format!("{}={}", variation.axis, num(variation.value)))
            .collect();
        axes.sort();
        summary.insert("fontVariations".into(), json!(axes));
    }
}

/// 把首段落 run 的排版写成平铺字段；全部为默认时不写任何键。
fn attach_flat_paragraph(
    summary: &mut Map<String, Value>,
    style: &photocraft_doc::text::ParagraphStyle,
) {
    let default = photocraft_doc::text::ParagraphStyle::default();
    // 逐项列出来而不是走元组循环：`type-identity.test.ts` 用字面量键核对两侧字段集合，
    // 变量键会让「少写一项」静默通过。
    if style.first_line_indent_pt != default.first_line_indent_pt {
        summary.insert("firstLineIndent".into(), json!(style.first_line_indent_pt));
    }
    if style.start_indent_pt != default.start_indent_pt {
        summary.insert("startIndent".into(), json!(style.start_indent_pt));
    }
    if style.end_indent_pt != default.end_indent_pt {
        summary.insert("endIndent".into(), json!(style.end_indent_pt));
    }
    if style.space_before_pt != default.space_before_pt {
        summary.insert("spaceBefore".into(), json!(style.space_before_pt));
    }
    if style.space_after_pt != default.space_after_pt {
        summary.insert("spaceAfter".into(), json!(style.space_after_pt));
    }
    if style.auto_leading != default.auto_leading {
        summary.insert("autoLeading".into(), json!(style.auto_leading));
    }
    if style.align != default.align {
        summary.insert("paragraphAlign".into(), json!(align_name(style.align)));
    }
    if style.direction != default.direction {
        summary.insert("direction".into(), json!(direction_name(style.direction)));
    }
    if style.hyphenate != default.hyphenate {
        summary.insert("hyphenate".into(), json!(style.hyphenate));
    }
    if let Some(id) = style.style_sheet {
        summary.insert("styleSheet".into(), json!(id));
    }
}

/// 把本域排版字段写进文字层的摘要对象。
///
/// 取的是上游的**规范化** run 视图（`char_runs()` / `paragraph_runs()`），不是原始数组：空数组
/// 表示「整层一个默认 run」，直接读原始数组会漏掉内核刚写进去的排版。
pub(super) fn attach_typography(summary: &mut Value, text: &photocraft_doc::TextLayer) {
    let Some(object) = summary.as_object_mut() else {
        return;
    };
    // 与 `TextLayer::char_runs()` 的基线同构：层摘要里的字体族/字号/颜色 + 其余默认值。
    let base = photocraft_doc::text::CharStyle {
        font_family: text.font_family.clone(),
        size_pt: text.size_pt,
        color: text.color,
        ..Default::default()
    };
    let chars = text.char_runs();
    if let Some(first) = chars.first() {
        attach_flat_char(object, &first.style);
    }
    if let Some(runs) = runs_summary(
        chars
            .iter()
            .map(|run| (run.len, char_parts(&run.style, &base)))
            .collect(),
    ) {
        object.insert("charRuns".into(), json!(runs));
    }

    let paragraphs = text.paragraph_runs();
    if let Some(first) = paragraphs.first() {
        attach_flat_paragraph(object, &first.style);
    }
    if let Some(runs) = runs_summary(
        paragraphs
            .iter()
            .map(|run| (run.len, paragraph_parts(&run.style)))
            .collect(),
    ) {
        object.insert("paragraphRuns".into(), json!(runs));
    }

    // Warp 与抗锯齿：只有设置过才写，默认（无变形 / Smooth）不进指纹。
    if let Some(warp) = &text.warp {
        object.insert(
            "warp".into(),
            json!({
                "style": warp.style,
                "value": warp.value,
                "horizontal": warp.horizontal,
                "horizontalDistortion": warp.horizontal_distortion,
                "verticalDistortion": warp.vertical_distortion,
            }),
        );
    }
    if text.antialias != photocraft_doc::text::AntiAlias::default() {
        object.insert("antialias".into(), json!(antialias_name(text.antialias)));
    }
}

/// 文档级样式表摘要：内容与顺序都进入指纹，返回 16 位十六进制。
///
/// 为什么必须进指纹：`type.characterStyle.set` / `type.paragraphStyle.redefine` 改的是
/// **样式表本身**，而每个引用了它的文字层看起来毫无变化——不摘要样式表，用户改完样式看不到
/// 「已改动」，关窗口时也不会被提示保存。宿主不建模样式表，因此与 `patternContentHash` 一样
/// 由内核算出、宿主原样携带并校验格式。
///
/// 空表（只有默认 Basic Paragraph）返回 `None`，旧工程指纹不变。
pub(super) fn text_styles_digest(
    styles: &photocraft_doc::text_styles::TextStyles,
) -> Option<String> {
    // 与 `TextStyles::default()` 比而不是与 `ParagraphStyleDef::default()` 比：后者 name 为空，
    // 真实默认的 Basic Paragraph 叫 "Basic Paragraph"，否则每个新文档都会带上一份空摘要。
    let default = photocraft_doc::text_styles::TextStyles::default();
    if styles.character.is_empty()
        && styles.paragraph.is_empty()
        && styles.basic == default.basic
    {
        return None;
    }
    // `serde_json::Map` 按键排序，因此同一张表永远得到同一串字节。
    // 不含 `psd_raw`：那是原样保留的 PSD 数据，不由本域编辑。
    let value = json!({
        "character": styles.character,
        "paragraph": styles.paragraph,
        "basic": styles.basic,
    });
    let text = serde_json::to_string(&value).ok()?;
    Some(crate::identity::fnv1a64_hex(&text))
}
