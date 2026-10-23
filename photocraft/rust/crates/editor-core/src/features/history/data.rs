//! U76 的数据驱动部分：变量、数据集、CSV 与「数据集导出为文件」
//! （change: 2026-10-22-add-photocraft-history-automation-workflows）。
//!
//! 上游 `image.variables.*` / `image.applyDataSet` 里有两条路径依赖，浏览器不可用：
//!
//! - `file.import.variableDataSets` / `file.export.dataSetsAsFiles` 接受**文件夹路径**；
//! - 像素替换变量的值是**磁盘路径**，应用时 `std::fs::read`。
//!
//! 因此本域用字节/文本重写这三处（design D3「输入/输出经字节端口」）：
//!
//! - CSV 由 [`super::csv`] 解析/生成，文本来自宿主读出的文件字节；
//! - 数据集的像素值是**宿主资源键**，应用时由调用方交出 `{key: base64 字节}`；
//! - 「导出为文件」返回每个数据集的编码字节，由宿主交付（不写目录）。
//!
//! 内容写入仍走 `Session::execute` / `Session::edit`（一步撤销），失败保留现场。
use std::collections::HashMap;

use photocraft_doc::text::{ParagraphRun, TextRun};
use photocraft_doc::variables::{VarKind, Value as VarValue};
use photocraft_doc::{DataValue, Document, LayerContent, PixelAlign, PixelMethod, Surface};
use serde_json::{Value, json};

use crate::error::{EditorError, Result};
use crate::editor::*;
use super::command_error;
use super::csv;

/// 单个数据集的替换预算：只允许 8 位 RGB/灰度文档（首期内核的唯一模式）。
const MAX_REPLACE_SIDE: u32 = photocraft_project_verify::limits::MAX_CANVAS_SIDE;

/// 一次「数据集导出为文件」的字节上限（32 MiB，多数据集共享）。
const MAX_EXPORT_BYTES: usize = 32 * 1024 * 1024;
/// 一次导出的数据集数量上限。
const MAX_EXPORT_SETS: usize = 64;

/// CSV 文本的字节上限（8 MiB，与 `.atn` 同量级）。
///
/// 预算在**解析之前**按文本字节判定：先 `csv::parse` 再数行数，等于让任意大的输入先被
/// 完整切分一遍；数据集是会随工程持久化的内容，不能无界增长。
pub const MAX_CSV_BYTES: usize = 8 * 1024 * 1024;
/// 一份文档的数据集数量上限。
pub const MAX_DATA_SETS: usize = 1024;
/// 单个数据集的取值数量上限。
pub const MAX_VALUES_PER_SET: usize = 512;
/// 一份文档的变量定义数量上限。
pub const MAX_VARIABLES: usize = 256;

/// 变量/数据集的预算，供面板在读取文件**之前**做同样的拒绝。
pub fn variables_budget() -> Value {
    json!({
        "maxCsvBytes": MAX_CSV_BYTES,
        "maxDataSets": MAX_DATA_SETS,
        "maxValuesPerSet": MAX_VALUES_PER_SET,
        "maxVariables": MAX_VARIABLES,
    })
}

impl Editor {
    /// 变量与数据集的只读视图（`{defs, dataSets, active, budget}`）。
    ///
    /// `budget` 由本域补上：面板要在读文件之前就拒绝超预算的 CSV/数据集，而共享的
    /// `variables.list` 只描述当前内容，不带预算。
    pub fn variables_state(&mut self) -> Result<Value> {
        let mut state = self
            .session
            .execute("variables.list", Value::Null)
            .map_err(|failure| command_error("variables.list", failure))?;
        if let Some(object) = state.as_object_mut() {
            object.insert("budget".into(), variables_budget());
        }
        Ok(state)
    }

    /// 定义变量：`{defs:[{name, layer, type:visibility|textReplacement|pixelReplacement, …}]}`。
    ///
    /// 绑定前先核对**种类与图层内容**：上游 `image.variables.define` 只检查图层存在，因此把
    /// 文字替换变量绑到像素层会在应用数据集时被静默跳过——用户建了一个永远不会生效的变量。
    /// 这里按图层内容拒绝，错误信息指出具体变量与图层。
    pub fn variables_define(&mut self, params: Value) -> Result<Value> {
        self.require_no_tool_draft()?;
        if let Some(defs) = params.get("defs").and_then(Value::as_array) {
            if defs.len() > MAX_VARIABLES {
                return Err(command_error(
                    "image.variables.define",
                    format!("变量数量超过上限（{MAX_VARIABLES}），当前 {}", defs.len()),
                ));
            }
            check_variable_layers(&self.active_doc()?.doc, defs)?;
        }
        self.gated("image.variables.define", params)
    }

    /// 直接设置数据集（`append` 决定追加或替换）。
    ///
    /// 数量预算按**设置之后**的总量判定：`append` 是累加，只看本次提交会漏放。
    ///
    /// 替换之后会**重映射 `active`**（见 [`Self::remap_active_data_set`]）：上游只保存一个下标，
    /// 整份替换后它仍指向旧的序号，删掉排在前面的数据集就会让「当前生效」错位到另一组。
    pub fn data_sets_set(&mut self, params: Value) -> Result<Value> {
        self.require_no_tool_draft()?;
        if let Some(rows) = params.get("dataSets").and_then(Value::as_array) {
            let append = params.get("append").and_then(Value::as_bool).unwrap_or(false);
            let existing = if append { self.active_doc()?.doc.variables.data_sets.len() } else { 0 };
            let total = existing.saturating_add(rows.len());
            if total > MAX_DATA_SETS {
                return Err(command_error(
                    "image.variables.dataSets",
                    format!("数据集数量超过上限（{MAX_DATA_SETS}），设置后会有 {total} 个"),
                ));
            }
            for row in rows {
                let values = row.get("values").and_then(Value::as_array).map_or(0, Vec::len);
                if values > MAX_VALUES_PER_SET {
                    let name = row.get("name").and_then(Value::as_str).unwrap_or("?");
                    return Err(command_error(
                        "image.variables.dataSets",
                        format!("数据集 `{name}` 有 {values} 个取值，超过单个数据集上限（{MAX_VALUES_PER_SET}）"),
                    ));
                }
            }
        }
        // 替换语义下要按**名称**把当前生效的那组重新定位；否则「删掉 A」会让 active 从 1 变 0
        // 之前的旧值原样留下，界面标错「当前生效」，用户以为删除没影响画布。
        let previous = self.active_doc()?.doc.variables.active;
        let append = params.get("append").and_then(Value::as_bool).unwrap_or(false);
        let before = self.active_doc()?.doc.variables.data_sets.clone();
        let mut state = self.gated("image.variables.dataSets", params)?;
        let remapped = self.remap_active_data_set(previous, &before, append)?;
        if let Some(object) = state.as_object_mut() {
            object.insert("active".into(), remapped.map_or(Value::Null, |index| json!(index)));
        }
        Ok(state)
    }

    /// 整份替换数据集之后，把「当前生效」重新定位到同一组（按名称，不按下标）。
    ///
    /// 返回 `None` 表示当前没有任何生效的数据集：原来那组被删掉了，或者本来就没有。
    fn remap_active_data_set(
        &mut self,
        previous: Option<usize>,
        before: &[photocraft_doc::DataSet],
        append: bool,
    ) -> Result<Option<usize>> {
        let Some(previous) = previous else { return Ok(None) };
        // 追加语义下原有一组仍然在同一个下标上；只有替换才需要重新定位。
        if append {
            return Ok(Some(previous));
        }
        let Some(name) = before.get(previous).map(|set| set.name.clone()) else { return Ok(None) };
        let state = self.active_doc()?;
        let Some(index) = state.doc.variables.data_sets.iter().position(|set| set.name == name) else {
            // 生效的那组被删了：清掉 `active`，而不是留一个指向别人的越界下标。
            self.set_active_data_set(None)?;
            return Ok(None);
        };
        if index != previous {
            self.set_active_data_set(Some(index))?;
        }
        Ok(Some(index))
    }

    /// 写回 `active`：这是**配置**而不是画布编辑，不新增历史步骤（与上游 `apply_data_set` 一致）。
    fn set_active_data_set(&mut self, index: Option<usize>) -> Result<()> {
        let state = self.session.active_mut().ok_or(EditorError::NoDocument)?;
        let mut doc = (*state.doc).clone();
        doc.variables.active = index;
        state.doc = std::sync::Arc::new(doc);
        // 与 `apply data set` 同一口径：改 `active` 是配置变更，推进修订号但不新增历史步骤。
        state.revision = state.revision.saturating_add(1);
        Ok(())
    }

    /// 由 CSV 文本导入数据集。
    ///
    /// 表头是变量名，第一列可以是数据集名称（留空或写 `DataSet`）。没有对应变量定义的列会被
    /// 报告（`skipped`）而不是静默丢数据；没有任何定义时直接拒绝，因为每一列都无处可放。
    pub fn data_sets_import(&mut self, params: Value, text: &str) -> Result<Value> {
        // 预算是**解析前**的字节上限：先切分再判断等于让任意大的输入先被完整处理一遍。
        if text.len() > MAX_CSV_BYTES {
            return Err(command_error(
                "file.import.variableDataSets",
                format!("CSV 超过上限（{} MiB），收到 {} 字节", MAX_CSV_BYTES / 1024 / 1024, text.len()),
            ));
        }
        let vars = self.active_doc()?.doc.variables.clone();
        if vars.defs.is_empty() {
            return Err(command_error(
                "file.import.variableDataSets",
                "还没有变量定义：请先在「变量与数据集」里把图层绑定到变量，再导入 CSV",
            ));
        }
        let delimiter = params
            .get("delimiter")
            .and_then(Value::as_str)
            .and_then(|value| value.chars().next())
            .unwrap_or(',');
        let parsed = csv::parse(text, &vars, delimiter);
        if parsed.sets.is_empty() {
            return Err(command_error("file.import.variableDataSets", "CSV 里没有数据行"));
        }
        let append = params.get("append").and_then(Value::as_bool).unwrap_or(false);
        // 数据集会随工程持久化：数量预算按导入后的总量判定，别让 append 无界累加。
        let existing = if append { vars.data_sets.len() } else { 0 };
        if existing.saturating_add(parsed.sets.len()) > MAX_DATA_SETS {
            return Err(command_error(
                "file.import.variableDataSets",
                format!(
                    "导入后会有 {} 个数据集，超过上限（{MAX_DATA_SETS}）",
                    existing + parsed.sets.len()
                ),
            ));
        }
        let payload = json!({
            "dataSets": parsed.sets.iter().map(|set| serde_json::to_value(set).unwrap_or(Value::Null)).collect::<Vec<_>>(),
            "append": append,
        });
        let mut state = self.data_sets_set(payload)?;
        if let Some(object) = state.as_object_mut() {
            object.insert("imported".into(), json!(parsed.sets.len()));
            object.insert("named".into(), json!(parsed.named));
            object.insert("skipped".into(), json!(parsed.skipped));
        }
        Ok(state)
    }

    /// 导出当前数据集为 CSV 文本（与 [`Self::data_sets_import`] 同一套规则，可往返）。
    pub fn data_sets_export_csv(&self) -> Result<Value> {
        let vars = &self.active_doc()?.doc.variables;
        let text = csv::emit(vars);
        Ok(json!({
            "text": text,
            "dataSets": vars.data_sets.len(),
            "variables": vars.defs.len(),
        }))
    }

    /// 应用一个数据集：显隐/文字/像素各按其变量种类写入，一步撤销。
    ///
    /// `images` 是像素替换变量的资源键 → base64 字节。缺字节即拒绝整次应用（不保留旧像素冒充
    /// 成功）。应用成功后记录 `active`，与上游一致。
    pub fn data_sets_apply(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        // 内容写入仍过唯一命令门（`image.applyDataSet` 已登记，只是实现走本域字节入口）。
        if !crate::capability::command_allowed("image.applyDataSet") {
            return Err(EditorError::CapabilityDisabled("image.applyDataSet".into()));
        }
        let state = self.active_doc()?;
        let vars = state.doc.variables.clone();
        let (set, index) = resolve_set(&vars, &params)?;
        let images = decode_images(params.get("images"))?;
        // 预检：像素变量必须有字节，且都能解码；否则整体拒绝。
        let mut decoded: HashMap<String, Surface> = HashMap::new();
        {
            let format = state.doc.pixel_format();
            for value in &set.values {
                let DataValue { variable, value: VarValue::Pixels(key) } = value else { continue };
                let Some(def) = vars.def(variable.as_str()) else { continue };
                let VarKind::PixelReplacement { .. } = def.kind else { continue };
                let bytes = images.get(key).ok_or_else(|| {
                    command_error(
                        "image.applyDataSet",
                        format!("数据集的像素变量 `{variable}` 指向资源 `{key}`，但没有提供它的字节"),
                    )
                })?;
                let surface = decode_surface(key, bytes, format)?;
                decoded.insert(variable.clone(), surface);
            }
        }
        let label = format!("Apply Data Set \"{}\"", set.name);
        self.session
            .edit(&label, |doc, _| {
                apply_set(doc, &vars, &set, &decoded)
                    .map_err(photocraft_engine::EngineError::Other)
            })
            .map_err(|failure| command_error("image.applyDataSet", failure))?;
        // `active` 与上游一致：配置而非画布编辑，不新增历史步骤。
        {
            let state = self.session.active_mut().ok_or(EditorError::NoDocument)?;
            let mut doc = (*state.doc).clone();
            doc.variables.active = Some(index);
            state.doc = std::sync::Arc::new(doc);
            state.revision = state.revision.saturating_add(1);
        }
        Ok(json!({ "applied": set.name, "index": index, "variables": self.variables_state()? }))
    }

    /// 把每个数据集应用后导出为编码字节（不写目录）。
    ///
    /// `format` 默认 `png`；`dataSets` 可只导出指定名称；`naming` 支持 `{name}`/`{index}`/`{document}`。
    /// 文件名冲突在任何编码开始前就被拒绝。
    pub fn data_sets_export_files(&self, params: Value) -> Result<Value> {
        let state = self.active_doc()?;
        let vars = &state.doc.variables;
        if vars.data_sets.is_empty() {
            return Err(command_error("file.export.dataSetsAsFiles", "没有可导出的数据集"));
        }
        let format = params.get("format").and_then(Value::as_str).unwrap_or("png");
        if !matches!(format, "png" | "jpg" | "jpeg" | "tif" | "tiff") {
            return Err(command_error(
                "file.export.dataSetsAsFiles",
                format!("首期只支持 png/jpg/tif 交付，收到 `{format}`"),
            ));
        }
        let wanted: Option<Vec<String>> = params
            .get("dataSets")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect());
        let sets: Vec<_> = vars
            .data_sets
            .iter()
            .filter(|set| wanted.as_ref().is_none_or(|names| names.contains(&set.name)))
            .collect();
        if sets.is_empty() {
            return Err(command_error("file.export.dataSetsAsFiles", "选中的数据集不存在"));
        }
        if sets.len() > MAX_EXPORT_SETS {
            return Err(command_error(
                "file.export.dataSetsAsFiles",
                format!("一次最多导出 {MAX_EXPORT_SETS} 个数据集，当前 {} 个", sets.len()),
            ));
        }
        let images = decode_images(params.get("images"))?;
        let template = params.get("naming").and_then(Value::as_str).unwrap_or("{name}");
        let stem = state.doc.name.rsplit_once('.').map_or(state.doc.name.as_str(), |(base, _)| base).to_string();
        // 先规划整批文件名：命名模板可能让两个数据集撞名。
        let mut claimed = HashMap::new();
        let mut planned = Vec::with_capacity(sets.len());
        for (offset, set) in sets.iter().enumerate() {
            let safe: String = set
                .name
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect();
            let name = template
                .replace("{name}", &safe)
                .replace("{index}", &format!("{:03}", offset + 1))
                .replace("{document}", &stem);
            let file = format!("{name}.{format}");
            if let Some(first) = claimed.insert(file.to_lowercase(), set.name.clone()) {
                return Err(command_error(
                    "file.export.dataSetsAsFiles",
                    format!("数据集 `{first}` 与 `{}` 会写成同一个文件 `{file}`；请在命名里加 {{index}}", set.name),
                ));
            }
            planned.push(((*set).clone(), file));
        }
        let mut files = Vec::with_capacity(planned.len());
        let mut total = 0usize;
        for (set, file) in planned {
            let mut doc = (*state.doc).clone();
            let mut decoded: HashMap<String, Surface> = HashMap::new();
            for value in &set.values {
                let DataValue { variable, value: VarValue::Pixels(key) } = value else { continue };
                let Some(def) = vars.def(variable.as_str()) else { continue };
                if !matches!(def.kind, VarKind::PixelReplacement { .. }) {
                    continue;
                }
                let bytes = images.get(key).ok_or_else(|| {
                    command_error(
                        "file.export.dataSetsAsFiles",
                        format!("数据集 `{}` 的像素变量 `{variable}` 缺少资源 `{key}` 的字节", set.name),
                    )
                })?;
                decoded.insert(variable.clone(), decode_surface(key, bytes, doc.pixel_format())?);
            }
            apply_set(&mut doc, vars, &set, &decoded)
                .map_err(|failure| command_error("file.export.dataSetsAsFiles", failure))?;
            if doc.layers.iter().all(|layer| matches!(layer.content, LayerContent::Raster(_)) || !layer.visible) {
                // 数据集只改显隐/文字/像素；这里仍按完整合成导出。
            }
            let bytes = photocraft_io::export(&doc, format, &photocraft_io::ExportOptions::default())
                .map_err(|failure| command_error("file.export.dataSetsAsFiles", failure))?
                .bytes;
            total = total.saturating_add(bytes.len());
            if total > MAX_EXPORT_BYTES {
                return Err(command_error(
                    "file.export.dataSetsAsFiles",
                    format!("导出总字节超过上限（{} MiB）", MAX_EXPORT_BYTES / 1024 / 1024),
                ));
            }
            files.push(json!({
                "name": set.name,
                "fileName": file,
                "bytes": bytes.len(),
                "data": photocraft_paint::tile::b64_encode(&bytes),
            }));
        }
        Ok(json!({ "files": files, "count": files.len(), "bytes": total }))
    }

    /// 内容命令的统一入口：先过唯一命令门，再走 `Session::execute`。
    fn gated(&mut self, id: &str, params: Value) -> Result<Value> {
        if !crate::capability::command_allowed(id) {
            return Err(EditorError::CapabilityDisabled(id.into()));
        }
        self.session
            .execute(id, params)
            .map_err(|failure| command_error(id, failure))
    }
}

/// 变量定义与目标图层的内容种类必须相容。
///
/// 上游只检查图层存在，所以「把文字替换变量绑到像素层」能定义成功、但应用数据集时被
/// `apply_to_doc` 静默跳过。用户会以为变量已生效。这里提前拒绝并指出具体变量。
fn check_variable_layers(doc: &Document, defs: &[Value]) -> Result<()> {
    for def in defs {
        let name = def.get("name").and_then(Value::as_str).unwrap_or("?");
        let Some(layer_id) = def.get("layer").and_then(Value::as_u64) else { continue };
        let Some(layer) = doc.layer(photocraft_doc::LayerId(layer_id)) else {
            // 图层不存在由上游用 `NoLayer` 报错；这里不重复实现它的错误码。
            continue;
        };
        let kind = var_kind(def).ok_or_else(|| {
            command_error(
                "image.variables.define",
                format!("变量 `{name}` 的 type 必须是 visibility/textReplacement/pixelReplacement"),
            )
        })?;
        let compatible = match kind {
            VarKind::Visibility => true,
            VarKind::TextReplacement => matches!(layer.content, LayerContent::Text(_)),
            VarKind::PixelReplacement { .. } => {
                matches!(layer.content, LayerContent::Raster(_) | LayerContent::Smart(_))
            }
        };
        if !compatible {
            return Err(command_error(
                "image.variables.define",
                format!(
                    "变量 `{name}` 是{}变量，但图层 `{}` 是{}：应用数据集时这一步会被跳过",
                    kind_label(&kind),
                    layer.name,
                    content_label(&layer.content)
                ),
            ));
        }
    }
    Ok(())
}

/// 从定义里读变量种类（与上游 `parse_kind` 同一组写法）。
fn var_kind(def: &Value) -> Option<VarKind> {
    let kind = def.get("kind").and_then(Value::as_str).or_else(|| def.get("type").and_then(Value::as_str))?;
    Some(match kind {
        "visibility" => VarKind::Visibility,
        "textReplacement" => VarKind::TextReplacement,
        "pixelReplacement" => VarKind::PixelReplacement {
            method: pixel_method(def.get("method").and_then(Value::as_str)),
            align: pixel_align(def.get("align").and_then(Value::as_str)),
            clip: def.get("clip").and_then(Value::as_bool).unwrap_or(false),
        },
        _ => return None,
    })
}

fn pixel_method(value: Option<&str>) -> PixelMethod {
    match value {
        Some("fill") => PixelMethod::Fill,
        Some("asIs") => PixelMethod::AsIs,
        Some("conform") => PixelMethod::Conform,
        _ => PixelMethod::Fit,
    }
}

fn pixel_align(value: Option<&str>) -> PixelAlign {
    match value {
        Some("topLeft") => PixelAlign::TopLeft,
        Some("topCenter") => PixelAlign::TopCenter,
        Some("topRight") => PixelAlign::TopRight,
        Some("centerLeft") => PixelAlign::CenterLeft,
        Some("centerRight") => PixelAlign::CenterRight,
        Some("bottomLeft") => PixelAlign::BottomLeft,
        Some("bottomCenter") => PixelAlign::BottomCenter,
        Some("bottomRight") => PixelAlign::BottomRight,
        _ => PixelAlign::Center,
    }
}

fn kind_label(kind: &VarKind) -> &'static str {
    match kind {
        VarKind::Visibility => "显隐",
        VarKind::TextReplacement => "文字替换",
        VarKind::PixelReplacement { .. } => "像素替换",
    }
}

fn content_label(content: &LayerContent) -> &'static str {
    match content {
        LayerContent::Raster(_) => "像素层",
        LayerContent::Text(_) => "文字层",
        LayerContent::Smart(_) => "智能对象",
        LayerContent::Shape(_) => "形状层",
        LayerContent::Adjustment(_) => "调整层",
        LayerContent::Fill(_) => "填充层",
        LayerContent::Group(_) => "图层组",
    }
}

/// 解析 `{name}` 或 `{index}` 选中数据集。
fn resolve_set(
    vars: &photocraft_doc::Variables,
    params: &Value,
) -> crate::error::Result<(photocraft_doc::DataSet, usize)> {
    if let Some(name) = params.get("name").and_then(Value::as_str) {
        let index = vars
            .data_set_index(name)
            .ok_or_else(|| command_error("image.applyDataSet", format!("没有名为 `{name}` 的数据集")))?;
        return Ok((vars.data_sets[index].clone(), index));
    }
    if let Some(index) = params.get("index").and_then(Value::as_u64) {
        let index = usize::try_from(index).unwrap_or(usize::MAX);
        let set = vars
            .data_sets
            .get(index)
            .cloned()
            .ok_or_else(|| command_error("image.applyDataSet", format!("没有索引为 {index} 的数据集")))?;
        return Ok((set, index));
    }
    Err(command_error("image.applyDataSet", "需要 name 或 index 选中数据集"))
}

/// 解析宿主交出的资源字节：`{key: base64}`。
fn decode_images(value: Option<&Value>) -> Result<HashMap<String, Vec<u8>>> {
    let mut out = HashMap::new();
    let Some(entries) = value.and_then(Value::as_object) else { return Ok(out) };
    for (key, data) in entries {
        let text = data.as_str().ok_or_else(|| {
            command_error("image.applyDataSet", format!("资源 `{key}` 的字节必须是 base64 字符串"))
        })?;
        let bytes = photocraft_paint::tile::b64_decode(text)
            .ok_or_else(|| command_error("image.applyDataSet", format!("资源 `{key}` 不是合法 base64")))?;
        out.insert(key.clone(), bytes);
    }
    Ok(out)
}

/// 解码替换像素并转成目标文档格式；尺寸超预算即拒绝。
fn decode_surface(key: &str, bytes: &[u8], format: photocraft_color::PixelFormat) -> Result<Surface> {
    let decoded = photocraft_codecs::decode_with(
        bytes,
        &photocraft_codecs::DecodeOptions {
            limits: photocraft_codecs::Limits {
                max_width: MAX_REPLACE_SIDE,
                max_height: MAX_REPLACE_SIDE,
                max_pixels: photocraft_project_verify::limits::MAX_CANVAS_PIXELS,
                max_alloc: photocraft_project_verify::limits::MAX_DECOMPRESSED_RESOURCE_BYTES,
            },
            ..Default::default()
        },
    )
    .map_err(|failure| command_error("image.applyDataSet", format!("资源 `{key}` 无法解码：{failure}")))?;
    let (width, height) = decoded.dimensions();
    if width == 0 || height == 0 {
        return Err(command_error("image.applyDataSet", format!("资源 `{key}` 没有像素")));
    }
    let rgba = decoded.to_rgba8();
    let mut surface = Surface::new(photocraft_color::PixelFormat::RGBA8);
    let rect = photocraft_geom::Rect::from_xywh(0, 0, width, height);
    surface.write_interleaved(rect, &rgba);
    Ok(if format == photocraft_color::PixelFormat::RGBA8 { surface } else { surface.convert(format) })
}

/// 把数据集写进文档：显隐、文字（保留首字符样式）与像素替换。
fn apply_set(
    doc: &mut Document,
    vars: &photocraft_doc::Variables,
    set: &photocraft_doc::DataSet,
    images: &HashMap<String, Surface>,
) -> std::result::Result<(), String> {
    for value in &set.values {
        let Some(def) = vars.def(&value.variable) else { continue };
        match (&def.kind, &value.value) {
            (VarKind::Visibility, VarValue::Visibility(show)) => {
                if let Some(layer) = doc.layer_mut(def.layer) {
                    layer.visible = *show;
                }
            }
            (VarKind::TextReplacement, VarValue::Text(text)) => {
                let snapshot = doc.clone();
                if let Some(layer) = doc.layer_mut(def.layer)
                    && let LayerContent::Text(current) = &mut layer.content
                {
                    let style = current.char_runs().into_iter().next().map(|run| run.style).unwrap_or_default();
                    let paragraph = current.paragraph_runs().into_iter().next().map(|run| run.style).unwrap_or_default();
                    current.text.clone_from(text);
                    current.runs = vec![TextRun { len: current.text.len(), style }];
                    current.paragraphs = vec![ParagraphRun { len: current.text.len(), style: paragraph }];
                    current.sync_summary();
                    // 合成器读文字层缓存：不刷新会显示旧内容。
                    photocraft_engine::type_cmds::refresh(&snapshot, current);
                }
            }
            (VarKind::PixelReplacement { method, align, clip }, VarValue::Pixels(_)) => {
                let Some(source) = images.get(&value.variable) else { continue };
                replace_pixels(doc, def.layer, source, *method, *align, *clip)?;
            }
            _ => {}
        }
    }
    Ok(())
}

/// 用已解码的表面替换像素层内容（缩放/对齐/裁剪与上游一致）。
fn replace_pixels(
    doc: &mut Document,
    layer: photocraft_doc::LayerId,
    source: &Surface,
    method: PixelMethod,
    align: PixelAlign,
    clip: bool,
) -> std::result::Result<(), String> {
    let target = doc
        .layer(layer)
        .and_then(photocraft_doc::Layer::surface)
        .map(Surface::content_bounds)
        .filter(|rect| !rect.is_empty())
        .unwrap_or_else(|| doc.bounds());
    if target.is_empty() {
        return Ok(());
    }
    let source_bounds = source.content_bounds();
    if source_bounds.is_empty() {
        return Ok(());
    }
    let (iw, ih) = (f64::from(source_bounds.width()), f64::from(source_bounds.height()));
    let (tw, th) = (f64::from(target.width()), f64::from(target.height()));
    let (sx, sy) = match method {
        PixelMethod::Fit => {
            let scale = (tw / iw).min(th / ih);
            (scale, scale)
        }
        PixelMethod::Fill => {
            let scale = (tw / iw).max(th / ih);
            (scale, scale)
        }
        PixelMethod::Conform => (tw / iw, th / ih),
        PixelMethod::AsIs => (1.0, 1.0),
    };
    let scaled = if (sx - 1.0).abs() > 1e-9 || (sy - 1.0).abs() > 1e-9 {
        photocraft_algo::resample::resize_surface(source, sx, sy, photocraft_algo::resample::Resample::Bicubic)
    } else {
        source.clone()
    };
    let (sw, sh) = (iw * sx, ih * sy);
    let fx = match align {
        PixelAlign::TopLeft | PixelAlign::CenterLeft | PixelAlign::BottomLeft => 0.0,
        PixelAlign::TopRight | PixelAlign::CenterRight | PixelAlign::BottomRight => 1.0,
        _ => 0.5,
    };
    let fy = match align {
        PixelAlign::TopLeft | PixelAlign::TopCenter | PixelAlign::TopRight => 0.0,
        PixelAlign::BottomLeft | PixelAlign::BottomCenter | PixelAlign::BottomRight => 1.0,
        _ => 0.5,
    };
    let dx = (f64::from(target.x0) + (tw - sw) * fx).round() as i32;
    let dy = (f64::from(target.y0) + (th - sh) * fy).round() as i32;
    let placed = photocraft_algo::resample::translate_surface(&scaled, dx, dy);
    let placed = if clip {
        photocraft_algo::resample::crop_surface(&placed, target)
    } else {
        placed
    };
    if let Some(layer) = doc.layer_mut(layer)
        && let LayerContent::Raster(surface) = &mut layer.content
    {
        *surface = placed;
    }
    Ok(())
}
