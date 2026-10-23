use super::*;

/// 文字层的持久内容核验：重开时字号、变换与段落行距必须是可用的有限值。
///
/// 上游解析器已保证结构合法，本域补的是**渲染与重排的前提**：
/// - 字号必须是正有限值（0 或 NaN 会在重排时除零，或写出非法 PSD 尺寸）；
/// - 图层变换矩阵必须全部有限（否则合成结果为 NaN 像素）；
/// - 段落 run 的自动行距比例必须为正（内核用 `size × auto_leading` 算行距）。
///
/// 竖排与沿路径排字在能力层关闭；这里不把「未来可能实现」当作可接受内容。
/// 字体的**是否安装**不在此判定：缺字体是可用状态（有替代字族），由文字域命令报告，
/// 核验器不因机器缺字体就拒绝一份合法工程。
pub(super) fn inspect(layer: &photocraft_doc::Layer, _depth: usize, out: &mut LayerInspection, _embedded_smart: bool) -> Option<Result<(), VerifyError>> {
    match &layer.content {
        LayerContent::Text(text) => Some((|| {
            if !text.size_pt.is_finite() || text.size_pt <= 0.0 {
                return Err(err(VerifyErrorCode::UnsupportedObject, "文字层字号必须是正有限值"));
            }
            if !text.transform.m.iter().all(|value| value.is_finite()) {
                return Err(err(VerifyErrorCode::UnsupportedObject, "文字层变换含非有限值"));
            }
            for run in &text.runs {
                if !run.style.size_pt.is_finite() || run.style.size_pt <= 0.0 {
                    return Err(err(VerifyErrorCode::UnsupportedObject, "文字 run 字号必须是正有限值"));
                }
                if !run.style.tracking.is_finite() || !(-1000.0..=10000.0).contains(&run.style.tracking) {
                    return Err(err(VerifyErrorCode::UnsupportedObject, "文字 run 字距超出 -1000–10000"));
                }
            }
            for run in &text.paragraphs {
                if !run.style.auto_leading.is_finite() || run.style.auto_leading <= 0.0 {
                    return Err(err(VerifyErrorCode::UnsupportedObject, "段落 run 的自动行距比例必须是正有限值"));
                }
            }
            out.kinds.insert("text".into());
            Ok(())
        })()),
        _ => None,
    }
}

/// 文档级文字样式表核验：id、名称、数量与 run 引用必须自洽。
///
/// **为什么必须是文档级**：`text_styles` 挂在 `Document` 上而不是图层上，逐层 `inspect`
/// 拿不到它，因此悬空样式引用与样式表预算只能在 `verify_container_with` 里检查。
/// 钩子位置见 `project-verify/src/lib.rs` 中 `inspect_layers` 之后的那一行
/// （change: 2026-10-22-add-photocraft-typography-workflows，任务 3.2）。
///
/// 预算在这里而不是共享 `limits.rs`：只有文字域用得到这两个上限，且它们属于本域内容面
/// 的规格，不该让所有域的共享限额文件背这个数字。
const MAX_STYLE_NAME_CHARS: usize = 200;
const MAX_STYLE_ID: u32 = 1 << 24;
/// 单份工程的字符/段落样式表条目上限（各自计）。超出的工程在解码前就被拒绝，
/// 避免样式表把内存与面板渲染拖垮。
const MAX_STYLES: usize = 256;

pub(crate) fn inspect_document(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
    let styles = &document.text_styles;
    if !style_names_ok(&styles.basic.name) {
        return Err(err(VerifyErrorCode::UnsupportedObject, "Basic Paragraph 样式名非法"));
    }
    if styles.character.len() > MAX_STYLES || styles.paragraph.len() > MAX_STYLES {
        return Err(err(
            VerifyErrorCode::TooManyLayers,
            format!(
                "样式表条目超过上限：字符 {} / 段落 {} > {MAX_STYLES}",
                styles.character.len(),
                styles.paragraph.len()
            ),
        ));
    }
    let mut character = std::collections::HashSet::new();
    for style in &styles.character {
        if style.id == 0 || style.id > MAX_STYLE_ID || !character.insert(style.id) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "字符样式 id 非法或重复"));
        }
        if !style_names_ok(&style.name) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "字符样式名非法"));
        }
    }
    let mut paragraph = std::collections::HashSet::new();
    for style in &styles.paragraph {
        if style.id == 0 || style.id > MAX_STYLE_ID || !paragraph.insert(style.id) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "段落样式 id 非法或重复"));
        }
        if !style_names_ok(&style.name) {
            return Err(err(VerifyErrorCode::UnsupportedObject, "段落样式名非法"));
        }
    }
    // 悬空引用：run 指向的样式必须在表里。
    for (_, _, layer) in document.walk() {
        let photocraft_doc::LayerContent::Text(text) = &layer.content else { continue };
        for run in &text.runs {
            if let Some(id) = run.style.style_sheet
                && !styles.character.iter().any(|style| style.id == id)
            {
                return Err(err(VerifyErrorCode::UnsupportedObject, format!("文字 run 引用了不存在的字符样式 {id}")));
            }
        }
        for run in &text.paragraphs {
            if let Some(id) = run.style.style_sheet
                && id != 0
                && !styles.paragraph.iter().any(|style| style.id == id)
            {
                return Err(err(VerifyErrorCode::UnsupportedObject, format!("段落 run 引用了不存在的段落样式 {id}")));
            }
        }
    }
    Ok(())
}

fn style_names_ok(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= MAX_STYLE_NAME_CHARS && !name.contains('\0')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document() -> photocraft_doc::Document {
        let mut document = photocraft_doc::Document::new(
            "核验",
            photocraft_doc::Size::new(64, 48),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
        );
        document.layers.push(photocraft_doc::Layer::new(
            "文字",
            LayerContent::Text(photocraft_doc::TextLayer {
                text: "Hello".into(),
                font_family: "Inter".into(),
                size_pt: 18.0,
                ..Default::default()
            }),
        ));
        document
    }

    fn inspect_one(document: &photocraft_doc::Document) -> Result<(), VerifyError> {
        let mut out = LayerInspection::default();
        inspect(document.layers.first().unwrap(), 1, &mut out, false)
            .expect("文字层必须由本域检查")
    }

    #[test]
    fn a_plain_text_layer_passes_and_reports_its_kind() {
        let sample = document();
        let mut out = LayerInspection::default();
        inspect(sample.layers.first().unwrap(), 1, &mut out, false).unwrap().unwrap();
        assert!(out.kinds.contains("text"));
        inspect_document(&sample).unwrap();
    }

    #[test]
    fn a_non_positive_size_is_refused_before_reopening() {
        let mut zero = document();
        if let LayerContent::Text(text) = &mut zero.layers[0].content {
            text.size_pt = 0.0;
        }
        assert!(inspect_one(&zero).is_err());
        let mut nan = document();
        if let LayerContent::Text(text) = &mut nan.layers[0].content {
            text.size_pt = f32::NAN;
        }
        assert!(inspect_one(&nan).is_err());
    }

    #[test]
    fn non_finite_transforms_and_tracking_are_refused() {
        let mut infinite = document();
        if let LayerContent::Text(text) = &mut infinite.layers[0].content {
            text.transform.m[4] = f64::INFINITY;
        }
        assert!(inspect_one(&infinite).is_err());

        let mut tracking = document();
        if let LayerContent::Text(text) = &mut tracking.layers[0].content {
            text.runs = vec![photocraft_doc::text::TextRun {
                len: text.text.len(),
                style: photocraft_doc::text::CharStyle { tracking: 20_000.0, ..Default::default() },
            }];
        }
        assert!(inspect_one(&tracking).is_err());
    }

    #[test]
    fn paragraph_auto_leading_must_be_positive() {
        let mut sample = document();
        if let LayerContent::Text(text) = &mut sample.layers[0].content {
            text.paragraphs = vec![photocraft_doc::text::ParagraphRun {
                len: text.text.len(),
                style: photocraft_doc::text::ParagraphStyle { auto_leading: 0.0, ..Default::default() },
            }];
        }
        assert!(inspect_one(&sample).is_err());
    }

    #[test]
    fn dangling_style_references_are_refused_at_document_level() {
        let mut sample = document();
        if let LayerContent::Text(text) = &mut sample.layers[0].content {
            text.runs = vec![photocraft_doc::text::TextRun {
                len: text.text.len(),
                style: photocraft_doc::text::CharStyle { style_sheet: Some(7), ..Default::default() },
            }];
            text.paragraphs = vec![photocraft_doc::text::ParagraphRun {
                len: text.text.len(),
                style: photocraft_doc::text::ParagraphStyle { style_sheet: Some(9), ..Default::default() },
            }];
        }
        let failure = inspect_document(&sample).unwrap_err();
        assert!(failure.message.contains('7'), "{}", failure.message);
        // 补齐样式后即可通过。
        sample.text_styles.character.push(photocraft_doc::text_styles::CharacterStyleDef {
            id: 7,
            name: "标题".into(),
            attrs: Default::default(),
        });
        sample.text_styles.paragraph.push(photocraft_doc::text_styles::ParagraphStyleDef {
            id: 9,
            name: "正文".into(),
            ..Default::default()
        });
        inspect_document(&sample).unwrap();
    }

    #[test]
    fn style_names_and_ids_are_bounded() {
        let mut sample = document();
        sample.text_styles.character.push(photocraft_doc::text_styles::CharacterStyleDef {
            id: 0,
            name: "非法".into(),
            attrs: Default::default(),
        });
        assert!(inspect_document(&sample).is_err());
        sample.text_styles.character[0].id = 1;
        sample.text_styles.character[0].name = "x".repeat(MAX_STYLE_NAME_CHARS + 1);
        assert!(inspect_document(&sample).is_err());
        sample.text_styles.character[0].name = "标题".into();
        inspect_document(&sample).unwrap();
        // 重复 id 同样拒绝。
        sample.text_styles.character.push(photocraft_doc::text_styles::CharacterStyleDef {
            id: 1,
            name: "副本".into(),
            attrs: Default::default(),
        });
        assert!(inspect_document(&sample).is_err());
    }

    /// 样式表条目数超预算时拒绝：这不是「格式不认识」，而是资源上限。
    #[test]
    fn oversized_style_tables_are_refused_before_decoding() {
        let mut sample = document();
        for id in 1..=(MAX_STYLES as u32 + 1) {
            sample.text_styles.paragraph.push(photocraft_doc::text_styles::ParagraphStyleDef {
                id,
                name: format!("样式{id}"),
                ..Default::default()
            });
        }
        let error = inspect_document(&sample).expect_err("超预算的样式表必须被拒绝");
        assert_eq!(error.code, VerifyErrorCode::TooManyLayers);
        // 恰好等于上限时仍然可用。
        sample.text_styles.paragraph.truncate(MAX_STYLES);
        inspect_document(&sample).unwrap();
    }

    /// 端到端：**真实工程字节**经公开 `verify` 入口，悬空样式引用必须被拒绝。
    ///
    /// 这条测试证明 `lib.rs` 的文档级钩子确实接通了——只测 `inspect_document` 无法区分
    /// 「函数正确但没人调用」和「钩子已生效」。
    #[test]
    fn a_real_project_with_a_dangling_style_reference_is_refused() {
        use photocraft_doc::text::{CharStyle, Kerning, TextRun};

        let mut sample = document();
        sample.text_styles.character.push(photocraft_doc::text_styles::CharacterStyleDef {
            id: 5,
            name: "标题".into(),
            attrs: Default::default(),
        });
        let LayerContent::Text(text) = &mut sample.layers[0].content else { panic!("样本必须是文字层") };
        text.runs = vec![TextRun {
            len: text.text.len(),
            style: CharStyle { style_sheet: Some(5), kerning: Kerning::Metrics, ..Default::default() },
        }];
        // 合法引用先通过：证明失败只来自「悬空」而不是「有引用」。
        let valid = photocraft_format::save_to_bytes(&sample, &photocraft_format::SaveOptions::default())
            .expect("保存合法工程");
        super::super::super::verify(&valid).expect("引用了存在的样式必须通过");

        // 把样式删掉，留下悬空引用。
        sample.text_styles.character.clear();
        let dangling = photocraft_format::save_to_bytes(&sample, &photocraft_format::SaveOptions::default())
            .expect("保存悬空引用工程");
        let error = super::super::super::verify(&dangling).expect_err("悬空样式引用必须被拒绝");
        assert_eq!(error.code, VerifyErrorCode::UnsupportedObject);
        assert!(error.message.contains("不存在的字符样式"), "{}", error.message);
    }
}
