//! 笔刷库的会话入口：库管理、ABR 导入与真实笔迹预览。
//!
//! 库是工具状态（不进文档修订／内容指纹／撤销栈）；所有写入口都必须先过草稿门禁，
//! 因为库操作可能在预览渲染期间重新分配大位图。
use super::*;
use crate::brush_library::PresetOrigin;

impl Editor {
    /// 库初始化：把默认预设同步到会话（打开图片/工程前也要可用，供工具栏预选）。
    pub(super) fn sync_brush_library(&mut self) {
        self.brush_library.install(&mut self.session);
    }

    /// 预设列表（`full` 时含来源与资源摘要）。
    pub fn brush_presets(&self, full: bool) -> Value {
        self.brush_library.list(full)
    }

    /// 单条预设的完整设置（含采样位图），供「笔刷设置」面板读取。
    pub fn brush_preset(&self, name: &str) -> Result<Value> {
        self.brush_library.get(name)
    }

    /// 保存／覆盖预设（默认来源 `user`）。
    pub fn save_brush_preset(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_brush_gesture()?;
        let name = string_param(&params, "name")?;
        let group = params.get("group").and_then(Value::as_str).filter(|value| !value.is_empty());
        let folder = parse_folder(&params)?;
        let brush = match params.get("brush") {
            Some(patch) if patch.is_object() => photocraft_engine::brush_cmds::merge_brush(
                &self.session.tools.brush,
                patch,
                "brush.presets.save",
            )
            .map_err(Self::brush_error)?,
            Some(_) => return Err(Self::brush_error("brush 必须是对象")),
            None => self.session.tools.brush.clone(),
        };
        let saved = self
            .brush_library
            .save(&name, group, folder, brush.clone(), PresetOrigin::User, None)?;
        self.brush_library.install(&mut self.session);
        let name = saved["name"].as_str().unwrap_or(&name).to_string();
        // 保存后当前笔刷就是刚保存的设置（与上游 `brush.presets.save` 一致）。
        self.session.tools.brush = brush;
        self.session.tools.current_preset = Some(name.clone());
        self.session.tools.brush_changed();
        Ok(json!({ "name": name, "group": saved["group"] }))
    }

    /// 改名。
    pub fn rename_brush_preset(&mut self, name: &str, new_name: &str) -> Result<Value> {
        self.require_no_stroke()?;
        let renamed = self.brush_library.rename(name, new_name)?;
        self.brush_library.install(&mut self.session);
        if self
            .session
            .tools
            .current_preset
            .as_ref()
            .is_some_and(|current| current.eq_ignore_ascii_case(name))
        {
            self.session.tools.current_preset = Some(new_name.to_string());
            self.session.tools.brush_changed();
        }
        Ok(renamed)
    }

    /// 删除。
    pub fn delete_brush_preset(&mut self, name: &str) -> Result<Value> {
        self.require_no_stroke()?;
        let removed = self.brush_library.delete(name)?;
        self.brush_library.install(&mut self.session);
        if self
            .session
            .tools
            .current_preset
            .as_ref()
            .is_some_and(|current| current.eq_ignore_ascii_case(name))
        {
            self.session.tools.current_preset = None;
            self.session.tools.brush_changed();
        }
        Ok(removed)
    }

    /// 移动到分组／子文件夹。
    pub fn move_brush_preset(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let name = string_param(&params, "name")?;
        let group = params.get("group").and_then(Value::as_str);
        let folder = parse_folder(&params)?;
        let moved = self.brush_library.move_to(&name, group, folder)?;
        self.brush_library.install(&mut self.session);
        Ok(moved)
    }

    /// 选中预设（只改当前笔刷，不改库内容）。
    pub fn select_brush_preset(&mut self, name: &str) -> Result<Value> {
        self.require_no_stroke()?;
        let preset = self.brush_library.get(name)?;
        let brush: photocraft_paint::BrushSettings = serde_json::from_value(preset["brush"].clone())
            .map_err(|error| Self::brush_error(error))?;
        let picked = brush.picked_over(&self.session.tools.brush);
        self.session.tools.brush = picked;
        self.session.tools.current_preset = Some(name.to_string());
        self.session.tools.brush_changed();
        Ok(json!({ "name": name, "brush": self.session.tools.brush }))
    }

    /// 真实内核笔迹预览：返回 RGBA8 预览像素。
    pub fn brush_preview(&self, params: Value) -> Result<Preview> {
        let side = params
            .get("side")
            .and_then(Value::as_u64)
            .map_or(crate::brush_library::PREVIEW_SIDE, |value| value as u32);
        let (width, height, pixels) = match params.get("name").and_then(Value::as_str) {
            Some(name) => self.brush_library.stroke_preview(name, side)?,
            None => {
                let brush = match params.get("brush") {
                    Some(patch) if patch.is_object() => photocraft_engine::brush_cmds::merge_brush(
                        &self.session.tools.brush,
                        patch,
                        "brush.preview",
                    )
                    .map_err(Self::brush_error)?,
                    Some(_) => return Err(Self::brush_error("brush 必须是对象")),
                    None => self.session.tools.brush.clone(),
                };
                self.brush_library.preview_brush(&brush, side)?
            }
        };
        Ok(Preview { width, height, pixels })
    }

    /// 本机库快照字节。
    pub fn brush_library_snapshot(&self) -> Result<Vec<u8>> {
        self.brush_library.snapshot()
    }

    /// 恢复本机库；失败保留内存库与当前笔刷。
    pub fn restore_brush_library(&mut self, bytes: &[u8]) -> Result<Value> {
        self.require_no_stroke()?;
        let restored = self.brush_library.restore(bytes)?;
        self.brush_library.install(&mut self.session);
        Ok(restored)
    }

    /// ABR 导入预检：解析并给出报告，**不发布**。
    pub fn inspect_brush_abr(&mut self, bytes: &[u8], group: &str) -> Result<Value> {
        let pending = crate::brush_library::inspect_abr(bytes, group)?;
        let report = pending.report();
        // 预检结果暂存在编辑器里，用户在报告后确认才发布。
        self.pending_abr = Some(pending);
        Ok(report)
    }

    /// 确认发布上一次 ABR 预检；`onlySupported` 为 false 且存在不支持项时整批拒绝。
    pub fn commit_brush_abr(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let only_supported = params
            .get("onlySupported")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let pending = self
            .pending_abr
            .take()
            .ok_or_else(|| Self::brush_error("没有待确认的 ABR 导入"))?;
        let group = pending.group().to_string();
        let value = crate::brush_library::commit_abr(
            &mut self.brush_library,
            &mut self.session,
            pending,
            &group,
            only_supported,
        )?;
        Ok(value)
    }

    /// 取消待确认的 ABR 导入。
    pub fn cancel_brush_abr(&mut self) -> Value {
        self.pending_abr = None;
        json!({ "cancelled": true })
    }

    /// 从图片定义采样笔尖（P1b）：字节由调用方经公共端口取得并已核验。
    pub fn import_brush_from_image(&mut self, name: &str, bytes: &[u8], params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        if bytes.len() > photocraft_project_verify::limits::MAX_ABR_FILE_BYTES {
            return Err(Self::brush_error("笔尖图片不能超过 32 MiB"));
        }
        let group = params.get("group").and_then(Value::as_str).unwrap_or("sampled");
        // 复用上游「图片 → 采样笔尖」的像素语义（暗像素作画），但只发布到本库。
        let tip = crate::brush_library::image_tip(name, bytes)?;
        let base = match params.get("brush") {
            Some(patch) if patch.is_object() => photocraft_engine::brush_cmds::merge_brush(
                &self.session.tools.brush,
                patch,
                "brush.presets.importImage",
            )
            .map_err(Self::brush_error)?,
            Some(_) => return Err(Self::brush_error("brush 必须是对象")),
            None => self.session.tools.brush.clone(),
        };
        let value = self.brush_library.import_tip(&mut self.session, name, group, tip, base)?;
        self.brush_library.install(&mut self.session);
        Ok(value)
    }

    pub(super) fn brush_error(message: impl std::fmt::Display) -> EditorError {
        EditorError::CommandFailed { id: "brush.library".into(), message: message.to_string() }
    }
}

fn string_param(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| Editor::brush_error(format!("{key} 必须是非空字符串")))
}

fn parse_folder(params: &Value) -> Result<Option<Vec<String>>> {
    match params.get("folder") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(items)) => {
            let mut folder = Vec::with_capacity(items.len());
            for item in items {
                folder.push(
                    item.as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| Editor::brush_error("folder 必须是非空字符串数组"))?
                        .to_string(),
                );
            }
            if folder.len() > 32 {
                return Err(Editor::brush_error("子文件夹最多 32 层"));
            }
            Ok(Some(folder))
        }
        Some(_) => Err(Editor::brush_error("folder 必须是字符串数组")),
    }
}
