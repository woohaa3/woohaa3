//! 滤镜域的编辑入口：草稿、清单、重复上次与图内控制点。
//!
//! 每个入口都遵守同一套事务规则（design D3）：草稿预览不推进修订／指纹／历史；确认只提交
//! 一次；无变化不增历史；失败保留现场。所有入口只登记 [`catalog`] 里的命令，未验收的滤镜
//! （液化、插件、智能滤镜转换等）在这里就被拒绝。
//!
//! 本文件被 `crate::editor::tools` 以 `#[path]` 收编，因此模块内只能用绝对路径引用本域模块。

use crate::editor::*;
use crate::features::filters::{catalog, gallery, geometry};
use crate::retouch::{FilterDraft, canonical_for, last_filter};
use serde_json::{Value, json};

use super::command_error;

impl Editor {
    /// 参数滤镜草稿：开始／更新／确认／取消。
    pub fn begin_filter(&mut self, id: &str, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        if self.filter_draft.is_some() {
            return Err(command_error("filter.draft", "请先确认或取消当前滤镜草稿"));
        }
        // 滤镜草稿同样走 scratch 会话；门禁在入口就拒绝，避免用户在必然失败的预览里调参
        // （change: 2026-10-22-add-photocraft-image-mode-workflows）。
        if let Some(state) = self.session.active() {
            crate::features::modes::gate::check(&state.doc, id, &params)?;
        }
        let draft = FilterDraft::begin(&self.session, id, None, params)?;
        let info = draft_info(id, draft.params(), draft.layer().0);
        self.filter_draft = Some(draft);
        Ok(info)
    }

    pub fn update_filter(&mut self, params: Value) -> Result<Value> {
        let draft = self
            .filter_draft
            .as_mut()
            .ok_or_else(|| command_error("filter.draft", "没有活动滤镜草稿"))?;
        draft.update(params)?;
        let info = draft_info(draft.id(), draft.params(), draft.layer().0);
        Ok(info)
    }

    pub fn commit_filter(&mut self) -> Result<Value> {
        let draft = self
            .filter_draft
            .take()
            .ok_or_else(|| command_error("filter.draft", "没有活动滤镜草稿"))?;
        draft.commit(&mut self.session)
    }

    pub fn cancel_filter(&mut self) -> Value {
        self.filter_draft = None;
        json!({ "cancelled": true })
    }

    /// 活动草稿状态（UI 门禁用；没有草稿时为 `null`）。
    pub fn filter_draft_state(&self) -> Value {
        match self.filter_draft.as_ref() {
            Some(draft) => draft_info(draft.id(), draft.params(), draft.layer().0),
            None => Value::Null,
        }
    }

    /// 滤镜清单（面板渲染用）：命令、中文名、归类、交互形态与参数 schema。
    pub fn filter_catalogue(&self) -> Value {
        catalog::catalogue()
    }

    /// 画廊目录（滤镜库的分类与单个滤镜参数）。
    pub fn filter_gallery_catalogue(&self) -> Value {
        gallery::catalogue()
    }

    /// 滤镜库的默认组合（面板首次打开就有可预览的候选）。
    pub fn filter_gallery_default_stack(&self) -> Value {
        gallery::default_stack()
    }

    /// 上一次滤镜（菜单/按钮「重复上次」的可用性提示）。
    pub fn filter_last(&self) -> Value {
        match last_filter(&self.session) {
            Ok((id, params)) => json!({
                "available": true,
                "filter": id,
                "label": catalog::entry(&id).map(|entry| entry.label).unwrap_or(id.as_str()),
                "params": params,
            }),
            Err(error) => json!({ "available": false, "reason": error.to_string() }),
        }
    }

    /// 重复上次滤镜：把规范参数重新投到当前活动可写层，回到同一条草稿流程。
    ///
    /// 不复用上游 `filter.lastFilter` 直接执行：草稿需要候选文档与一次历史，而重复还必须先
    /// 把旧图层 id 去掉、把颜色/seed 固定成规范参数，否则「重复」会跟着当前色板漂移。
    pub fn repeat_last_filter(&mut self) -> Result<Value> {
        self.require_no_stroke()?;
        if self.filter_draft.is_some() {
            return Err(command_error("filter.draft", "请先确认或取消当前滤镜草稿"));
        }
        let (id, params) = last_filter(&self.session)?;
        let params = canonical_for(&self.session, &id, &params)?;
        let draft = FilterDraft::begin(&self.session, &id, None, params)?;
        let info = draft_info(&id, draft.params(), draft.layer().0);
        self.filter_draft = Some(draft);
        Ok(json!({ "repeated": true, "draft": info }))
    }

    /// 图内控制点规范化：文档坐标 → 0–1 相对坐标（模糊画廊/消失点面板用）。
    pub fn filter_normalize_point(&self, x: f64, y: f64, width: f64, height: f64) -> Result<Value> {
        let point = geometry::normalize_point(x, y, width, height)?;
        Ok(json!({ "point": point }))
    }

    /// 位移图来源：当前会话里可选的已打开文档（序号 + 名称），以及每份文档可当作位移图的图层。
    ///
    /// 只给名字/序号，不给宿主路径：本域拒绝按本机路径读图，来源必须已经在会话里。每份文档
    /// 附带像素图层列表，是因为内核的 `mapLayer` 收的是**该文档内**的图层 id——没有这份列表，
    /// 用户只能压平整份文档，「用位移图文档里的某一层」这条真实能力就没有入口。
    pub fn filter_map_sources(&self) -> Value {
        let active = self.session.active_index();
        let documents: Vec<Value> = self
            .session
            .documents()
            .iter()
            .enumerate()
            .map(|(index, state)| {
                // 与 `map_from_document` 一致：不给图层就压平整份文档，给了就只取那层。
                let layers: Vec<Value> = state
                    .doc
                    .layers
                    .iter()
                    .filter(|layer| layer.surface().is_some() && layer.visible)
                    .map(|layer| json!({ "id": layer.id.0, "name": layer.name }))
                    .collect();
                json!({
                    "index": index,
                    "name": state.doc.name,
                    "width": state.doc.size.width,
                    "height": state.doc.size.height,
                    "active": Some(index) == active,
                    "layers": layers,
                })
            })
            .collect();
        json!({ "documents": documents })
    }

    /// 消失点粘贴的图层来源：当前文档里带像素的图层（id + 名称 + 是否活动）。
    ///
    /// 内核的 `paste[].layer` 需要**图层 id**，而不是文档名；没有这个端口时面板只能要求用户
    /// 先把内容放进剪贴板，粘贴功能的入口就等于不存在。这里只列像素图层，并排除隐藏层——
    /// 贴一张隐藏层的图对用户是意外。
    /// 火焰滤镜的路径来源：文档里的已保存路径名，外加「工作路径」这一档。
    ///
    /// 内核 `path` 认的是**已保存路径的名字**（`"work"` 或空表示工作路径），不是坐标数组；
    /// 没有这个端口时面板只能让火焰落在默认路径上，`flameType` 之外的形状参数等于不存在。
    pub fn filter_path_sources(&self) -> Value {
        let Some(state) = self.session.active() else {
            return json!({ "paths": [], "hasWorkPath": false });
        };
        let paths: Vec<Value> = state
            .doc
            .paths
            .iter()
            .map(|named| json!({ "name": named.name }))
            .collect();
        json!({ "paths": paths, "hasWorkPath": state.doc.work_path.is_some() })
    }

    pub fn filter_layer_sources(&self) -> Value {
        let Some(state) = self.session.active() else {
            return json!({ "layers": [] });
        };
        let active = state.active_layer;
        let layers: Vec<Value> = state
            .doc
            .layers
            .iter()
            .filter(|layer| layer.surface().is_some() && layer.visible)
            .map(|layer| {
                // 尺寸取内容边界：没有像素的层边界为空，贴上去也没有意义。
                let bounds = layer.surface().map(|s| s.content_bounds()).unwrap_or_default();
                json!({
                    "id": layer.id.0,
                    "name": layer.name,
                    "active": Some(layer.id) == active,
                    "width": bounds.width(),
                    "height": bounds.height(),
                })
            })
            .collect();
        json!({ "layers": layers })
    }
}

fn draft_info(id: &str, params: &Value, layer: u64) -> Value {
    let entry = catalog::entry(id);
    json!({
        "filter": id,
        "label": entry.map(|entry| entry.label).unwrap_or(id),
        "category": entry.map(|entry| entry.category).unwrap_or(""),
        "kind": entry.map(|entry| format!("{:?}", entry.kind)).unwrap_or_default(),
        "layer": layer,
        "params": params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 位移图来源必须同时给出「文档」和「该文档里的图层」。
    ///
    /// 内核 `mapLayer` 收的是**位移图文档内**的图层 id（`map_from_document(doc, Some(id))`）。
    /// 只给文档列表时，面板只能压平整份文档，「用位移图里的某一层」这条真实能力没有入口；
    /// 两边的字段名与单位必须一致，否则面板会把别的文档的 id 写进去。
    #[test]
    fn map_sources_carry_each_documents_pixel_layers() {
        let mut editor = Editor::default();
        editor.execute("file.new", json!({ "width": 32, "height": 24, "name": "map" })).unwrap();
        editor.execute("layer.new.layer", json!({ "name": "上层" })).unwrap();
        editor.execute("layer.new.layer", json!({ "name": "下层" })).unwrap();

        let sources = editor.filter_map_sources();
        let documents = sources["documents"].as_array().expect("documents 必须是数组");
        assert_eq!(documents.len(), 1, "默认只有一个文档");
        let map = &documents[0];
        assert_eq!(map["name"], json!("map"));

        let layers = map["layers"].as_array().expect("每份文档都要带 layers");
        let names: Vec<&str> = layers.iter().filter_map(|layer| layer["name"].as_str()).collect();
        assert!(names.contains(&"上层") && names.contains(&"下层"), "缺图层: {names:?}");

        // id 必须与内核 `LayerId` 同值：拿它当 `mapLayer` 传回内核才能定位到同一层。
        let upper = layers
            .iter()
            .find(|layer| layer["name"] == json!("上层"))
            .expect("上层");
        let id = upper["id"].as_u64().expect("图层 id 必须是整数");
        let document = editor.state();
        let same = document["document"]["layers"]
            .as_array()
            .expect("layers")
            .iter()
            .any(|layer| layer["id"].as_u64() == Some(id) && layer["name"] == json!("上层"));
        assert!(same, "mapLayer id 与文档图层 id 必须是同一套编号");
    }

    /// 隐藏层不出现在候选里：拿它当位移图会得到一份「看不见的图」，用户无从解释结果。
    #[test]
    fn map_sources_skip_hidden_layers() {
        let mut editor = Editor::default();
        editor.execute("file.new", json!({ "width": 16, "height": 16, "name": "map" })).unwrap();
        editor.execute("layer.new.layer", json!({ "name": "可见" })).unwrap();
        editor.execute("layer.new.layer", json!({ "name": "隐藏" })).unwrap();
        // `layer.hide` 在本构建里受 capability 门禁关闭，直接改文档可见性即可——
        // 本用例核对的是来源端口的过滤规则，不是隐藏命令本身。
        {
            let state = editor.session.active_mut().expect("活动文档");
            let doc = std::sync::Arc::make_mut(&mut state.doc);
            for layer in &mut doc.layers {
                if layer.name == "隐藏" {
                    layer.visible = false;
                }
            }
        }

        let sources = editor.filter_map_sources();
        let layers = sources["documents"][0]["layers"].as_array().expect("layers");
        assert!(
            layers.iter().all(|layer| layer["name"] != json!("隐藏")),
            "隐藏层不该出现在位移图图层候选里"
        );
    }
}
