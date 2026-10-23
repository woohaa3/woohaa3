//! U07：逐层导出、Layers to Files 与按图层名称生成 Image Assets
//! （change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
//!
//! ## 用户触发、内存组装
//!
//! 全部交付都是**一次用户操作 → 一个内存 ZIP 包**：逐层的像素、边界、命名与报告一起放进包，
//! 由宿主/浏览器负责落盘。这里没有目录监听、没有后台生成器、不读本机路径，因此图层名里的
//! 路径片段不可能写到预期目录之外（[`super::naming`] 逐组件清理）。
//!
//! ## 计划与交付同源
//!
//! [`plan_layers`] 产出的计划（目标层、边界、交付名、冲突、拒绝原因、预算）就是
//! [`export_layers`] 的实际输入；包内 `report.json` 记录同一份计划，交付后可用
//! [`inspect_bundle`] 独立复核「包里有什么、哪一项失败、为什么」。
//!
//! ## 逐项失败可定位
//!
//! 单个图层为空、超出包预算或编码失败时，其余图层仍然交付；报告逐项记录 `ok`/`error`。
//! 只有**整包**无可用文件或预算超限时整体拒绝。

use photocraft_doc::{Document, LayerId};
use photocraft_geom::Rect;
use serde_json::{Value, json};

use super::budgets::budgets;
use super::naming::{split_name, NamingPlan};
use crate::error::{EditorError, Result};

fn bad(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "format.layers".into(), message: message.to_string() }
}

/// 逐层导出的一个目标层（计划与交付共用）。
#[derive(Clone, Debug)]
pub struct LayerTarget {
    pub layer_id: u64,
    pub name: String,
    /// 清理并去重后的交付名。
    pub file_name: String,
    /// 图层隔离后的像素边界（相对画布）。
    pub width: u32,
    pub height: u32,
    pub empty: bool,
    pub error: Option<String>,
}

/// 一次逐层导出/资产计划。
#[derive(Clone, Debug)]
pub struct InterchangePlan {
    pub kind: &'static str,
    pub format: String,
    pub layers: Vec<LayerTarget>,
    pub renames: Vec<(String, String, &'static str)>,
    pub rejected: Vec<Value>,
    pub total_pixels: u64,
    pub bytes_budget: usize,
    pub files_budget: usize,
}

/// 从参数取目标图层；缺省用当前选择（活动层 + 已选层）。
fn requested_layers(doc: &Document, active: Option<LayerId>, selected: &[LayerId], params: &Value) -> Result<Vec<LayerId>> {
    if let Some(list) = params.get("layers") {
        let list = list.as_array().ok_or_else(|| bad("`layers` 必须是图层 id 数组"))?;
        if list.len() > budgets().max_layer_bundle_files {
            return Err(bad(format!(
                "一次最多导出 {} 个图层",
                budgets().max_layer_bundle_files
            )));
        }
        let mut out = Vec::with_capacity(list.len());
        for item in list {
            let id = item.as_u64().ok_or_else(|| bad("图层 id 必须是整数"))?;
            if doc.layer(LayerId(id)).is_none() {
                return Err(bad(format!("目标图层已失效：{id}")));
            }
            out.push(LayerId(id));
        }
        if out.is_empty() {
            return Err(bad("未选择任何图层"));
        }
        return Ok(out);
    }
    let mut out: Vec<LayerId> = selected.to_vec();
    if out.is_empty() {
        out.extend(active);
    }
    if out.is_empty() {
        return Err(bad("未选择任何图层"));
    }
    out.retain(|id| doc.layer(*id).is_some());
    if out.is_empty() {
        return Err(bad("目标图层已失效"));
    }
    out.truncate(budgets().max_layer_bundle_files);
    Ok(out)
}

/// 图层隔离后的真实像素边界（与交付用的 `layer_document` 同一判定：只算不透明像素）。
fn isolated_bounds(doc: &Document, id: LayerId) -> std::result::Result<Rect, String> {
    let layer = doc.layer(id).ok_or_else(|| format!("目标图层已失效：{}", id.0))?;
    let mut alone = layer.clone();
    alone.visible = true;
    alone.clipped = false;
    let mut tmp = doc.clone();
    tmp.layers = vec![alone];
    tmp.selection = None;
    let area = doc.bounds();
    let buffer = photocraft_compose::render(&tmp, area);
    let width = area.width() as usize;
    let mut bounds = Rect::EMPTY;
    for (index, pixel) in buffer.px.iter().enumerate() {
        if pixel[3] > 0.0 {
            let x = area.x0 + (index % width) as i32;
            let y = area.y0 + (index / width) as i32;
            bounds = bounds.union(&Rect::new(x, y, x + 1, y + 1));
        }
    }
    Ok(bounds)
}

/// 计划一次逐层导出：解析目标、隔离边界、分配有界唯一文件名，并核对预算。
///
/// 不改文档、不产生历史；同一计划可直接交给 [`export_layers`]。
pub fn plan_layers(doc: &Document, active: Option<LayerId>, selected: &[LayerId], params: &Value) -> Result<InterchangePlan> {
    let extension = super::layers_extension(params)?;
    let ids = requested_layers(doc, active, selected, params)?;
    let mut naming = NamingPlan::new();
    let mut layers = Vec::with_capacity(ids.len());
    let mut rejected = Vec::new();
    let mut total_pixels: u64 = 0;
    for id in ids {
        let layer = match doc.layer(id) {
            Some(layer) => layer,
            None => {
                rejected.push(json!({"layerId": id.0, "reason": "目标图层已失效"}));
                continue;
            }
        };
        let (stem, extension_override) = if params.get("nameFromLayer").and_then(Value::as_bool).unwrap_or(true) {
            let (stem, from_name) = split_name(&layer.name, extension);
            // 图层名自带可写扩展名时以它为准，但仍然只允许本构建可写格式。
            if from_name != extension && photocraft_codecs::from_extension(&from_name).is_some_and(|format| format.caps().write) {
                (stem, from_name)
            } else {
                (stem, extension.to_string())
            }
        } else {
            (layer.name.clone(), extension.to_string())
        };
        let file_name = naming.assign(&layer.name, &stem, &extension_override);
        let bounds = isolated_bounds(doc, id);
        let (width, height, empty, error) = match bounds {
            Ok(bounds) if bounds.is_empty() => (0, 0, true, Some("图层没有可见像素".to_string())),
            Ok(bounds) => (bounds.width() as u32, bounds.height() as u32, false, None),
            Err(error) => (0, 0, true, Some(error)),
        };
        if !empty {
            total_pixels = total_pixels.saturating_add(u64::from(width) * u64::from(height));
        }
        layers.push(LayerTarget { layer_id: id.0, name: layer.name.clone(), file_name, width, height, empty, error });
    }
    let budgets = budgets();
    if total_pixels > budgets.max_layer_bundle_pixels {
        return Err(bad(format!(
            "逐层导出像素总量 {} 超过本次包预算 {}",
            total_pixels, budgets.max_layer_bundle_pixels
        )));
    }
    Ok(InterchangePlan {
        kind: "layers",
        format: extension.to_string(),
        layers,
        renames: naming.renames.into_iter().map(|rename| (rename.original, rename.delivered, rename.reason)).collect(),
        rejected,
        total_pixels,
        bytes_budget: budgets.max_layer_bundle_bytes,
        files_budget: budgets.max_layer_bundle_files,
    })
}

/// 计划的 JSON 视图（UI 用它显示交付名、冲突改写、失败项与预算）。
pub fn plan_json(plan: &InterchangePlan) -> Value {
    json!({
        "kind": plan.kind,
        "format": plan.format,
        "layers": plan.layers.iter().map(|layer| json!({
            "layerId": layer.layer_id,
            "name": layer.name,
            "fileName": layer.file_name,
            "width": layer.width,
            "height": layer.height,
            "empty": layer.empty,
            "error": layer.error,
        })).collect::<Vec<_>>(),
        "renames": plan.renames.iter().map(|(original, delivered, reason)| json!({
            "original": original, "delivered": delivered, "reason": reason
        })).collect::<Vec<_>>(),
        "rejected": plan.rejected,
        "totalPixels": plan.total_pixels,
        "budgets": { "files": plan.files_budget, "bytes": plan.bytes_budget },
        "ok": plan.layers.iter().any(|layer| !layer.empty) || !plan.rejected.is_empty(),
    })
}

/// 交付逐层包：每个目标层渲染成独立文档后按计划名编码，装入一个 ZIP，并写入 `report.json`。
pub fn export_layers(doc: &Document, plan: &InterchangePlan, revision: u64, content_hash: &str) -> Result<super::export::EncodedImage> {
    let mut writer = photocraft_format::zip::ZipWriter::new();
    let mut entries = Vec::with_capacity(plan.layers.len());
    let mut total_bytes: usize = 0;
    for target in &plan.layers {
        if target.empty {
            entries.push(json!({
                "fileName": target.file_name,
                "layerId": target.layer_id,
                "name": target.name,
                "ok": false,
                "error": target.error.clone().unwrap_or_else(|| "图层没有可见像素".into()),
            }));
            continue;
        }
        let encoded = (|| -> Result<(Vec<u8>, u32, u32)> {
            let isolated = photocraft_engine::layer_menu_cmds::layer_document(doc, LayerId(target.layer_id))
                .map_err(|error| bad(format!("无法隔离图层 {}：{error}", target.name)))?;
            let options = photocraft_io::ExportOptions {
                encode: photocraft_codecs::EncodeOptions::default(),
                force_psb: false,
                tiff_layers: false,
                xmp: photocraft_io::XmpEmbed::None,
                tga_bits: None,
                image_previews: false,
                psd_maximize_compatibility: false,
            };
            let exported = photocraft_io::export(&isolated, &plan.format, &options)
                .map_err(|error| bad(format!("{} 编码失败：{error}", plan.format)))?;
            Ok((exported.bytes, isolated.size.width, isolated.size.height))
        })();
        match encoded {
            Ok((bytes, width, height)) => {
                if total_bytes.saturating_add(bytes.len()) > plan.bytes_budget {
                    return Err(bad(format!(
                        "逐层包超过字节预算 {}（已含 {} 字节）",
                        plan.bytes_budget, total_bytes
                    )));
                }
                writer.add(&target.file_name, &bytes).map_err(|error| bad(format!("打包失败：{error}")))?;
                total_bytes = total_bytes.saturating_add(bytes.len());
                entries.push(json!({
                    "fileName": target.file_name,
                    "layerId": target.layer_id,
                    "name": target.name,
                    "width": width,
                    "height": height,
                    "bytes": bytes.len(),
                    "ok": true,
                }));
            }
            Err(error) => entries.push(json!({
                "fileName": target.file_name,
                "layerId": target.layer_id,
                "name": target.name,
                "ok": false,
                "error": error.message(),
            })),
        }
    }
    let ok_count = entries.iter().filter(|entry| entry["ok"] == true).count();
    if ok_count == 0 {
        return Err(bad("没有任何图层可交付；请检查图层可见像素与格式"));
    }
    let report = json!({
        "kind": "layers",
        "format": plan.format,
        "revision": revision,
        "documentContentHash": content_hash,
        "files": entries,
        "okCount": ok_count,
        "failedCount": entries.len() - ok_count,
        "totalBytes": total_bytes,
        "renames": plan.renames.iter().map(|(original, delivered, reason)| json!({
            "original": original, "delivered": delivered, "reason": reason
        })).collect::<Vec<_>>(),
        "rejected": plan.rejected,
        "settings": { "format": plan.format, "files": plan.files_budget, "bytes": plan.bytes_budget },
        "documentChanged": false,
    });
    writer
        .add("report.json", serde_json::to_string_pretty(&report).map_err(|error| bad(error.to_string()))?.as_bytes())
        .map_err(|error| bad(format!("打包报告失败：{error}")))?;
    let bytes = writer.finish().map_err(|error| bad(format!("打包失败：{error}")))?;
    Ok(super::export::EncodedImage { bytes, report })
}

/// 复核一个已交付的包：列出条目与 `report.json`，用于交付后核对（不落盘）。
pub fn inspect_bundle(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > budgets().max_layer_bundle_bytes.max(budgets().max_asset_bytes) {
        return Err(bad("包字节超过本域预算"));
    }
    let archive = photocraft_format::zip::ZipReader::new(bytes).map_err(|error| bad(format!("不是合法的包：{error}")))?;
    let mut files = Vec::with_capacity(archive.entries.len());
    for entry in &archive.entries {
        let size = archive.read(entry, 8 << 20).map(|data| data.len()).unwrap_or(0);
        files.push(json!({ "name": entry.name, "bytes": size }));
    }
    let report = archive
        .read_by_name("report.json", 4 << 20)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    Ok(json!({
        "files": files,
        "report": report,
        "bytes": bytes.len(),
    }))
}

#[cfg(test)]
#[path = "tests_layers.rs"]
mod tests;
