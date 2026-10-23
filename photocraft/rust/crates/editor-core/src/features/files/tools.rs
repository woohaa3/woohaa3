//! U01–U04 的内核入口：文档创建、整份复制、File Info、新建预设/最近设置与基线恢复。
//!
//! 统一规则（与其余域相同）：
//! - 任何内容写入先过既有草稿门禁（`require_no_stroke` / `require_no_tool_draft`）；
//! - 只经 `Editor::execute` 走唯一命令门，不绕过 `command_allowed`；
//! - 资源上限以 `photocraft_project_verify` 的共享上限为准，不另立一套；
//! - 失败返回带稳定 code 的 [`EditorError`]，不产生半成品文档。
//!
//! 文档槽位（最多 8 个标签）、标签注册与批量关闭的串行结算归共享工作区与宿主适配；
//! 本域只提供它们需要的语义原子操作（在**没有**活动文档的候选实例上新建，或把整份文档复制成
//! 自包含工程字节），不复制第二份文档状态、不伪造 Woohaa 节点。
use serde_json::{json, Value};

use crate::editor::Editor;
use crate::error::{EditorError, Result};

use super::command_error;

/// File Info 单字段上限（字符数）：有界、可核验，超限直接拒绝而不是截断。
const MAX_FILE_INFO_FIELD_CHARS: usize = 4096;
/// File Info 关键字条目数与单条上限。
const MAX_FILE_INFO_KEYWORDS: usize = 256;
const MAX_FILE_INFO_KEYWORD_CHARS: usize = 256;
/// File Info 全部已知字段的累计上限（字符数）。
const MAX_FILE_INFO_TOTAL_CHARS: usize = 64 * 1024;
/// 文档名上限（与引擎预设名一致）。
const MAX_DOCUMENT_NAME_CHARS: usize = 255;
/// 分辨率上限（与引擎 `document_preset_cmds::MAX_RESOLUTION` 一致）。
const MAX_RESOLUTION: f64 = 30_000.0;

/// File Info 允许的已知字段（其余键拒绝，避免拼写错误静默变成只读）。
const FILE_INFO_FIELDS: &[&str] = &[
    "title",
    "author",
    "authorTitle",
    "description",
    "keywords",
    "copyright",
    "copyrightStatus",
    "copyrightUrl",
];
const COPYRIGHT_STATES: &[&str] = &["unknown", "copyrighted", "publicDomain"];

/// 新建参数允许的键（未知键拒绝，避免把界面拼写错误静默忽略）。
const NEW_DOCUMENT_KEYS: &[&str] = &["width", "height", "resolution", "mode", "depth", "background", "name"];
/// 预设设置允许的键（比新建多出显示单位；`backgroundColor` 由引擎按捕获颜色处理）。
const PRESET_SETTING_KEYS: &[&str] = &[
    "width",
    "height",
    "resolution",
    "mode",
    "depth",
    "background",
    "backgroundColor",
    "unit",
    "resolutionUnit",
];

/// 通过内核校验后的新建文档参数（只保留本运行时真正支持的子集：RGB/U8）。
struct NewDocumentSpec {
    name: String,
    width: u32,
    height: u32,
    resolution: f64,
    background: String,
}

impl NewDocumentSpec {
    fn kernel_params(&self) -> Value {
        json!({
            "width": self.width,
            "height": self.height,
            "resolution": self.resolution,
            "background": self.background,
            "name": self.name,
        })
    }

    /// 与 `file.new` 相同的设置（`document.recent.add` 的 `settings` 形状）。
    fn recent_settings(&self) -> Value {
        json!({
            "width": self.width,
            "height": self.height,
            "resolution": self.resolution,
            "mode": "rgb",
            "depth": 8,
            "background": self.background,
        })
    }

    fn report(&self, state: Value) -> Value {
        json!({
            "state": state,
            "name": self.name,
            "width": self.width,
            "height": self.height,
            "resolution": self.resolution,
            "mode": "rgb",
            "depth": 8,
            "background": self.background,
        })
    }
}

fn bad(id: &str, message: impl std::fmt::Display) -> EditorError {
    command_error(id, message)
}

/// 校验文档名：去空白后 1–255 字符；空字符串按默认名处理。
fn document_name(params: &Value, id: &str) -> Result<String> {
    let raw = match params.get("name") {
        None | Some(Value::Null) => return Ok("未命名".into()),
        Some(value) => value
            .as_str()
            .ok_or_else(|| bad(id, "`name` 必须是字符串"))?,
    };
    let name = raw.trim();
    if name.chars().count() > MAX_DOCUMENT_NAME_CHARS {
        return Err(bad(id, format!("文档名不能超过 {MAX_DOCUMENT_NAME_CHARS} 个字符")));
    }
    if name.is_empty() {
        return Ok("未命名".into());
    }
    Ok(name.to_string())
}

/// 背景只接受本运行时确定可重开的四种写法（不跟随工具箱颜色）。
fn document_background(params: &Value, id: &str) -> Result<String> {
    let value = match params.get("background") {
        None | Some(Value::Null) => return Ok("white".into()),
        Some(value) => value
            .as_str()
            .ok_or_else(|| bad(id, "`background` 必须是字符串"))?,
    };
    match value {
        "white" | "black" | "transparent" => Ok(value.to_string()),
        other => {
            let hex = other.strip_prefix('#').unwrap_or(other);
            if matches!(hex.len(), 3 | 6) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                Ok(format!("#{hex}"))
            } else {
                Err(bad(id, "`background` 只能是 white、black、transparent 或 #rrggbb"))
            }
        }
    }
}

fn document_size(params: &Value, id: &str) -> Result<(u32, u32)> {
    let read = |key: &str| -> Result<u32> {
        let value = params
            .get(key)
            .ok_or_else(|| bad(id, format!("缺少 `{key}`")))?;
        let number = value
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| bad(id, format!("`{key}` 必须是有限数值")))?;
        if number < 1.0 {
            return Err(bad(id, format!("`{key}` 必须至少为 1 像素")));
        }
        Ok(number.round() as u32)
    };
    let (width, height) = (read("width")?, read("height")?);
    if width > photocraft_project_verify::MAX_CANVAS_SIDE
        || height > photocraft_project_verify::MAX_CANVAS_SIDE
    {
        return Err(bad(
            id,
            format!(
                "尺寸超过单边上限（{} 像素）",
                photocraft_project_verify::MAX_CANVAS_SIDE
            ),
        ));
    }
    if u64::from(width) * u64::from(height) > photocraft_project_verify::MAX_CANVAS_PIXELS {
        return Err(bad(
            id,
            format!(
                "像素总量超过上限（{}）",
                photocraft_project_verify::MAX_CANVAS_PIXELS
            ),
        ));
    }
    Ok((width, height))
}

fn document_resolution(params: &Value, id: &str) -> Result<f64> {
    let value = match params.get("resolution") {
        None | Some(Value::Null) => return Ok(72.0),
        Some(value) => value
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| bad(id, "`resolution` 必须是有限数值"))?,
    };
    if !(1.0..=MAX_RESOLUTION).contains(&value) {
        return Err(bad(
            id,
            format!("`resolution` 必须在 1–{MAX_RESOLUTION} ppi 之间"),
        ));
    }
    Ok(value)
}

/// 只接受本运行时已交付的画布模式：RGB、8 位/通道。
///
/// 其他模式（CMYK/Lab/灰度/高位深）属于本 change 的明确非目标；在此拒绝而不是让界面建立一个
/// 其余工具无法编辑、核验器也无法重开的文档。
fn check_mode_and_depth(params: &Value, id: &str) -> Result<()> {
    if let Some(mode) = params.get("mode") {
        let mode = mode
            .as_str()
            .ok_or_else(|| bad(id, "`mode` 必须是字符串"))?;
        if mode != "rgb" {
            return Err(bad(
                id,
                format!("当前只支持 RGB 模式（收到 {mode}）；CMYK/Lab/灰度不在本次范围"),
            ));
        }
    }
    if let Some(depth) = params.get("depth") {
        let depth = depth
            .as_u64()
            .ok_or_else(|| bad(id, "`depth` 必须是整数"))?;
        if depth != 8 {
            return Err(bad(
                id,
                format!("当前只支持 8 位/通道（收到 {depth}）；16/32 位不在本次范围"),
            ));
        }
    }
    Ok(())
}

fn check_keys(params: &Value, id: &str, allowed: &[&str]) -> Result<()> {
    let Some(object) = params.as_object() else { return Ok(()) };
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(bad(id, format!("未知的参数 `{key}`")));
        }
    }
    Ok(())
}

fn new_document_spec(params: &Value) -> Result<NewDocumentSpec> {
    match params {
        Value::Null | Value::Object(_) => {}
        _ => return Err(bad("file.new", "新建参数必须是对象")),
    }
    check_keys(params, "file.new", NEW_DOCUMENT_KEYS)?;
    check_mode_and_depth(params, "file.new")?;
    let (width, height) = document_size(params, "file.new")?;
    Ok(NewDocumentSpec {
        name: document_name(params, "file.new")?,
        width,
        height,
        resolution: document_resolution(params, "file.new")?,
        background: document_background(params, "file.new")?,
    })
}

fn check_file_info(params: &Value) -> Result<()> {
    let object = match params {
        Value::Null => return Ok(()),
        Value::Object(object) => object,
        _ => return Err(bad("file.fileInfo", "File Info 参数必须是对象")),
    };
    let mut total = 0usize;
    for (key, value) in object {
        if !FILE_INFO_FIELDS.contains(&key.as_str()) {
            return Err(bad("file.fileInfo", format!("未知的 File Info 字段 `{key}`")));
        }
        if key == "keywords" {
            let items = value
                .as_array()
                .ok_or_else(|| bad("file.fileInfo", "`keywords` 必须是字符串数组"))?;
            if items.len() > MAX_FILE_INFO_KEYWORDS {
                return Err(bad(
                    "file.fileInfo",
                    format!("关键字最多 {MAX_FILE_INFO_KEYWORDS} 条"),
                ));
            }
            for item in items {
                let text = item
                    .as_str()
                    .ok_or_else(|| bad("file.fileInfo", "`keywords` 必须是字符串数组"))?;
                if text.chars().count() > MAX_FILE_INFO_KEYWORD_CHARS || text.contains('\0') {
                    return Err(bad(
                        "file.fileInfo",
                        format!("单个关键字不能超过 {MAX_FILE_INFO_KEYWORD_CHARS} 个字符"),
                    ));
                }
                total += text.chars().count();
            }
            continue;
        }
        let text = value
            .as_str()
            .ok_or_else(|| bad("file.fileInfo", format!("`{key}` 必须是字符串")))?;
        if text.chars().count() > MAX_FILE_INFO_FIELD_CHARS || text.contains('\0') {
            return Err(bad(
                "file.fileInfo",
                format!("`{key}` 不能超过 {MAX_FILE_INFO_FIELD_CHARS} 个字符"),
            ));
        }
        if key == "copyrightStatus" && !COPYRIGHT_STATES.contains(&text) {
            return Err(bad(
                "file.fileInfo",
                "`copyrightStatus` 只能是 unknown、copyrighted 或 publicDomain",
            ));
        }
        total += text.chars().count();
    }
    if total > MAX_FILE_INFO_TOTAL_CHARS {
        return Err(bad(
            "file.fileInfo",
            format!("File Info 元数据累计不能超过 {MAX_FILE_INFO_TOTAL_CHARS} 个字符"),
        ));
    }
    Ok(())
}

fn check_preset_name(params: &Value, id: &str) -> Result<()> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| bad(id, "缺少 `name`"))?;
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_DOCUMENT_NAME_CHARS {
        return Err(bad(
            id,
            format!("预设名去空白后必须是 1–{MAX_DOCUMENT_NAME_CHARS} 个字符"),
        ));
    }
    Ok(())
}

/// 保存预设前先用本域的上限校验设置，避免把其他运行时无法重开的尺寸存成本机预设。
fn check_preset_settings(params: &Value, id: &str) -> Result<()> {
    let settings = params
        .get("settings")
        .ok_or_else(|| bad(id, "缺少 `settings`"))?;
    if !settings.is_object() {
        return Err(bad(id, "`settings` 必须是对象"));
    }
    check_keys(settings, id, PRESET_SETTING_KEYS)?;
    check_mode_and_depth(settings, id)?;
    document_size(settings, id)?;
    document_resolution(settings, id)?;
    document_background(settings, id)?;
    Ok(())
}

/// 最近设置与预设设置同形；`document.recent.add` 也走同一套上限。
fn check_recent_settings(settings: &Value) -> Result<()> {
    if !settings.is_object() {
        return Err(bad("document.recent.add", "`settings` 必须是对象"));
    }
    check_keys(settings, "document.recent.add", PRESET_SETTING_KEYS)?;
    check_mode_and_depth(settings, "document.recent.add")?;
    document_size(settings, "document.recent.add")?;
    document_resolution(settings, "document.recent.add")?;
    document_background(settings, "document.recent.add")?;
    Ok(())
}

fn require_no_document(editor: &Editor, id: &str) -> Result<()> {
    if editor.has_document() {
        return Err(bad(
            id,
            "当前编辑会话已有文档：新建需要工作区创建独立文档槽位（宿主端口未提供）",
        ));
    }
    Ok(())
}

impl Editor {
    /// U01：在**候选**实例上新建空白文档并返回实际结果。
    ///
    /// 只允许在没有活动文档的会话上执行：一个编辑会话对应一个文档槽位，槽位注册、最多 8 个
    /// 标签与关闭结算归共享工作区。已有文档时明确拒绝，而不是在同一会话里留下第二个文档。
    pub fn create_document(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        require_no_document(self, "file.new")?;
        let spec = new_document_spec(&params)?;
        self.execute("file.new", spec.kernel_params())?;
        // 最近设置是簿记（journal=false）：失败不影响已创建的文档，也不伪造成功。
        let recorded = self
            .execute("document.recent.add", json!({ "settings": spec.recent_settings() }))
            .is_ok();
        let mut report = spec.report(self.state());
        if let Some(obj) = report.as_object_mut() {
            obj.insert("recentRecorded".into(), json!(recorded));
        }
        Ok(report)
    }

    /// U02：用用户授权读取的图片字节（工作区剪贴板或文件选择）建立文档。
    ///
    /// 与 [`Editor::create_document`] 相同的槽位约束；字节走既有导入校验（尺寸/格式/解码）。
    pub fn create_document_from_image(&mut self, name: &str, bytes: &[u8]) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        require_no_document(self, "file.new")?;
        let name = name.trim();
        if name.chars().count() > MAX_DOCUMENT_NAME_CHARS {
            return Err(bad(
                "file.new",
                format!("文档名不能超过 {MAX_DOCUMENT_NAME_CHARS} 个字符"),
            ));
        }
        let name = if name.is_empty() { "剪贴板图像" } else { name };
        let state = self.open_image(name, None, bytes)?;
        let width = state.pointer("/document/width").and_then(Value::as_u64).unwrap_or(0);
        let height = state.pointer("/document/height").and_then(Value::as_u64).unwrap_or(0);
        Ok(json!({
            "name": name,
            "width": width,
            "height": height,
            "source": "image-bytes",
            "warnings": state.get("warnings").cloned().unwrap_or_else(|| json!([])),
        }))
    }

    /// U02：把当前文档整份复制成**自包含**工程字节（保留规范层树/资源）。
    ///
    /// 副本与原文此后各自独立：字节是快照，宿主把它作为新文档打开后再编辑不会回写原文。
    /// 浏览器交付与标签注册仍归宿主；本方法只产生字节，不推进原文档的保存基线。
    pub fn duplicate_document_bytes(&self, name: Option<&str>) -> Result<Vec<u8>> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let state = self.active_doc()?;
        let mut copy = (*state.doc).clone();
        let requested = name.map(str::trim).filter(|name| !name.is_empty());
        copy.name = match requested {
            Some(name) => name.to_string(),
            None => format!("{} 副本", state.doc.name),
        };
        if copy.name.chars().count() > MAX_DOCUMENT_NAME_CHARS {
            return Err(bad(
                "file.new",
                format!("文档名不能超过 {MAX_DOCUMENT_NAME_CHARS} 个字符"),
            ));
        }
        photocraft_format::save_to_bytes(
            &copy,
            &photocraft_format::SaveOptions {
                thumbnail: Some(photocraft_compose::thumbnail(&copy, 256)),
                composite: Some(photocraft_compose::thumbnail(&copy, 2048)),
            },
        )
        .map_err(|e| EditorError::SaveFailed(e.to_string()))
    }

    /// U03：用工作区持有的上次保存基线字节恢复当前文档（一步可撤销）。
    ///
    /// 浏览器没有原生命令可直接读盘，因此基线由工作区在**可信写入**后保留，或由用户重新选择
    /// 工程文件；本方法核对来源、保留文档身份与标签名，并把保存基线推进到恢复后的修订。
    pub fn restore_saved_baseline(&mut self, bytes: &[u8], base_asset_id: Option<&str>) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        if self.active_doc().is_err() {
            return Err(EditorError::NoDocument);
        }
        if !photocraft_format::is_pcraft(bytes) {
            return Err(EditorError::NotAProject);
        }
        photocraft_project_verify::verify(bytes).map_err(|e| EditorError::LoadFailed(e.message))?;
        let fresh = photocraft_format::load_from_bytes(bytes)
            .map_err(|e| EditorError::LoadFailed(e.to_string()))?;
        let source_width = fresh.size.width;
        let source_height = fresh.size.height;
        self.session
            .edit("Revert", |doc, active| {
                let (id, name) = (doc.id, doc.name.clone());
                *doc = fresh;
                // 身份与标签名保持不变：视图缓存、宿主描述符与内容指纹仍指向同一文档。
                doc.id = id;
                doc.name = name;
                *active = doc.top_layer();
                Ok(())
            })
            .map_err(|e| EditorError::LoadFailed(e.to_string()))?;
        // 恢复的字节是自包含快照：旧资产登记不再适用，按调用方给出的来源重建。
        self.registry.clear();
        self.registry.base_asset_id = base_asset_id.map(str::to_string);
        let revision = {
            let state = self.session.active_mut().ok_or(EditorError::NoDocument)?;
            // 恢复后内容等于基线：保存基线推进到当前修订，净变化清零。
            state.saved_revision = state.revision;
            state.revision
        };
        Ok(json!({
            "restored": true,
            "width": source_width,
            "height": source_height,
            "layers": self.active_doc()?.doc.layers.len(),
            "revision": revision,
            "documentContentHash": self.content_hash()?,
        }))
    }

    /// U04：有界 File Info。无写入字段时只读；有写入字段时一步可撤销。
    ///
    /// **无变化不新增历史**：上游 `file.fileInfo` 只要收到任一已知键就无条件
    /// `session.edit("File Info", …)`，即使写回的值与当前完全相同，也会压入一步空历史
    /// （实测连写两次相同值后历史为 `["Open","File Info","File Info"]`）。因此这里先算出
    /// 本次真正会产生的 XMP，与当前可观察字段比较；完全一致时降级为只读查询。
    ///
    /// 比较用「可观察字段」而不是 XMP 原文字符串，这样「全空表单写到没有 XMP 的文档」也不会
    /// 平白生成一封空信封并把文档标记成已修改。
    pub fn file_info(&mut self, params: Value) -> Result<Value> {
        check_file_info(&params)?;
        let unchanged = match self.active_doc() {
            Ok(state) => {
                let current = state.doc.metadata.xmp.as_deref();
                let next = photocraft_engine::file_cmds::write_file_info(current, &params);
                // 只有真的存在要写入的已知键时才可能「无变化」；纯读取本来就只读。
                params.as_object().is_some_and(|map| {
                    map.keys().any(|key| FILE_INFO_FIELDS.contains(&key.as_str()))
                }) && photocraft_engine::file_cmds::read_file_info(Some(&next))
                    == photocraft_engine::file_cmds::read_file_info(current)
            }
            // 没有活动文档：交给命令门返回稳定的 NoDocument，不在这里伪造。
            Err(_) => false,
        };
        if unchanged {
            return self.execute("file.fileInfo", Value::Null);
        }
        self.execute("file.fileInfo", params)
    }

    /// U04：新建文档预设（`list` / `save` / `delete`）。
    ///
    /// 预设是本机簿记（不进文档内容与历史）；设置先按本域上限校验再交给引擎，
    /// 避免把本运行时无法重开的尺寸存成本机预设。
    pub fn document_presets(&mut self, action: &str, params: Value) -> Result<Value> {
        let id = match action {
            "list" => "document.presets.list",
            "save" => "document.presets.save",
            "delete" => "document.presets.delete",
            other => return Err(bad("document.presets", format!("未知的预设操作 `{other}`"))),
        };
        match action {
            "save" => {
                check_preset_name(&params, id)?;
                check_preset_settings(&params, id)?;
            }
            "delete" => check_preset_name(&params, id)?,
            _ => {}
        }
        self.execute(id, params)
    }

    /// U04：最近的新建设置（最近文件索引由界面侧版本化存储维护，字节引用归宿主）。
    pub fn recent_documents(&mut self) -> Result<Value> {
        self.execute("document.recent.list", Value::Null)
    }

    /// U04：记录一次新建设置（工作区在别的文档槽位创建后调用，使最近列表与真实结果一致）。
    pub fn record_recent_document(&mut self, settings: Value) -> Result<Value> {
        check_recent_settings(&settings)?;
        self.execute("document.recent.add", json!({ "settings": settings }))
    }
}
