//! P5/P6/P7：调色、直方图、选区、修饰、滤镜、构图、文字与矢量的统一入口
//! （change: 2026-10-22-complete-photocraft-webui-editing）。
//!
//! 每个入口都遵守同一套事务规则（design D3）：
//! 草稿预览不推进修订／指纹／历史；确认只提交一次；无变化不增历史；失败保留现场。
use serde_json::{Value, json};

use crate::editor::*;
use super::canonical_kind;
use crate::features::layers::layer_filter_domain::{self, LayerListFilter};


impl Editor {
    /// 图层列表过滤：只返回过滤结果，不改文档。
    ///
    /// U63 补全 `by`（kind/name/mode）、`mode` 主条件、`shape` 种类与 `onlySelected`。
    /// 选中层的祖先组始终保留，否则树形列表会出现「选中层不在其父组里」的不一致。
    pub fn filter_layers(&self, params: Value) -> Result<Value> {
        let filter = layer_filter_domain::parse(&params)?;
        let state = self.active_doc()?;
        let selected = state.selected_layers();
        let mut rows = Vec::new();
        // 组行必须排在子行之前（列表是父在上），且「选中层的祖先组」必须一起显示。
        fn visit(filter: &LayerListFilter, layers: &[photocraft_doc::Layer], selected: &[photocraft_doc::LayerId], out: &mut Vec<Value>) -> bool {
            let mut any_in_branch = false;
            for layer in layers {
                let selected_here = selected.contains(&layer.id);
                let kind = canonical_kind(&layer.content);
                let position = out.len();
                out.push(Value::Null);
                let branch = match &layer.content {
                    photocraft_doc::LayerContent::Group(group) => visit(filter, &group.children, selected, out),
                    _ => false,
                };
                let in_branch = selected_here || branch;
                any_in_branch |= in_branch;
                out[position] = layer_filter_domain::row(layer, filter.hides(&layer.name, kind, layer.blend, selected_here, in_branch));
            }
            any_in_branch
        }
        visit(&filter, &state.doc.layers, &selected, &mut rows);
        let visible = rows.iter().filter(|row| row["hidden"] != json!(true)).count();
        Ok(json!({
            "active": filter.active(),
            "by": filter.by.id(),
            "layers": rows,
            "visible": visible,
        }))
    }

    /// U58–U62、U64 的统一入口（预览或一步提交）；命令 id 必须先由能力白名单开放。
    pub fn layer_workflow_command(&mut self, id: &str, params: Value, preview: bool) -> Result<Value> {
        self.layer_workflow(id, params, preview)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::Editor;

    fn editor() -> Editor {
        use photocraft_doc::{Color, ColorMode, Document, SampleType, Size};
        let doc = Document::with_background("s", Size { width: 32, height: 24 }, ColorMode::Rgb, SampleType::U8, Color::rgb(0.2, 0.4, 0.6));
        let png = photocraft_io::export(&doc, "png", &photocraft_io::ExportOptions::default()).unwrap().bytes;
        let mut editor = Editor::new();
        editor.open_image("photo.png", None, &png).unwrap();
        editor.execute("layer.new.layer", json!({"name":"上层"})).unwrap();
        editor
    }

    /// U63 成功证据：过滤只改变图层列表行，不改内容、选择或可见合成。
    ///
    /// 这条走 `Editor::filter_layers` 真实入口（面板与 WASM 都调它），而不只是解析/谓词。
    #[test]
    fn filtering_only_changes_the_list_rows_not_content_selection_or_composite() {
        let mut editor = editor();
        editor.execute("select.rect", json!({"x":2,"y":2,"width":8,"height":6})).unwrap();
        let hash = editor.content_hash().unwrap();
        let revision = editor.revision().unwrap();
        let steps = editor.active_doc().unwrap().history.past_len();
        let selection = editor.active_doc().unwrap().doc.selection.clone();
        let selected = editor.active_doc().unwrap().selected_layers();
        let composite = photocraft_compose::thumbnail(&editor.active_doc().unwrap().doc, 32).pixels;
        // 未过滤：所有行可见，`active` 为假（面板在无任何条件时发的就是空对象）。
        let all = editor.filter_layers(json!({})).unwrap();
        assert_eq!(all["active"], false);
        assert_eq!(all["visible"], all["layers"].as_array().unwrap().len());
        // 按种类过滤：只隐藏行。
        let raster = editor.filter_layers(json!({"by":"kind","kinds":["raster"]})).unwrap();
        assert_eq!(raster["active"], true);
        assert_eq!(raster["by"], "kind");
        assert!(raster["visible"].as_u64().unwrap() <= all["visible"].as_u64().unwrap());
        // 只显示选中层：选中层与其祖先必须一起可见。
        let only = editor.filter_layers(json!({"onlySelected":true})).unwrap();
        let rows = only["layers"].as_array().unwrap();
        assert!(rows.iter().any(|row| row["hidden"] == json!(false)), "选中层不能被自己隐藏");
        // 过滤前后：内容指纹、修订、历史、选区、选中集合与可见合成都不变。
        assert_eq!(editor.content_hash().unwrap(), hash);
        assert_eq!(editor.revision().unwrap(), revision);
        assert_eq!(editor.active_doc().unwrap().history.past_len(), steps);
        assert_eq!(editor.active_doc().unwrap().doc.selection, selection);
        assert_eq!(editor.active_doc().unwrap().selected_layers(), selected);
        assert_eq!(photocraft_compose::thumbnail(&editor.active_doc().unwrap().doc, 32).pixels, composite);
    }

    /// U63 失败路径：未知筛选值给出具体原因，且不静默退回「显示全部」。
    #[test]
    fn unknown_filter_values_are_rejected_with_a_reason() {
        let editor = editor();
        for params in [json!({"by":"bogus"}), json!({"kinds":["nope"]}), json!({"onlySelected":"yes"})] {
            let reason = editor.filter_layers(params.clone()).unwrap_err();
            assert!(!reason.to_string().is_empty(), "{params}");
        }
    }
}
