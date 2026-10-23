//! 绘画、笔刷动态与颜色：本域命令入口与只读查询
//! （change: 2026-10-22-add-photocraft-painting-color-workflows，U27–U36）。
//!
//! 本文件由共享 `editor/tools.rs` 通过 `#[path]` 装配到同一个 `Editor`，因此**不新增**第二个
//! 内核、文档、历史或草稿。它只做本域自己的事：
//!
//! - 命令归属＋白名单复核（[`owns_command`] / [`Editor::painting_command`]）；
//! - 上游引擎已实现的绘画命令（铅笔、颜色替换、渐变、油漆桶、两种橡皮、对称、色板、渐变预设、
//!   工具预设）通过同一条 [`Editor::execute`] 门执行，参数校验交给上游 `CommandSpec`；
//! - 需要在**本机库**上成立的组管理、选区定义笔尖、工具预设与重置工具；
//! - 只读查询：平均采样吸管（[`Editor::sample_color_options`]）与对称状态
//!   （[`Editor::symmetry_state`]），都不写修订／历史／内容指纹。
//!
//! 边界（design D1/D3）：库、工具预设与采样都是**工具/偏好状态**，不进内容身份；绘图本身仍走
//! 现有 begin → preview → commit/cancel 笔迹门禁，`begin_stroke` 冻结整笔参数，因此本文件不需要
//! 复制第二套草稿。全局预算、能力阶段与跨语言 fixture 由集成负责人统一聚合。

use super::*;

use crate::brush_library::PresetOrigin;
use crate::error::EditorError;

/// 本域独占的命令前缀（含结尾点，避免误吞同前缀的别域命令）。
pub const PAINTING_COMMAND_PREFIXES: &[&str] = &[
    "paint.",
    "swatches.",
    "gradient.presets.",
    "tool.presets.",
    "brush.presets.",
];

/// 本域独占的完整命令 id（无点分前缀）。
pub const PAINTING_COMMAND_IDS: &[&str] =
    &["document.sampleColor", "brush.defineFromSelection", "brush.get", "brush.texturePattern"];

/// 上游没有命令注册表条目、由本域原生实现的命令。
pub const NATIVE_COMMANDS: &[&str] = &["tool.reset", "tool.resetAll"];

/// 命令是否归绘画域所有。
pub fn owns_command(id: &str) -> bool {
    NATIVE_COMMANDS.contains(&id)
        || PAINTING_COMMAND_IDS.contains(&id)
        || PAINTING_COMMAND_PREFIXES.iter().any(|prefix| id.starts_with(prefix))
}

fn paint_error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.to_string(), message: message.to_string() }
}

impl Editor {
    /// 记录一次工具预设变更：推进面板修订，并把偏好文档标脏以便宿主持久化。
    ///
    /// 上游 `Session::presets_changed` 是引擎内部入口（`pub(crate)`），本域只能走公开的
    /// [`Session::edit_prefs`]；两步等价于它（`rev += 1` + `prefs.edit(|_| ())`），不写文档
    /// 内容、不推进修订／历史／内容指纹。
    fn mark_tool_presets_changed(&mut self) {
        self.session.presets.rev += 1;
        self.session.edit_prefs(|_| ());
    }
}

/// 工具预设单条预算：名称与参数一起不超过 64 KiB，整库最多 200 条。
pub const MAX_TOOL_PRESET_OPTIONS_BYTES: usize = 64 * 1024;
/// 工具预设库最多条目数（与上游 1000 条的分档更保守，避免把整库塞进偏好存储）。
pub const MAX_TOOL_PRESETS: usize = 200;
/// 工具预设快照签名（版本化；编码变化必须换签名）。
const TOOL_PRESET_SIGNATURE: &[u8; 8] = b"WHTP0001";
/// 工具预设快照上限。
pub const MAX_TOOL_PRESET_SNAPSHOT_BYTES: usize = 1 << 20;

impl Editor {
    /// 执行本域命令：先确认归属，再走共享白名单门。
    ///
    /// `tool.reset` / `tool.resetAll` 上游只存在于 egui 外壳，本域用内核可测的等价实现补齐；
    /// 其余命令仍由 [`Editor::execute`] 的同一道能力门与草稿门拒绝。
    pub fn painting_command(&mut self, id: &str, params: Value) -> Result<Value> {
        if !owns_command(id) {
            return Err(paint_error(id, format!("{id} 不属于绘画域")));
        }
        match id {
            "tool.reset" => self.reset_paint_tool(&params),
            "tool.resetAll" => self.reset_all_paint_tools(),
            _ => self.execute(id, params),
        }
    }

    // ---------------------------------------------------------------- 独立吸管（U34）

    /// 独立吸管：按采样尺寸与采样层策略读取**源像素**。
    ///
    /// `params`：`{"x":f64,"y":f64,"size":"point"|1|3|5|11|31|51|101=1,
    /// "sampleLayer":"current"|"currentAndBelow"|"all"|"allNoAdjustments"|"currentAndBelowNoAdjustments"="all"}`。
    ///
    /// 返回 `{hex, alpha, rgba}`；图外或透明返回 `null`。只读：不推进修订、历史或内容指纹。
    pub fn sample_color_options(&self, params: Value) -> Result<Value> {
        const CMD: &str = "document.sampleColor";
        let state = self.active_doc()?;
        let coord = |key: &str| -> Result<f64> {
            params
                .get(key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .ok_or_else(|| paint_error(CMD, format!("`{key}` 必须是有限数（文档像素）")))
        };
        let (x, y) = (coord("x")?, coord("y")?);
        let size =
            photocraft_engine::sample_cmds::size_param(CMD, &params).map_err(|e| paint_error(CMD, e))?;
        let which =
            photocraft_engine::sample_cmds::layers_param(CMD, &params).map_err(|e| paint_error(CMD, e))?;
        let rgba =
            photocraft_engine::sample_cmds::sample_color(&state.doc, state.active_layer, x, y, size, which);
        if !(rgba[3] > 0.0) {
            return Ok(Value::Null);
        }
        let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
        Ok(json!({
            "hex": format!("#{:02x}{:02x}{:02x}", channel(rgba[0]), channel(rgba[1]), channel(rgba[2])),
            "alpha": rgba[3].clamp(0.0, 1.0),
            "rgba": [rgba[0], rgba[1], rgba[2], rgba[3]],
        }))
    }

    // ---------------------------------------------------------------- 对称（U33）

    /// 当前文档的绘画对称设置；未启用时 `{"enabled":false}`。只读。
    pub fn symmetry_state(&self) -> Result<Value> {
        let state = self.active_doc()?;
        Ok(match &state.symmetry {
            Some(symmetry) => {
                let mut value = symmetry.inspect();
                if let Some(object) = value.as_object_mut() {
                    object.insert("enabled".into(), json!(true));
                }
                value
            }
            None => json!({ "enabled": false }),
        })
    }

    // ---------------------------------------------------------------- 笔刷分组（U32）

    /// 分组改名：重装库后返回最新分组表，`renamed` 是受影响条目数。
    pub fn rename_brush_group(&mut self, group: &str, new_name: &str) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_brush_gesture()?;
        let renamed = self.brush_library.rename_group(group, new_name)?;
        self.brush_library.install(&mut self.session);
        self.session.brush_presets_changed();
        Ok(json!({ "group": new_name, "renamed": renamed, "groups": self.brush_library.groups_json() }))
    }

    /// 删除分组：默认分组受保护；`keepPresets` 为 true 时把条目移到「general」而不是删除。
    pub fn delete_brush_group(&mut self, group: &str, keep_presets: bool) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_brush_gesture()?;
        let removed = self.brush_library.delete_group(group, keep_presets)?;
        // 当前预设被删掉时清空选择，避免界面指向不存在的条目。
        if let Some(current) = self.session.tools.current_preset.clone()
            && self.brush_library.get(&current).is_err()
        {
            self.session.tools.current_preset = None;
            self.session.tools.brush_changed();
        }
        self.brush_library.install(&mut self.session);
        self.session.brush_presets_changed();
        Ok(json!({ "group": group, "removed": removed, "groups": self.brush_library.groups_json() }))
    }

    /// 分组排序：把 `group` 移到 `index`；未知分组返回错误，索引超界钳制到末尾。
    pub fn move_brush_group(&mut self, group: &str, index: usize) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_brush_gesture()?;
        let position = self.brush_library.move_group(group, index)?;
        self.brush_library.install(&mut self.session);
        self.session.brush_presets_changed();
        Ok(json!({ "group": group, "index": position, "groups": self.brush_library.groups_json() }))
    }

    // ---------------------------------------------------------------- 选区定义笔尖（U32）

    /// 从当前选区定义静态笔尖，并发布到本机库。
    ///
    /// 空白选区、非像素目标或超预算由上游 `brush.defineFromSelection` 拒绝；库里按
    /// `origin: "user"` 记录，随后删库项不影响已经落笔的像素（笔迹在提交时已冻结）。
    pub fn define_brush_from_selection(&mut self, name: &str, group: Option<&str>) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_brush_gesture()?;
        let created = self
            .session
            .execute("brush.defineFromSelection", json!({ "name": name }))
            .map_err(|failure| paint_error("brush.defineFromSelection", failure))?;
        // 上游把预设放进会话表；本域必须把它收进本机库，界面只消费库。
        let brush = self.session.tools.brush.clone();
        let group = group.filter(|value| !value.trim().is_empty()).unwrap_or("selection");
        let saved = self.brush_library.save(
            name,
            Some(group),
            None,
            brush,
            PresetOrigin::User,
            Some("selection".into()),
        )?;
        self.brush_library.install(&mut self.session);
        self.session.tools.current_preset = Some(name.to_string());
        self.session.tools.brush_changed();
        self.session.brush_presets_changed();
        Ok(json!({
            "name": saved["name"],
            "group": saved["group"],
            "width": created["width"],
            "height": created["height"],
        }))
    }

    // ---------------------------------------------------------------- 工具预设（U36）

    /// 工具预设库列表（可选按工具过滤，忽略大小写、空格与 `Tool` 后缀）。
    pub fn tool_presets(&self, tool: Option<&str>) -> Vec<Value> {
        let filter = tool.map(normalize_tool_name);
        self.session
            .presets
            .tool_presets
            .iter()
            .filter(|preset| filter.as_ref().is_none_or(|wanted| normalize_tool_name(&preset.tool) == *wanted))
            .map(|preset| {
                json!({ "name": preset.name, "tool": preset.tool, "options": preset.options,
                    "foreground": preset.options.get("foreground") })
            })
            .collect()
    }

    /// 保存工具预设：`options` 必须是对象且不超预算；同名整条替换。
    pub fn save_tool_preset(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| paint_error("tool.presets.new", "预设名称不能为空"))?
            .to_string();
        if name.chars().count() > 255 {
            return Err(paint_error("tool.presets.new", "预设名称最多 255 个字符"));
        }
        let tool = params
            .get("tool")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| paint_error("tool.presets.new", "缺少工具 id"))?
            .to_string();
        let mut options = params.get("options").cloned().unwrap_or_else(|| json!({}));
        if !options.is_object() {
            return Err(paint_error("tool.presets.new", "`options` 必须是对象"));
        }
        if params.get("includeColor").and_then(Value::as_bool).unwrap_or(false) {
            let foreground = self.session.tools.foreground;
            options["foreground"] = json!(foreground);
        }
        // 笔类工具默认冻结当前笔刷：预设选中后笔迹不受库后续修改影响。
        if options.get("brush").is_none() && is_brush_tool(&tool) {
            options["brush"] = serde_json::to_value(&self.session.tools.brush)
                .map_err(|e| paint_error("tool.presets.new", e))?;
        }
        if serde_json::to_vec(&options).map_or(true, |bytes| bytes.len() > MAX_TOOL_PRESET_OPTIONS_BYTES) {
            return Err(paint_error("tool.presets.new", "工具预设参数超过 64 KiB"));
        }
        let presets = &mut self.session.presets.tool_presets;
        match presets.iter_mut().find(|preset| preset.name == name) {
            Some(existing) => {
                existing.tool = tool.clone();
                existing.options = options;
            }
            None => {
                if presets.len() >= MAX_TOOL_PRESETS {
                    return Err(paint_error(
                        "tool.presets.new",
                        format!("工具预设最多 {MAX_TOOL_PRESETS} 条，请先删除"),
                    ));
                }
                presets.push(photocraft_engine::presets::tools::ToolPreset { name: name.clone(), tool: tool.clone(), options });
            }
        }
        self.mark_tool_presets_changed();
        Ok(json!({ "name": name, "tool": tool }))
    }

    /// 应用工具预设：套用 `brush` 与前景色，返回工具 id 让界面切换当前工具。
    ///
    /// 未开放的工具类型整条拒绝，而不是只应用一半参数。
    pub fn select_tool_preset(&mut self, name: &str) -> Result<Value> {
        let preset = self
            .session
            .presets
            .tool_presets
            .iter()
            .find(|preset| preset.name == name)
            .cloned()
            .ok_or_else(|| paint_error("tool.presets.select", format!("没有名为 `{name}` 的工具预设")))?;
        if !is_supported_tool(&preset.tool) {
            return Err(paint_error(
                "tool.presets.select",
                format!("工具预设「{name}」包含本版本未开放的工具 `{}`", preset.tool),
            ));
        }
        if let Some(brush) = preset.options.get("brush").filter(|value| value.is_object()) {
            self.execute("tools.setBrush", json!({ "brush": brush }))
                .map_err(|failure| paint_error("tool.presets.select", failure))?;
        }
        if let Some(foreground) = preset.options.get("foreground").and_then(Value::as_array)
            && foreground.len() >= 3
        {
            let channel = |index: usize| foreground[index].as_f64().unwrap_or(0.0).clamp(0.0, 1.0) as f32;
            self.session.tools.foreground = [channel(0), channel(1), channel(2), 1.0];
        }
        Ok(json!({ "name": preset.name, "tool": preset.tool, "options": preset.options }))
    }

    /// 编辑工具预设：`action` 为 `rename` 或 `delete`。
    pub fn edit_tool_preset(&mut self, params: Value) -> Result<Value> {
        let action = params.get("action").and_then(Value::as_str).unwrap_or("rename");
        let name = params
            .get("preset")
            .and_then(Value::as_str)
            .ok_or_else(|| paint_error("tool.presets.edit", "缺少 preset"))?;
        match action {
            "delete" => {
                let before = self.session.presets.tool_presets.len();
                self.session.presets.tool_presets.retain(|preset| preset.name != name);
                if self.session.presets.tool_presets.len() == before {
                    return Err(paint_error("tool.presets.edit", format!("没有名为 `{name}` 的工具预设")));
                }
                self.mark_tool_presets_changed();
                Ok(json!({ "deleted": name, "count": self.session.presets.tool_presets.len() }))
            }
            "rename" => {
                let new_name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| paint_error("tool.presets.edit", "缺少新名称"))?
                    .to_string();
                if self
                    .session
                    .presets
                    .tool_presets
                    .iter()
                    .any(|preset| preset.name == new_name && preset.name != name)
                {
                    return Err(paint_error("tool.presets.edit", "新名称已被占用"));
                }
                let preset = self
                    .session
                    .presets
                    .tool_presets
                    .iter_mut()
                    .find(|preset| preset.name == name)
                    .ok_or_else(|| paint_error("tool.presets.edit", format!("没有名为 `{name}` 的工具预设")))?;
                preset.name = new_name.clone();
                self.mark_tool_presets_changed();
                Ok(json!({ "name": new_name, "previous": name }))
            }
            other => Err(paint_error("tool.presets.edit", format!("未知动作 `{other}`（rename|delete）"))),
        }
    }

    /// 恢复默认工具预设库（不删除用户工具预设以外的任何东西）。
    pub fn reset_tool_presets(&mut self) -> Value {
        self.session.presets.tool_presets = photocraft_engine::presets::tools::builtin();
        self.mark_tool_presets_changed();
        json!({ "presets": self.session.presets.tool_presets.len() })
    }

    /// 工具预设快照：签名 + 有界 JSON，供宿主偏好存储。
    pub fn tool_preset_snapshot(&self) -> Result<Vec<u8>> {
        let metadata = serde_json::to_vec(&self.session.presets.tool_presets)
            .map_err(|e| paint_error("tool.presets.list", e))?;
        if metadata.len() > MAX_TOOL_PRESET_SNAPSHOT_BYTES {
            return Err(paint_error("tool.presets.list", "工具预设快照超限"));
        }
        let mut bytes = Vec::with_capacity(8 + metadata.len());
        bytes.extend_from_slice(TOOL_PRESET_SIGNATURE);
        bytes.extend_from_slice(&metadata);
        Ok(bytes)
    }

    /// 恢复工具预设快照；坏字节不覆盖当前库。
    pub fn restore_tool_presets(&mut self, bytes: &[u8]) -> Result<Value> {
        self.require_no_stroke()?;
        if bytes.len() > MAX_TOOL_PRESET_SNAPSHOT_BYTES {
            return Err(paint_error("tool.presets.list", "工具预设快照超限"));
        }
        let Some(metadata) = bytes.strip_prefix(TOOL_PRESET_SIGNATURE) else {
            return Err(paint_error("tool.presets.list", "不是工具预设快照"));
        };
        let presets: Vec<photocraft_engine::presets::tools::ToolPreset> =
            serde_json::from_slice(metadata).map_err(|e| paint_error("tool.presets.list", e))?;
        if presets.len() > MAX_TOOL_PRESETS {
            return Err(paint_error("tool.presets.list", "工具预设快照条目超限"));
        }
        if presets.iter().any(|preset| preset.name.trim().is_empty())
            || presets
                .iter()
                .any(|preset| serde_json::to_vec(&preset.options).map_or(true, |bytes| bytes.len() > MAX_TOOL_PRESET_OPTIONS_BYTES))
        {
            return Err(paint_error("tool.presets.list", "工具预设快照含非法条目"));
        }
        self.session.presets.tool_presets = presets;
        self.mark_tool_presets_changed();
        Ok(json!({ "count": self.session.presets.tool_presets.len() }))
    }

    // ---------------------------------------------------------------- 重置工具（U36）

    /// 重置当前绘画工具的参数：只改笔刷与预设选择，**不**删除文档、图层或工作区布局。
    fn reset_paint_tool(&mut self, params: &Value) -> Result<Value> {
        self.require_no_stroke()?;
        let tool = params
            .get("tool")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("brush")
            .to_string();
        if !is_supported_tool(&tool) {
            return Err(paint_error("tool.reset", format!("未知绘画工具 `{tool}`")));
        }
        // 笔刷回到默认值；颜色、文档与库保持不变（与上游 Reset Tool 的可观测范围一致）。
        self.execute("tools.setBrush", json!({ "reset": true }))
            .map_err(|failure| paint_error("tool.reset", failure))?;
        Ok(json!({ "reset": tool, "scope": ["brush", "toolOptions"] }))
    }

    /// 重置全部绘画工具参数：笔刷与本域工具参数回到默认，文档与库不删除。
    fn reset_all_paint_tools(&mut self) -> Result<Value> {
        self.require_no_stroke()?;
        self.execute("tools.setBrush", json!({ "reset": true }))
            .map_err(|failure| paint_error("tool.resetAll", failure))?;
        self.session.tools.current_preset = None;
        self.session.tools.brush_changed();
        Ok(json!({ "reset": "all", "scope": ["brush", "toolOptions", "presetSelection"] }))
    }
}

/// 工具预设 id 的归一：忽略大小写、空格、下划线与 `tool` 后缀。
fn normalize_tool_name(tool: &str) -> String {
    tool.to_ascii_lowercase()
        .replace([' ', '_', '-'], "")
        .trim_end_matches("tool")
        .to_string()
}

/// 使用笔刷的绘画工具（保存预设时冻结当前笔刷）。
fn is_brush_tool(tool: &str) -> bool {
    matches!(
        normalize_tool_name(tool).as_str(),
        "brush"
            | "pencil"
            | "eraser"
            | "backgrounderaser"
            | "colorreplacement"
            | "clone"
            | "clonestamp"
            | "heal"
            | "healing"
            | "retouch"
    )
}

/// 本版本已开放、可由工具预设选择的工具。
fn is_supported_tool(tool: &str) -> bool {
    matches!(
        normalize_tool_name(tool).as_str(),
        "brush"
            | "pencil"
            | "eraser"
            | "backgrounderaser"
            | "magiceraser"
            | "colorreplacement"
            | "gradient"
            | "bucket"
            | "eyedropper"
            | "clone"
            | "clonestamp"
            | "heal"
            | "healing"
            | "retouch"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor() -> Editor {
        let mut editor = Editor::new();
        editor
            .execute("file.new", json!({ "width": 24, "height": 18, "background": "white" }))
            .unwrap();
        editor
    }

    #[test]
    fn only_this_domain_commands_pass_the_wrapper() {
        let mut editor = editor();
        for id in [
            "paint.bucket",
            "paint.gradient",
            "paint.magicEraser",
            "paint.backgroundEraser",
            "paint.setSymmetry",
            "swatches.list",
            "gradient.presets.list",
            "tool.presets.list",
            "document.sampleColor",
            "brush.presets.list",
            "tool.reset",
            "tool.resetAll",
        ] {
            assert!(owns_command(id), "{id} 应属于绘画域");
            let _ = editor.painting_command(id, json!({}));
        }
        for id in ["layer.delete", "select.all", "filter.blur.gaussianBlur"] {
            assert!(!owns_command(id), "{id} 不属于绘画域");
            assert!(editor.painting_command(id, json!({})).is_err());
        }
    }

    #[test]
    fn averaged_sampling_reads_source_pixels_and_is_read_only() {
        let mut editor = editor();
        let before = editor.content_hash().unwrap();
        let revision = editor.revision().unwrap();
        let point = editor.sample_color_options(json!({ "x": 4, "y": 4 })).unwrap();
        assert_eq!(point["hex"], json!("#ffffff"));
        assert_eq!(point["alpha"], json!(1.0));
        for size in [json!(3), json!(5), json!("point")] {
            let averaged = editor
                .sample_color_options(json!({ "x": 4, "y": 4, "size": size, "sampleLayer": "all" }))
                .unwrap();
            assert_eq!(averaged["hex"], json!("#ffffff"), "平均采样仍取源像素");
        }
        assert_eq!(editor.content_hash().unwrap(), before);
        assert_eq!(editor.revision().unwrap(), revision);
    }

    #[test]
    fn sampling_outside_the_canvas_or_over_transparency_is_empty() {
        let mut editor = editor();
        assert!(editor.sample_color_options(json!({ "x": -1, "y": 3 })).unwrap().is_null());
        assert!(editor.sample_color_options(json!({ "x": 1_000, "y": 3 })).unwrap().is_null());
        editor.execute("layer.new.layer", json!({})).unwrap();
        assert!(editor
            .sample_color_options(json!({ "x": 2, "y": 2, "sampleLayer": "current" }))
            .unwrap()
            .is_null());
        assert!(editor.sample_color_options(json!({ "x": "2", "y": 2 })).is_err());
        assert!(editor.sample_color_options(json!({ "x": 2, "y": 2, "size": 4 })).is_err());
        assert!(editor.sample_color_options(json!({ "x": 2, "y": 2, "sampleLayer": "nope" })).is_err());
    }

    #[test]
    fn symmetry_state_reports_preset_then_disable() {
        let mut editor = editor();
        assert_eq!(editor.symmetry_state().unwrap(), json!({ "enabled": false }));
        editor
            .execute("paint.setSymmetry", json!({ "mode": "vertical", "center": [12, 9], "rotation": 0 }))
            .unwrap();
        let state = editor.symmetry_state().unwrap();
        assert_eq!(state["enabled"], json!(true));
        assert_eq!(state["mode"], json!("vertical"));
        editor.execute("paint.symmetryDisable", json!({})).unwrap();
        assert_eq!(editor.symmetry_state().unwrap(), json!({ "enabled": false }));
    }

    #[test]
    fn symmetry_requires_a_valid_mode_and_centre() {
        let mut editor = editor();
        assert!(editor.execute("paint.setSymmetry", json!({ "mode": "spiral" })).is_err());
        assert!(editor.execute("paint.setSymmetry", json!({ "mode": "vertical", "center": [1] })).is_err());
        assert_eq!(editor.symmetry_state().unwrap(), json!({ "enabled": false }));
    }

    #[test]
    fn brush_groups_rename_move_and_delete_keep_the_library_consistent() {
        let mut editor = editor();
        editor
            .save_brush_preset(json!({ "name": "组内笔", "group": "旧组", "brush": { "size": 20 } }))
            .unwrap();
        let renamed = editor.rename_brush_group("旧组", "新组").unwrap();
        assert_eq!(renamed["group"], "新组");
        assert_eq!(editor.brush_preset("组内笔").unwrap()["group"], "新组");
        assert!(editor.rename_brush_group("不存在", "任意").is_err());

        let moved = editor.move_brush_group("新组", 0).unwrap();
        assert_eq!(moved["index"], 0);
        assert!(editor.move_brush_group("不存在", 0).is_err());

        // 删除组但保留条目：条目回到默认分组 general。
        let kept = editor.delete_brush_group("新组", true).unwrap();
        assert_eq!(kept["removed"], 1);
        assert_eq!(editor.brush_preset("组内笔").unwrap()["group"], "general");
        assert!(editor.delete_brush_group("general", false).is_err(), "默认分组受保护");

        // 删除组并删条目：当前预设被清空，不留下悬挂选择。
        editor
            .save_brush_preset(json!({ "name": "临时组笔", "group": "临时组", "brush": { "size": 18 } }))
            .unwrap();
        editor.select_brush_preset("临时组笔").unwrap();
        let removed = editor.delete_brush_group("临时组", false).unwrap();
        assert_eq!(removed["removed"], 1);
        assert!(editor.brush_preset("临时组笔").is_err());
    }

    #[test]
    fn define_from_selection_publishes_a_library_preset_and_rejects_empty_selection() {
        let mut editor = editor();
        assert!(editor.define_brush_from_selection("选区笔尖", None).is_err(), "没有选区时拒绝");
        editor
            .execute("select.rect", json!({ "x": 2, "y": 2, "width": 8, "height": 6 }))
            .unwrap();
        // 白底没有「作画量」：选区里必须有深色像素才能定义静态笔尖。
        assert!(editor.define_brush_from_selection("空白笔尖", None).is_err(), "空白选区拒绝");
        editor
            .execute("paint.stroke", json!({ "points": [[4, 4], [7, 6]], "size": 4, "color": "#000000" }))
            .unwrap();
        let created = editor.define_brush_from_selection("选区笔尖", Some("我的笔尖")).unwrap();
        assert_eq!(created["name"], "选区笔尖");
        assert_eq!(created["group"], "我的笔尖");
        assert!(created["width"].as_u64().unwrap() > 0 && created["height"].as_u64().unwrap() > 0);
        assert_eq!(editor.brush_preset("选区笔尖").unwrap()["group"], "我的笔尖");
        // 删库项不影响已经提交的像素（这里只验证删除本身不留悬挂选择）。
        editor.delete_brush_preset("选区笔尖").unwrap();
        assert!(editor.brush_preset("选区笔尖").is_err());
    }

    #[test]
    fn tool_presets_save_select_edit_and_reset_without_touching_the_document() {
        let mut editor = editor();
        let hash = editor.content_hash().unwrap();
        let revision = editor.revision().unwrap();
        editor
            .save_brush_preset(json!({ "name": "预设笔", "brush": { "size": 33, "hardness": 0.9 } }))
            .unwrap();
        let saved = editor
            .save_tool_preset(json!({ "name": "我的画笔", "tool": "brush", "includeColor": true }))
            .unwrap();
        assert_eq!(saved["name"], "我的画笔");
        let listed = editor.tool_presets(Some("Brush"));
        assert!(listed.iter().any(|preset| preset["name"] == "我的画笔"));
        assert!(editor.tool_presets(Some("gradient")).iter().all(|preset| preset["tool"] != "brush"));

        // 应用预设回到保存时的笔刷尺寸。
        editor.execute("tools.setBrush", json!({ "brush": { "size": 5 } })).unwrap();
        let applied = editor.select_tool_preset("我的画笔").unwrap();
        assert_eq!(applied["tool"], "brush");
        let brush = editor.execute("brush.get", json!({})).unwrap();
        assert_eq!(brush["size"], json!(33.0));

        editor
            .edit_tool_preset(json!({ "action": "rename", "preset": "我的画笔", "name": "改名画笔" }))
            .unwrap();
        assert!(editor.tool_presets(None).iter().any(|preset| preset["name"] == "改名画笔"));
        editor
            .edit_tool_preset(json!({ "action": "delete", "preset": "改名画笔" }))
            .unwrap();
        assert!(!editor.tool_presets(None).iter().any(|preset| preset["name"] == "改名画笔"));
        editor.reset_tool_presets();
        assert!(editor.tool_presets(None).len() >= 1);
        assert_eq!(editor.content_hash().unwrap(), hash);
        assert_eq!(editor.revision().unwrap(), revision);
    }

    #[test]
    fn tool_presets_reject_unknown_tools_and_bad_parameters() {
        let mut editor = editor();
        assert!(editor.save_tool_preset(json!({ "name": "", "tool": "brush" })).is_err());
        assert!(editor.save_tool_preset(json!({ "name": "x", "tool": "brush", "options": 3 })).is_err());
        editor
            .save_tool_preset(json!({ "name": "未开放", "tool": "liquify" }))
            .unwrap();
        assert!(editor.select_tool_preset("未开放").is_err(), "未开放工具整条拒绝");
        assert!(editor.select_tool_preset("不存在").is_err());
        assert!(editor.painting_command("tool.reset", json!({ "tool": "liquify" })).is_err());
    }

    #[test]
    fn tool_preset_snapshot_roundtrips_and_rejects_corruption() {
        let mut editor = editor();
        editor
            .save_tool_preset(json!({ "name": "快照预设", "tool": "pencil", "options": { "autoErase": true } }))
            .unwrap();
        let bytes = editor.tool_preset_snapshot().unwrap();
        editor.reset_tool_presets();
        assert!(!editor.tool_presets(None).iter().any(|preset| preset["name"] == "快照预设"));
        editor.restore_tool_presets(&bytes).unwrap();
        assert!(editor.tool_presets(None).iter().any(|preset| preset["name"] == "快照预设"));
        let before = editor.tool_presets(None);
        for prefix in [0usize, 7, 20] {
            assert!(editor.restore_tool_presets(&bytes[..prefix.min(bytes.len())]).is_err());
            assert_eq!(editor.tool_presets(None), before);
        }
    }

    #[test]
    fn reset_tools_changes_only_declared_preferences() {
        let mut editor = editor();
        editor
            .execute("tools.setBrush", json!({ "brush": { "size": 40, "hardness": 0.2 } }))
            .unwrap();
        let hash = editor.content_hash().unwrap();
        let revision = editor.revision().unwrap();
        let layer_count = editor.active_doc().unwrap().doc.layers.len();
        let reset = editor.painting_command("tool.reset", json!({ "tool": "brush" })).unwrap();
        assert_eq!(reset["scope"], json!(["brush", "toolOptions"]));
        let brush = editor.execute("brush.get", json!({})).unwrap();
        assert_eq!(brush["size"], json!(photocraft_paint::BrushSettings::default().size as f64));
        let all = editor.painting_command("tool.resetAll", json!({})).unwrap();
        assert_eq!(all["reset"], json!("all"));
        assert_eq!(editor.content_hash().unwrap(), hash, "重置偏好不产生文档内容修改");
        assert_eq!(editor.revision().unwrap(), revision);
        assert_eq!(editor.active_doc().unwrap().doc.layers.len(), layer_count);
        // 笔迹未结算时拒绝重置。
        editor.begin_stroke(json!({ "points": [[2, 2]], "size": 4 })).unwrap();
        assert!(editor.painting_command("tool.resetAll", json!({})).is_err());
        editor.cancel_stroke();
    }

    #[test]
    fn engine_backed_commands_are_reachable_through_the_domain_entry() {
        let mut editor = editor();
        let before = editor.content_hash().unwrap();
        // 渐变与油漆桶：真实像素命令，一步历史。
        editor
            .painting_command(
                "paint.gradient",
                json!({ "from": [1, 1], "to": [20, 1], "stops": [[0, "#ff0000"], [1, "#0000ff"]] }),
            )
            .unwrap();
        assert_ne!(editor.content_hash().unwrap(), before);
        editor.execute("edit.undo", json!({})).unwrap();
        assert_eq!(editor.content_hash().unwrap(), before);
        editor
            .painting_command("paint.bucket", json!({ "x": 2, "y": 2, "color": "#00ff00", "tolerance": 32 }))
            .unwrap();
        editor.execute("edit.undo", json!({})).unwrap();

        // 铅笔硬边与颜色替换可执行且各自一步撤销。
        for (id, params) in [
            ("paint.pencil", json!({ "points": [[2, 2], [12, 2]], "size": 3, "color": "#000000" })),
            (
                "paint.colorReplacement",
                json!({ "points": [[2, 2], [12, 2]], "size": 4, "color": "#ff0000",
                    "mode": "color", "sampling": "once", "limits": "contiguous", "tolerance": 30 }),
            ),
            (
                "paint.backgroundEraser",
                json!({ "points": [[2, 2], [12, 2]], "size": 6, "tolerance": 40,
                    "sampling": "continuous", "limits": "contiguous" }),
            ),
            ("paint.magicEraser", json!({ "x": 4, "y": 4, "tolerance": 20, "contiguous": true })),
        ] {
            editor.painting_command(id, params).unwrap();
            editor.execute("edit.undo", json!({})).unwrap();
            assert_eq!(editor.content_hash().unwrap(), before, "{id} 一步撤销应回到原内容");
        }

        // 对称与色板/渐变预设清单可用。
        editor
            .painting_command("paint.setSymmetry", json!({ "mode": "horizontal", "center": [12, 9] }))
            .unwrap();
        assert_eq!(editor.symmetry_state().unwrap()["mode"], json!("horizontal"));
        editor.painting_command("paint.symmetryDisable", json!({})).unwrap();
        assert!(editor.painting_command("swatches.list", json!({})).unwrap()["groups"].is_array());
        assert!(editor.painting_command("gradient.presets.list", json!({})).unwrap()["groups"].is_array());
        assert_eq!(editor.content_hash().unwrap(), before);
    }

    #[test]
    fn unsupported_paint_commands_stay_closed() {
        let mut editor = editor();
        for id in ["paint.mixerBrush", "brush.dual", "paint.wetEdges"] {
            assert!(!crate::capability::command_allowed(id), "{id} 必须保持关闭");
            assert!(editor.painting_command(id, json!({})).is_err());
        }
    }
}
