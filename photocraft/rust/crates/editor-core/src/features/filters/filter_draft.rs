//! 参数滤镜草稿：隔离预览、冻结随机种子、确认一步提交。
//!
//! 本模块被 `crate::retouch` 以 `#[path]` 收编（共享 `Editor::filter_draft` 字段引用
//! [`FilterDraft`]），因此对外只用 [`FilterDraft`]、[`validate_filter`] 与
//! [`last_filter`] 三个入口，内部细节（种子冻结、颜色快照、资源解析）不外泄。
//!
//! ## 事务规则
//!
//! - 预览只改候选文档，正式修订／指纹／历史不动；
//! - 参数非法时**保留上一次有效预览**，但绝不把旧候选确认为新输入；
//! - 确认只提交一次历史；候选与基线一致时不增历史；
//! - 随机滤镜在 [`FilterDraft::begin`] 冻结 seed 并写进规范参数，「重复上次」因此可重现；
//! - 读取前景/背景色的滤镜在开始时把颜色**快照**进规范参数，重复时不跟随当前色板漂移。

use super::*;

use crate::features::filters::catalog::{self, Entry, Kind};
use crate::features::filters::{gallery, geometry};
use serde_json::{Map, Value, json};

/// 参数滤镜草稿：隔离预览，确认一步提交。
pub struct FilterDraft {
    base: photocraft_engine::DocState,
    id: String,
    label: String,
    /// 规范参数（含冻结 seed 与颜色快照），「重复上次」原样保存它。
    params: Value,
    /// 预览的目标图层；`newLayer` 类滤镜会把它换成内核新建的图层。
    layer: LayerId,
    /// 开始草稿时已打开文档的快照：位移图等资源型滤镜按名字/序号取图。
    sources: Vec<Arc<Document>>,
    /// 目标文档在 [`Self::sources`] 里的下标。
    index: usize,
    pub document: Arc<Document>,
}

impl FilterDraft {
    /// 开始草稿：先校验命令、目标与参数，再在候选文档上跑一次。
    pub fn begin(session: &Session, id: &str, layer: Option<LayerId>, params: Value) -> Result<Self> {
        let entry = catalog::entry(id).ok_or_else(|| {
            static_error("filter.draft", format!("{id} 不是已开放的参数滤镜"))
        })?;
        let state = session.active().ok_or(EditorError::NoDocument)?.clone();
        let layer = layer
            .or(state.active_layer)
            .ok_or_else(|| static_error("filter.draft", "没有可应用滤镜的图层"))?;
        // 目标检查先于几何检查：让「这层不能滤镜」与「参数不对」给出不同原因。
        //
        // 共享的 `writable_pixel_layer` 把原因挂在 `paint.target` 上（它同时服务于笔刷）。
        // 滤镜用户看到 `paint.target` 会以为自己误触了画笔，所以这里换成滤镜域自己的命令 id，
        // 消息保持同一句具体原因，不吞掉「文字要先栅格化」「像素已锁定」这些可操作信息。
        crate::adjustment_ext::writable_pixel_layer(&state.doc, layer).map_err(|error| match error {
            crate::error::EditorError::CommandFailed { message, .. } => static_error("filter.draft", message),
            other => other,
        })?;
        let params = canonical(session, entry, &params)?;
        catalog::validate(id, &params)?;
        let sources: Vec<Arc<Document>> = session.documents().iter().map(|state| state.doc.clone()).collect();
        let index = session.active_index().unwrap_or(0);
        let (document, target) = Self::render(&sources, index, &state, id, layer, &params)?;
        Ok(Self { base: state, id: id.to_string(), label: entry.label.to_string(), params, layer: target, sources, index, document })
    }

    /// 在候选文档上跑一次滤镜；返回候选文档与内核最终的活动图层。
    ///
    /// 预览会话必须**带上同一批已打开文档**：位移图（`filter.distort.displace` 的
    /// `mapDocument`）按名字或序号在其他文档里取图，只放目标文档会让合法参数在预览阶段
    /// 报「找不到位移图文档」，与确认时的结果不一致。目标文档用冻结快照，其他文档只作资源来源。
    fn render(
        sources: &[Arc<Document>],
        index: usize,
        base: &photocraft_engine::DocState,
        id: &str,
        layer: LayerId,
        params: &Value,
    ) -> Result<(Arc<Document>, LayerId)> {
        let mut scratch = Session::new();
        for doc in sources {
            scratch.add_document((**doc).clone(), None);
        }
        scratch.set_active(index);
        if let Some(active) = scratch.active_mut() {
            *active = base.clone();
        }
        let mut command = params.clone();
        command["layer"] = json!(layer.0);
        scratch
            .execute(id, command)
            .map_err(|failure| static_error("filter.draft", failure))?;
        let state = scratch.active().ok_or(EditorError::NoDocument)?;
        let target = state.active_layer.unwrap_or(layer);
        Ok((state.doc.clone(), target))
    }

    /// 更新参数：失败时保留上一次有效草稿（不能确认旧预览）。
    pub fn update(&mut self, params: Value) -> Result<()> {
        let entry = catalog::entry(&self.id)
            .ok_or_else(|| static_error("filter.draft", format!("{} 不是已开放的参数滤镜", self.id)))?;
        // 沿用首次冻结的 seed 与已快照的颜色，避免滑杆拖动时随机效果自己跳变。
        let params = canonical_from(&self.params, entry, &params)?;
        catalog::validate(&self.id, &params)?;
        let (document, target) = Self::render(&self.sources, self.index, &self.base, &self.id, self.layer, &params)?;
        self.document = document;
        self.layer = target;
        self.params = params;
        Ok(())
    }

    /// 当前规范参数（面板回读/测试用）。
    pub fn params(&self) -> &Value {
        &self.params
    }

    /// 草稿命令 id。
    pub fn id(&self) -> &str {
        &self.id
    }

    /// 预览目标图层。
    pub fn layer(&self) -> LayerId {
        self.layer
    }

    /// 候选结果是否与基线不同（相同则不产生历史步骤）。
    pub fn changed(&self) -> bool {
        self.document.as_ref() != self.base.doc.as_ref()
    }

    /// 确认：一步历史；无变化不增历史。
    pub fn commit(&self, session: &mut Session) -> Result<Value> {
        if !self.changed() {
            return Ok(json!({ "changed": false, "filter": self.id, "layers": [self.layer.0] }));
        }
        crate::preview_history::commit(session, self.document.clone(), Some(Some(self.layer)), &self.label)
            .map_err(|failure| static_error("filter.draft", failure))?;
        // 草稿提交绕过 `Session::execute`，因此手动记一条日志：上游 `filter.lastFilter`
        // 正是从日志里取「最近一次滤镜 + 规范参数」。
        session.journal.push((self.id.clone(), self.params.clone()));
        Ok(json!({
            "changed": true,
            "filter": self.id,
            "layers": [self.layer.0],
            "params": self.params,
        }))
    }
}

/// 把面板输入变成规范参数：去掉目标、冻结 seed、快照颜色、规范化画廊组合。
fn canonical(session: &Session, entry: &Entry, given: &Value) -> Result<Value> {
    let mut object = match given {
        Value::Object(map) => map.clone(),
        Value::Null => Map::new(),
        _ => return Err(static_error("filter.draft", "滤镜参数必须是 JSON 对象")),
    };
    object.remove("layer");
    if entry.kind == Kind::GalleryStack {
        let normalized = gallery::normalize_stack(&Value::Object(object))?;
        object = normalized.as_object().cloned().unwrap_or_default();
    }
    if declares(entry.id, "seed") {
        // 显式给的 seed 优先；否则用 id + 参数 + 修订算一个稳定值并冻结下来。
        let provided = object
            .get("seed")
            .and_then(|value| value.as_u64().or_else(|| value.as_f64().filter(|v| v.fract() == 0.0).map(|v| v as u64)));
        let chosen = provided.unwrap_or_else(|| derive_seed(entry.id, &object, session));
        object.insert("seed".into(), json!(chosen));
    }
    if catalog::uses_colours(entry.id) {
        for (key, colour) in [("foreground", session.tools.foreground), ("background", session.tools.background)] {
            if !object.get(key).is_some_and(|value| !value.is_null()) {
                object.insert(key.into(), json!(hex(colour)));
            }
        }
    }
    Ok(Value::Object(object))
}

/// 更新时沿用上一份规范参数里的 seed 与颜色快照，其余以新输入为准。
fn canonical_from(previous: &Value, entry: &Entry, given: &Value) -> Result<Value> {
    let mut object = match given {
        Value::Object(map) => map.clone(),
        Value::Null => Map::new(),
        _ => return Err(static_error("filter.draft", "滤镜参数必须是 JSON 对象")),
    };
    object.remove("layer");
    for key in ["seed", "foreground", "background"] {
        let carries = if key == "seed" { declares(entry.id, "seed") } else { catalog::uses_colours(entry.id) };
        if carries
            && !object.contains_key(key)
            && let Some(value) = previous.get(key)
        {
            object.insert(key.into(), value.clone());
        }
    }
    Ok(Value::Object(object))
}

/// 命令是否声明了某参数。
fn declares(id: &str, key: &str) -> bool {
    catalog::params(id).iter().any(|spec| spec.key == key)
}

/// 稳定伪随机 seed：同一命令、同一参数、同一修订得到同一结果。
fn derive_seed(id: &str, params: &Map<String, Value>, session: &Session) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    feed(id.as_bytes());
    feed(&Value::Object(params.clone()).to_string().into_bytes());
    if let Some(state) = session.active() {
        feed(&state.revision.to_le_bytes());
        feed(&(session.journal.len() as u64).to_le_bytes());
    }
    hash & u64::from(u32::MAX)
}

/// `[r,g,b,a]`（0–1）→ `#rrggbb`。
fn hex(colour: [f32; 4]) -> String {
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(colour[0]), channel(colour[1]), channel(colour[2]))
}

/// 参数校验（失败时**不得**确认上一份有效预览）。
pub fn validate_filter(id: &str, params: &Value) -> Result<()> {
    if id == "filter.lastFilter" {
        return Err(static_error("filter.draft", "重复上次滤镜没有可编辑参数"));
    }
    catalog::validate(id, params)
}

/// 最近一次滤镜的规范参数（来自上游日志）；没有时返回中文原因。
pub fn last_filter(session: &Session) -> Result<(String, Value)> {
    let (id, params) = photocraft_engine::filters::last_filter(session)
        .ok_or_else(|| static_error("filter.draft", "还没有可重复的滤镜：先应用一次滤镜"))?;
    if !catalog::contains(&id) {
        return Err(static_error(
            "filter.draft",
            format!("上次的滤镜 {id} 不在已开放清单里，无法重复"),
        ));
    }
    Ok((id, params))
}

/// 把已有参数补成可再次提交的规范参数（重复上次用）。
pub fn canonical_for(session: &Session, id: &str, params: &Value) -> Result<Value> {
    let entry = catalog::entry(id)
        .ok_or_else(|| static_error("filter.draft", format!("{id} 不是已开放的参数滤镜")))?;
    canonical(session, entry, params)
}

/// 本域几何规范化的转发（面板把图内控制点换算成 0–1 相对坐标）。
pub fn normalize_point(x: f64, y: f64, width: f64, height: f64) -> Result<[f64; 2]> {
    geometry::normalize_point(x, y, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::editor::Editor;

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width": 48, "height": 32})).unwrap();
        editor.execute("layer.new.layer", json!({})).unwrap();
        editor.execute("edit.fillForeground", json!({"color": "#3366cc"})).unwrap();
        editor
    }

    fn layer(editor: &Editor) -> LayerId {
        editor.session.active().unwrap().active_layer.unwrap()
    }

    /// 纯色层上跑空间滤镜可能一像素都不变（提交因此不记历史），测试改用可分辨的图案。
    fn pattern(editor: &mut Editor) {
        editor
            .session
            .edit("图案", |doc, active| {
                let surface = doc.layer_mut(active.unwrap()).unwrap().surface_mut().unwrap();
                for y in 0..32 {
                    for x in 0..48 {
                        let value = ((x * 5 + y * 3) % 17) as f32 / 16.0;
                        surface.write_pixel(x, y, &[value, 1.0 - value, (x % 3) as f32 / 2.0, 1.0]);
                    }
                }
                Ok(())
            })
            .unwrap();
    }

    fn pixels(editor: &Editor, layer: LayerId) -> Vec<f32> {
        let doc = &editor.session.active().unwrap().doc;
        doc.layer(layer).unwrap().surface().unwrap().read_region(photocraft_geom::Rect::new(0, 0, 48, 32))
    }

    #[test]
    fn unsharp_mask_reports_every_documented_parameter() {
        let params = FilterDraft::begin(
            &editor().session,
            "filter.sharpen.unsharpMask",
            None,
            json!({"amount": 200, "radius": 3, "threshold": 8}),
        )
        .unwrap()
        .params()
        .clone();
        assert_eq!(params["amount"].as_f64(), Some(200.0));
        assert_eq!(params["radius"].as_f64(), Some(3.0));
        assert_eq!(params["threshold"].as_f64(), Some(8.0));
    }

    #[test]
    fn random_filters_freeze_one_seed_across_updates() {
        let editor = editor();
        let mut draft = FilterDraft::begin(&editor.session, "filter.noise.addNoise", None, json!({"amount": 40})).unwrap();
        let seed = draft.params()["seed"].as_u64().expect("seed");
        draft.update(json!({"amount": 90})).unwrap();
        assert_eq!(draft.params()["seed"].as_u64(), Some(seed), "拖滑杆不能换 seed");
        // 明确给 seed 时以输入为准。
        draft.update(json!({"amount": 90, "seed": 7})).unwrap();
        assert_eq!(draft.params()["seed"].as_u64(), Some(7));
    }

    #[test]
    fn displacement_maps_resolve_from_another_open_document() {
        // 位移图可以来自另一份已打开文档：预览会话必须带同一批文档，否则合法参数在预览阶段
        // 报「找不到位移图文档」，用户会以为滤镜不可用。
        let mut editor = Editor::new();
        editor.execute("file.new", json!({"width": 48, "height": 32, "name": "map"})).unwrap();
        editor.execute("layer.new.layer", json!({})).unwrap();
        editor
            .session
            .edit("map", |doc, active| {
                let surface = doc.layer_mut(active.unwrap()).unwrap().surface_mut().unwrap();
                for y in 0..32 {
                    for x in 0..48 {
                        surface.write_pixel(x, y, &[(x % 5) as f32 / 4.0, (y % 7) as f32 / 6.0, 0.5, 1.0]);
                    }
                }
                Ok(())
            })
            .unwrap();
        editor.execute("file.new", json!({"width": 48, "height": 32, "name": "target"})).unwrap();
        editor.execute("layer.new.layer", json!({})).unwrap();
        pattern(&mut editor);
        let target = layer(&editor);
        let by_name = FilterDraft::begin(&editor.session, "filter.distort.displace", Some(target), json!({"horizontal": 6, "mapDocument": "map"}))
            .expect("按文档名取位移图");
        assert!(by_name.changed(), "位移图必须真的移动像素");
        let by_index = FilterDraft::begin(&editor.session, "filter.distort.displace", Some(target), json!({"horizontal": 6, "mapDocument": 0}))
            .expect("按文档序号取位移图");
        assert!(by_index.changed());
        // 不存在的来源仍是可读错误，而不是静默使用空图。
        assert!(
            FilterDraft::begin(&editor.session, "filter.distort.displace", Some(target), json!({"mapDocument": "nope"})).is_err()
        );
    }

    #[test]
    fn preview_does_not_touch_the_document_and_commit_is_one_step() {
        let mut editor = editor();
        pattern(&mut editor);
        let target = layer(&editor);
        let before = editor.session.active().unwrap().clone();
        let mut draft =
            FilterDraft::begin(&editor.session, "filter.blur.motionBlur", Some(target), json!({"angle": 30, "distance": 6}))
                .unwrap();
        let first = draft.document.clone();
        assert_eq!(editor.session.active().unwrap().revision, before.revision, "预览不改正式修订");
        draft.update(json!({"angle": 60, "distance": 12})).unwrap();
        assert_ne!(&first, &draft.document);
        let valid = draft.document.clone();
        let valid_params = draft.params().clone();
        // 非法参数：报错且保留上一次有效预览。
        assert!(draft.update(json!({"angle": 0, "distance": 0})).is_err());
        assert_eq!(&valid, &draft.document, "非法参数不能改候选画面");
        assert_eq!(&valid_params, draft.params(), "非法参数不能改规范参数");
        let result = draft.commit(&mut editor.session).unwrap();
        assert_eq!(result["changed"], json!(true));
        assert_eq!(editor.session.active().unwrap().history.past_len(), before.history.past_len() + 1);
        editor.execute("edit.undo", json!({})).unwrap();
        assert_eq!(editor.session.active().unwrap().doc, before.doc);
    }

    #[test]
    fn committing_records_a_journal_entry_that_repeats_the_same_settings() {
        let mut editor = editor();
        pattern(&mut editor);
        let target = layer(&editor);
        let draft =
            FilterDraft::begin(&editor.session, "filter.sharpen.smartSharpen", Some(target), json!({"amount": 120, "radius": 2}))
                .unwrap();
        let expected = draft.params().clone();
        draft.commit(&mut editor.session).unwrap();
        let (id, params) = last_filter(&editor.session).unwrap();
        assert_eq!(id, "filter.sharpen.smartSharpen");
        assert_eq!(params, expected);
        // 上游「重复上次」能直接用这份规范参数。
        editor.session.execute("filter.lastFilter", json!({})).unwrap();
    }

    #[test]
    fn repeat_lasts_retargets_the_active_layer() {
        let mut editor = editor();
        pattern(&mut editor);
        let first = layer(&editor);
        let draft =
            FilterDraft::begin(&editor.session, "filter.blur.gaussianBlur", Some(first), json!({"radius": 3})).unwrap();
        draft.commit(&mut editor.session).unwrap();
        editor.execute("layer.new.layer", json!({})).unwrap();
        let second = layer(&editor);
        assert_ne!(first, second);
        let (id, params) = last_filter(&editor.session).unwrap();
        assert_eq!(params.get("layer"), None, "规范参数里不该留着旧图层 id");
        let repeat = FilterDraft::begin(&editor.session, &id, None, params).unwrap();
        assert_eq!(repeat.layer(), second);
        repeat.commit(&mut editor.session).unwrap();
        let a = pixels(&editor, first);
        let b = pixels(&editor, second);
        // 新层原为空白：重复滤镜确实落在当前活动层上。
        assert_ne!(a, b);
    }

    #[test]
    fn unchanged_candidates_do_not_add_history() {
        let mut editor = editor();
        pattern(&mut editor);
        let target = layer(&editor);
        let before = editor.session.active().unwrap().history.past_len();
        // 偏移 0 的候选与基线逐像素一致：确认时不记历史，也不写日志。
        let noop = FilterDraft::begin(&editor.session, "filter.other.offset", Some(target), json!({"horizontal": 0, "vertical": 0})).unwrap();
        assert!(!noop.changed(), "没有变化的候选不该算修改");
        assert_eq!(noop.commit(&mut editor.session).unwrap()["changed"], json!(false));
        assert_eq!(editor.session.active().unwrap().history.past_len(), before);
        assert!(last_filter(&editor.session).is_err(), "未生效的确认不该污染「重复上次」");
        // 真正改像素的滤镜只记一步。
        let draft =
            FilterDraft::begin(&editor.session, "filter.blur.gaussianBlur", Some(target), json!({"radius": 2})).unwrap();
        assert!(draft.changed());
        draft.commit(&mut editor.session).unwrap();
        assert_eq!(editor.session.active().unwrap().history.past_len(), before + 1);
    }

    #[test]
    fn unknown_and_non_pixel_targets_are_refused_before_rendering() {
        let mut editor = editor();
        assert!(FilterDraft::begin(&editor.session, "filter.liquify", None, json!({})).is_err());
        assert!(FilterDraft::begin(&editor.session, "filter.blur.gaussianBlur", Some(LayerId(u64::MAX)), json!({})).is_err());
        // 文字层必须显式栅格化。
        editor.execute("layer.new.text", json!({"text": "hi"})).ok();
        if let Some(state) = editor.session.active()
            && let Some(id) = state.active_layer
            && matches!(state.doc.layer(id).map(|l| &l.content), Some(photocraft_doc::LayerContent::Text(_)))
        {
            assert!(FilterDraft::begin(&editor.session, "filter.blur.gaussianBlur", Some(id), json!({"radius": 1})).is_err());
        }
    }

    /// 非像素目标的拒绝必须挂在滤镜域的命令 id 上。
    ///
    /// 共享的 `writable_pixel_layer` 同时服务笔刷，原因里写的是 `paint.target`；滤镜用户看到
    /// 它会以为自己误触了画笔。这里钉住命令 id 与可操作原因都在。
    #[test]
    fn non_pixel_targets_report_the_filter_command_not_the_brush() {
        let mut editor = editor();
        editor.execute("layer.newAdjustmentLayer.brightnessContrast", json!({"brightness": 10, "contrast": 0})).unwrap();
        let state = editor.session.active().expect("active");
        let target = state.active_layer.expect("adjustment layer is active");
        let error = match FilterDraft::begin(&editor.session, "filter.blur.gaussianBlur", Some(target), json!({"radius": 4})) {
            Ok(_) => panic!("调整图层不能作为滤镜目标"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "command-failed");
        let crate::error::EditorError::CommandFailed { id, message } = &error else {
            panic!("期望 command-failed，得到 {error:?}");
        };
        assert_eq!(id, "filter.draft", "原因要挂在滤镜域，不是 paint.target");
        assert!(message.contains("该图层类型不支持像素绘画"), "保留可操作原因：{message}");
    }

    #[test]
    fn filters_needing_a_map_refuse_local_paths() {
        let editor = editor();
        assert!(
            FilterDraft::begin(&editor.session, "filter.distort.displace", None, json!({"mapPath": "/tmp/map.png"})).is_err()
        );
        assert!(
            FilterDraft::begin(&editor.session, "filter.distort.displace", None, json!({"horizontal": 10})).is_err(),
            "缺位移图必须拒绝"
        );
    }

    #[test]
    fn gallery_stacks_are_normalized_before_rendering() {
        let editor = editor();
        let draft = FilterDraft::begin(
            &editor.session,
            "filter.filterGallery",
            None,
            json!({"effects": [{"filter": "cutout", "params": {"numberOfLevels": 5}}]}),
        )
        .unwrap();
        let effects = draft.params()["effects"].as_array().expect("effects");
        assert_eq!(effects[0]["params"]["numberOfLevels"].as_f64(), Some(5.0));
        assert!(effects[0]["params"]["edgeFidelity"].is_number(), "缺省参数被补齐");
    }

    #[test]
    fn vanishing_point_requires_real_planes() {
        let editor = editor();
        assert!(FilterDraft::begin(&editor.session, "filter.vanishingPoint", None, json!({})).is_err());
    }
}
