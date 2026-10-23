//! P3：PSD 导入导出入口
//! （change: 2026-10-22-complete-photocraft-webui-editing，P3 / design D6）。
//!
//! 与 `.pcraft` 打开/保存完全分开：
//! - 导入在候选文档完成，成功后才替换当前文档；失败保留现场。
//! - 导出用冻结修订的文档快照，产生逐层报告；文件交付由宿主端口完成，不推进工程保存基线。
use super::*;

impl Editor {
    /// PSD 导入预检（不替换文档）：容器、版本、色彩、位深与尺寸。
    pub fn inspect_psd(&self, bytes: &[u8]) -> Result<Value> {
        let header = crate::psd::inspect_psd(bytes)?;
        Ok(json!(header))
    }

    /// PSD 兼容矩阵（UI 与核验器共用同一份声明）。
    pub fn psd_matrix(&self) -> Value {
        json!(crate::psd::compatibility_matrix())
    }

    /// 导入 PSD 为可编辑候选文档。
    ///
    /// `flat` 为 true 时按「扁平副本」打开（只保留合成像素），报告列出丢失结构。
    pub fn import_psd_project(&mut self, bytes: &[u8], flat: bool) -> Result<Value> {
        self.require_no_stroke()?;
        if self.has_document() {
            // 候选文档先完整解析；成功后才替换，失败不触碰当前文档。
            let import = if flat {
                crate::psd::import_psd_flat(bytes)?
            } else {
                crate::psd::import_psd(bytes)?
            };
            let report = crate::psd::import_report(&import);
            let index = self.session.add_document(import.document, None);
            self.session.close(0);
            self.session.set_active(index.saturating_sub(1));
            self.registry.clear();
            let mut result = self.active_json()?;
            if let Some(obj) = result.as_object_mut() {
                obj.insert("psd".into(), report);
            }
            return Ok(result);
        }
        let import = if flat {
            crate::psd::import_psd_flat(bytes)?
        } else {
            crate::psd::import_psd(bytes)?
        };
        let report = crate::psd::import_report(&import);
        self.registry.clear();
        let index = self.session.add_document(import.document, None);
        self.session.set_active(index);
        let mut result = self.active_json()?;
        if let Some(obj) = result.as_object_mut() {
            obj.insert("psd".into(), report);
        }
        Ok(result)
    }

    /// PSD 导出预检：逐层报告，不产生字节。
    ///
    /// 同时报告**文档级**视图数据损失（参考线颜色/标尺原点/计数分组）：它们不挂在图层上，
    /// 只看图层会让用户以为「全部可编辑」，却在导出后悄悄丢掉。
    pub fn inspect_psd_export(&self) -> Result<Value> {
        let state = self.active_doc()?;
        let document = &state.doc;
        let rows = crate::psd::inspect_psd_export(document)?;
        let blocking = rows.iter().filter(|row| !row.rasterizable).count();
        let view_losses =
            crate::features::views::psd_loss_rows_with_samplers(document, &state.color_samplers);
        Ok(json!({
            "layers": rows,
            "viewLosses": view_losses.iter().map(|(feature, reason)| json!({
                "feature": feature,
                "reason": reason,
            })).collect::<Vec<_>>(),
            "rasterizable": rows.len(),
            "blocking": blocking,
            "editable": rows.is_empty() && view_losses.is_empty(),
        }))
    }

    /// PSD 导出：返回字节 + 报告。
    ///
    /// `rasterizeLossy` 为 false 且存在不可保持可编辑内容时拒绝；转换只影响输出副本。
    pub fn export_psd(&self, params: Value) -> Result<(Vec<u8>, Value)> {
        self.require_no_stroke()?;
        let rasterize = params
            .get("rasterizeLossy")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let state = self.active_doc()?;
        let document = &state.doc;
        let export = crate::psd::export_psd(document, rasterize)?;
        let report = crate::psd::export_report(&export, document, &state.color_samplers);
        Ok((export.bytes, report))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor_with_document() -> Editor {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
        editor.execute("layer.new.group", json!({"name":"组"})).unwrap();
        editor
    }

    #[test]
    fn psd_matrix_and_preflight_are_available_without_a_document() {
        let editor = Editor::new();
        let matrix = editor.psd_matrix();
        assert!(matrix.as_array().unwrap().iter().any(|row| row["feature"] == "psd.v1.rgb-u8"));
        assert!(editor.inspect_psd(b"not a psd").is_err());
        assert!(editor.inspect_psd_export().is_err(), "无文档时导出预检应报无文档");
    }

    #[test]
    fn import_replaces_the_document_only_after_a_successful_candidate() {
        let mut editor = editor_with_document();
        let before = editor.state();
        // 坏的 PSD 不替换当前文档。
        assert!(editor.import_psd_project(b"garbage", false).is_err());
        assert_eq!(editor.state(), before);
        // 导出当前文档，再以同一字节导入：成功且报告可编辑。
        let (bytes, report) = editor.export_psd(json!({})).unwrap();
        assert_eq!(report["rasterized"], false);
        let imported = editor.import_psd_project(&bytes, false).unwrap();
        assert_eq!(imported["psd"]["editable"], true);
        assert_eq!(editor.state()["document"]["width"], 40);
    }

    #[test]
    fn flat_import_reports_lost_structure() {
        let mut editor = editor_with_document();
        let (bytes, _) = editor.export_psd(json!({})).unwrap();
        let mut fresh = Editor::new();
        let imported = fresh.import_psd_project(&bytes, true).unwrap();
        assert_eq!(imported["psd"]["layers"], 1);
        assert!(imported["psd"]["lossy"].as_array().unwrap().is_empty() || imported["psd"]["editable"] == false);
        assert_eq!(imported["document"]["layers"].as_array().unwrap().len(), 1);
    }
}

#[cfg(test)]
mod view_loss_tests {
    use super::*;

    fn decorated() -> Editor {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
        // 参考线（含自定义颜色）、非零标尺原点、计数标记：三项都没有 PSD 对应字段。
        editor.guide_command("view.newGuide", json!({"orientation":"vertical","position":12.0})).unwrap();
        editor.guide_command("view.editGuide", json!({"orientation":"vertical","index":0,"color":"#ff0000"})).unwrap();
        editor.guide_command("view.setRulerOrigin", json!({"x":3.0,"y":4.0})).unwrap();
        editor.view_command("count.add", json!({"point":[10.0,10.0]})).unwrap();
        editor
    }

    #[test]
    fn preflight_reports_document_level_view_losses_that_no_layer_walk_can_see() {
        let editor = decorated();
        let report = editor.inspect_psd_export().unwrap();
        let features: Vec<&str> = report["viewLosses"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["feature"].as_str())
            .collect();
        assert_eq!(features, ["view.guide-colors", "view.ruler-origin", "view.count-marks"]);
        // 图层全可编辑，但文档级数据会丢：不能报「完全可编辑」。
        assert_eq!(report["editable"], false);
        assert_eq!(report["blocking"], 0, "视图数据是显式报告，不是拒绝导出的理由");
    }

    #[test]
    fn export_report_carries_the_same_view_losses() {
        let editor = decorated();
        let (_bytes, report) = editor.export_psd(json!({"rasterizeLossy": true})).unwrap();
        let features: Vec<&str> = report["viewLosses"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["feature"].as_str())
            .collect();
        assert_eq!(features, ["view.guide-colors", "view.ruler-origin", "view.count-marks"]);
        assert!(report["lossy"].as_array().unwrap().is_empty(), "没有图层级损失");
    }

    #[test]
    fn a_plain_document_reports_no_view_losses() {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width":40,"height":30})).unwrap();
        let report = editor.inspect_psd_export().unwrap();
        assert_eq!(report["viewLosses"].as_array().unwrap().len(), 0);
        assert_eq!(report["editable"], true);
    }

    #[test]
    fn the_report_matches_what_the_round_trip_actually_keeps_and_drops() {
        // 实测而非照表推断：导出→导入后，参考线位置/注释/测量比例留下，
        // 参考线颜色/标尺原点/计数分组丢失——与报告逐项一致。
        let mut editor = decorated();
        editor.view_command("notes.add", json!({"x":2.0,"y":2.0,"text":"备注"})).unwrap();
        editor.view_command(
            "image.analysis.setMeasurementScale",
            json!({"pixelLength":1.0,"logicalLength":2.5,"units":"mm"}),
        ).unwrap();
        let (bytes, report) = editor.export_psd(json!({"rasterizeLossy": true})).unwrap();
        // 注释与测量比例能写进 PSD，因此报告里只应出现先前那三项。
        let features: Vec<&str> = report["viewLosses"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|row| row["feature"].as_str())
            .collect();
        assert_eq!(features, ["view.guide-colors", "view.ruler-origin", "view.count-marks"]);

        let before = editor.active_doc().unwrap().doc.clone();
        editor.import_psd_project(&bytes, false).unwrap();
        let after = editor.active_doc().unwrap().doc.clone();
        assert_eq!(after.guides.vertical, before.guides.vertical, "参考线位置随 PSD 保留");
        assert!(after.guides.colors.is_empty(), "参考线自定义颜色在 PSD 中丢失");
        assert_eq!(after.ruler_origin, [0.0, 0.0], "标尺原点在 PSD 中丢失");
        let marks: usize = after.measurement.count_groups.iter().map(|group| group.points.len()).sum();
        assert_eq!(marks, 0, "计数分组在 PSD 中丢失");
        assert_eq!(after.notes.len(), before.notes.len(), "注释随 PSD 保留");
        assert_eq!(after.measurement.scale, before.measurement.scale, "测量比例随 PSD 保留");
    }
}
