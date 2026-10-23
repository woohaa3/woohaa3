//! P2：跨文档图层载荷、工作区剪贴板与图片置入
//! （change: 2026-10-22-complete-photocraft-webui-editing，P2 / design D5）。
//!
//! 工作区剪贴板是**工作区级**对象，不是内核全局可变状态：`Editor` 只把它当作显式传入的字节。
//! 这样同一份 WASM 模块里的多个文档实例不会串剪贴板，宿主也能按工作区释放。
use super::*;
use crate::transfer::PastePlacement;

impl Editor {
    /// 导出选中图层（或其根）为跨文档载荷字节。
    pub fn export_layer_transfer(&self, params: Value) -> Result<Vec<u8>> {
        self.require_no_stroke()?;
        let ids = layer_ids(&params)?;
        crate::transfer::export(&self.session, &ids)
    }

    /// 载荷摘要与结构（不解码像素）：供目标候选文档预检与 UI 提示。
    pub fn inspect_layer_transfer(&self, bytes: &[u8]) -> Result<Value> {
        let bundle = crate::transfer::decode(bytes)?;
        Ok(json!({
            "digest": bundle.content_digest(),
            "layers": bundle.layer_count(),
            "sourceWidth": bundle.source_size().0,
            "sourceHeight": bundle.source_size().1,
            "anchor": bundle.anchor(),
        }))
    }

    /// 目标候选文档预检：只回答「能不能粘贴」，不修改任何状态。
    pub fn can_paste_layer_transfer(&self, bytes: &[u8]) -> Result<Value> {
        let transfer_started = std::time::Instant::now();
        let bundle = crate::transfer::decode(bytes)?;
        let state = self.active_doc()?;
        let existing = crate::layer_preview::layer_count(&state.doc.layers);
        let added = bundle.layer_count();
        let reason = if existing.saturating_add(added) > photocraft_project_verify::limits::MAX_LAYERS {
            Some(format!("粘贴后图层数超过工程上限（64 层）：{existing} + {added}"))
        } else {
            None
        };
        Ok(json!({
            "ok": reason.is_none(),
            "reason": reason,
            "digest": bundle.content_digest(),
            "layers": added,
            "budgetMs": transfer_started.elapsed().as_millis(),
        }))
    }

    /// 粘贴载荷：一步原子提交（`inPlace` 保持源坐标，否则居中）。
    pub fn paste_layer_transfer(&mut self, bytes: &[u8], params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        let placement = match params.get("placement").and_then(Value::as_str) {
            Some("inPlace") | None => PastePlacement::InPlace,
            Some("center") => PastePlacement::Center,
            Some(other) => {
                return Err(EditorError::CommandFailed {
                    id: "edit.paste".into(),
                    message: format!("未知粘贴位置：{other}"),
                })
            }
        };
        let center = match params.get("center") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let pair = value
                    .as_array()
                    .filter(|pair| pair.len() == 2)
                    .ok_or_else(|| EditorError::CommandFailed {
                        id: "edit.paste".into(),
                        message: "center 必须是 [x, y]".into(),
                    })?;
                let x = pair[0].as_f64().filter(|v| v.is_finite());
                let y = pair[1].as_f64().filter(|v| v.is_finite());
                Some([x.ok_or_else(|| bad_center())?, y.ok_or_else(|| bad_center())?])
            }
        };
        crate::transfer::paste(&mut self.session, bytes, placement, center)
    }

    /// 图片置入：像素层或嵌入智能对象（P4 开放后）。
    ///
    /// 与 `place_image` 的区别是这是**用户入口**：它先预检真实解码类型与尺寸，再按 `mode`
    /// 选择像素层或嵌入对象；失败不新增图层。旧标注转换继续走 `place_image`。
    pub fn place_asset(&mut self, params: Value, bytes: &[u8]) -> Result<Value> {
        self.require_no_stroke()?;
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| command_error("file.place", "缺少资产名称"))?
            .to_string();
        if bytes.is_empty() {
            return Err(command_error("file.place", "素材为空"));
        }
        if bytes.len() > photocraft_project_verify::limits::MAX_CANVAS_PIXELS as usize {
            return Err(command_error("file.place", "素材字节超过置入预算"));
        }
        // 1) 真实解码（不信扩展名或 MIME），预检尺寸。
        let decoded = photocraft_codecs::decode_with(
            bytes,
            &photocraft_codecs::DecodeOptions {
                limits: photocraft_codecs::Limits {
                    max_width: photocraft_project_verify::limits::MAX_CANVAS_SIDE,
                    max_height: photocraft_project_verify::limits::MAX_CANVAS_SIDE,
                    max_pixels: photocraft_project_verify::limits::MAX_CANVAS_PIXELS,
                    max_alloc: photocraft_project_verify::limits::MAX_DECOMPRESSED_RESOURCE_BYTES,
                },
                ..Default::default()
            },
        )
        .map_err(|failure| command_error("file.place", format!("无法解码素材：{failure}")))?;
        let (width, height) = (decoded.width(), decoded.height());
        drop(decoded);
        Self::validate_image_size(width, height)?;
        self.check_layer_capacity()?;
        // 2) 只有显式要求时才建嵌入智能对象（依赖 P4 能力）。
        let smart = params.get("mode").and_then(Value::as_str) == Some("smartObject");
        if smart && !crate::capability::is_enabled("layer.smart-object.child-document") {
            return Err(EditorError::CapabilityDisabled("layer.smart-object".into()));
        }
        let mut place = params.as_object().cloned().unwrap_or_default();
        place.insert("smartObject".into(), json!(smart));
        place.insert("fit".into(), json!(false));
        let before = self.active_layer_id();
        photocraft_engine::file_cmds::place_bytes(
            &mut self.session,
            &name,
            bytes.to_vec(),
            None,
            &Value::Object(place),
        )
        .map_err(|failure| command_error("file.place", failure.to_string()))?;
        let placed = self.active_layer_id().filter(|id| Some(*id) != before);
        if let Some(asset_id) = params.get("assetId").and_then(Value::as_str).filter(|id| !id.is_empty()) {
            if let Some(layer) = placed {
                self.registry.register_placed(layer, asset_id);
            }
        }
        let mut result = self.active_json()?;
        if let Some(obj) = result.as_object_mut() {
            obj.insert("placedLayer".into(), json!(placed.map(|id| id.0)));
            obj.insert("width".into(), json!(width));
            obj.insert("height".into(), json!(height));
            obj.insert("mode".into(), json!(if smart { "smartObject" } else { "pixel" }));
        }
        Ok(result)
    }

    /// 置入前预检（不创建层）：返回真实解码类型与尺寸，供预览草稿使用。
    pub fn inspect_place_asset(&self, bytes: &[u8]) -> Result<Value> {
        if bytes.is_empty() {
            return Err(command_error("file.place", "素材为空"));
        }
        let format = photocraft_codecs::detect(bytes);
        let decoded = photocraft_codecs::decode_with(
            bytes,
            &photocraft_codecs::DecodeOptions {
                limits: photocraft_codecs::Limits {
                    max_width: photocraft_project_verify::limits::MAX_CANVAS_SIDE,
                    max_height: photocraft_project_verify::limits::MAX_CANVAS_SIDE,
                    max_pixels: photocraft_project_verify::limits::MAX_CANVAS_PIXELS,
                    max_alloc: photocraft_project_verify::limits::MAX_DECOMPRESSED_RESOURCE_BYTES,
                },
                ..Default::default()
            },
        )
        .map_err(|failure| command_error("file.place", format!("无法解码素材：{failure}")))?;
        Ok(json!({
            "format": format.map(|f| format!("{f:?}")).unwrap_or_else(|| "unknown".into()),
            "width": decoded.width(),
            "height": decoded.height(),
            "bytes": bytes.len(),
        }))
    }
}

fn bad_center() -> EditorError {
    command_error("edit.paste", "center 必须是有限数值对")
}

fn command_error(id: &str, message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: id.into(), message: message.to_string() }
}

/// 解析 `{layers:[id…]}` 或 `{layer:id}`；空表示「当前选择」。
fn layer_ids(params: &Value) -> Result<Vec<photocraft_doc::LayerId>> {
    if let Some(list) = params.get("layers").and_then(Value::as_array) {
        let mut ids = Vec::with_capacity(list.len());
        for value in list {
            ids.push(photocraft_doc::LayerId(
                value
                    .as_u64()
                    .ok_or_else(|| command_error("edit.copy", "layer id 非法"))?,
            ));
        }
        return Ok(ids);
    }
    match params.get("layer").and_then(Value::as_u64) {
        Some(id) => Ok(vec![photocraft_doc::LayerId(id)]),
        None => Ok(Vec::new()),
    }
}
