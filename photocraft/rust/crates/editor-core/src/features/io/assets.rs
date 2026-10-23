//! U07：按图层名称生成 Image Assets（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
//!
//! 名称语法直接复用上游 `engine::web_cmds` 的公开解析（`parse_asset_name` / `parse_defaults`），
//! 因此 `foo.png`、`200% foo@2x.png`、`48x48 icons/a.png8`、`photo.jpg80%`、
//! `?x100 thumb.gif` 与 `default` 变体层的行为与上游一致；本模块只负责**用户触发的一次打包**：
//!
//! - 逐条名称先经[`super::naming`]清理，防止 `..`、绝对路径与设备名写出包外；
//! - 每个资产独立隔离渲染该图层，按名称里的缩放/尺寸/格式/质量编码；
//! - 重名、空图层、编码失败逐项记录，不静默丢弃；
//! - 包内 `report.json` 记录计划与逐项结果，交付后可用 `inspect_bundle` 复核。
//!
//! 与上游 Generator 的差别是**不**开启监听、不写文档旁的 `-assets` 目录：本 change 只做
//! 「现在生成一次」的交付，不启动后台磁盘生成器。

use photocraft_doc::{Document, LayerContent, LayerId};
use photocraft_engine::web_cmds::{self, WebFormat, WebSettings};
use serde_json::{Value, json};

use super::budgets::budgets;
use super::naming::NamingPlan;
use crate::error::{EditorError, Result};

fn bad(message: impl std::fmt::Display) -> EditorError {
    EditorError::CommandFailed { id: "format.imageAssets".into(), message: message.to_string() }
}

/// 一个待生成资产（计划与交付共用）。
#[derive(Clone, Debug)]
pub struct AssetTarget {
    pub layer_id: u64,
    pub layer_name: String,
    /// 名称里写的原始相对路径。
    pub requested: String,
    /// 清理并去重后的相对路径。
    pub delivered: String,
    pub format: String,
    pub quality: Option<u8>,
    pub width: u32,
    pub height: u32,
    pub error: Option<String>,
}

/// 资产计划。
#[derive(Clone, Debug)]
pub struct AssetPlan {
    pub assets: Vec<AssetTarget>,
    pub renames: Vec<(String, String, &'static str)>,
    pub rejected: Vec<Value>,
    pub total_pixels: u64,
}

fn web_format_from_spec(format: &str) -> Option<WebFormat> {
    match format {
        "png8" => Some(WebFormat::Png8),
        "png24" | "png32" | "png" => Some(WebFormat::Png24),
        "jpg" | "jpeg" => Some(WebFormat::Jpeg),
        "gif" => Some(WebFormat::Gif),
        _ => None,
    }
}

/// WebP 资产不走 Save for Web 的量化路径（`web_cmds::optimize` 只编码 GIF/PNG/JPEG），
/// 由上游通用导出编码。
fn is_webp_asset(asset: &AssetTarget) -> bool {
    asset.format == "webp"
}

/// 清理资产相对路径：逐组件清理，保留 `/` 分隔的目录层级；整体长度与深度有界。
fn sanitize_relative(requested: &str, extension: &str, naming: &mut NamingPlan) -> String {
    let mut parts: Vec<String> = Vec::new();
    for component in requested.split(['/', '\\']) {
        let (clean, _) = super::naming::sanitize_component(component);
        parts.push(clean);
    }
    let file = parts.pop().unwrap_or_else(|| "未命名".to_string());
    // 文件名部分统一走重名/长度预算；目录部分只清理，不参与去重。
    let (stem, extension) = super::naming::split_name(&file, extension);
    let assigned = naming.assign(requested, &stem, &extension);
    let mut relative = parts.join("/");
    if !relative.is_empty() {
        relative.push('/');
    }
    relative.push_str(&assigned);
    let budgets = budgets();
    if relative.chars().count() > budgets.max_relative_path_length {
        let kept: String = relative.chars().take(budgets.max_relative_path_length).collect();
        return kept;
    }
    relative
}

/// 解析一次资产计划：扫描图层名，展开语法，计算每个资产的输出尺寸并核对预算。
pub fn plan_assets(doc: &Document) -> Result<AssetPlan> {
    let dpi = f64::from(doc.resolution_dpi.max(1.0));
    let budgets = budgets();
    let mut defaults: Option<Vec<web_cmds::AssetDefault>> = None;
    let mut jobs: Vec<(LayerId, String, web_cmds::AssetSpec)> = Vec::new();
    for (_, _, layer) in doc.walk() {
        if let Some(variants) = web_cmds::parse_defaults(&layer.name, dpi) {
            defaults = Some(variants);
            continue;
        }
        if matches!(layer.content, LayerContent::Adjustment(_)) {
            continue;
        }
        for spec in web_cmds::parse_asset_name(&layer.name, dpi) {
            jobs.push((layer.id, layer.name.clone(), spec));
        }
    }
    if jobs.is_empty() {
        return Err(bad("没有按资产语法命名的图层（例如 foo.png、200% foo@2x.png）"));
    }
    let variants = match defaults {
        Some(variants) if !variants.is_empty() => variants,
        _ => vec![web_cmds::AssetDefault::default()],
    };
    let mut naming = NamingPlan::new();
    let mut assets = Vec::new();
    let mut rejected = Vec::new();
    let mut total_pixels: u64 = 0;
    let mut seen_files = 0usize;
    for (layer_id, layer_name, spec) in jobs {
        for variant in &variants {
            if seen_files >= budgets.max_asset_files {
                rejected.push(json!({
                    "layerId": layer_id.0,
                    "name": layer_name.clone(),
                    "reason": format!("超过一次生成的 {} 个资产上限", budgets.max_asset_files),
                }));
                continue;
            }
            let (stem, extension) = spec.file.rsplit_once('.').unwrap_or((spec.file.as_str(), "png"));
            let requested = format!("{}{}{}.{extension}", variant.folder, stem, variant.suffix);
            let delivered = sanitize_relative(&requested, extension, &mut naming);
            let actual_extension = delivered.rsplit_once('.').map(|(_, extension)| extension).unwrap_or("png").to_string();
            doc.layer(layer_id).ok_or_else(|| bad("目标图层已失效"))?;
            let bounds = isolated_bounds(doc, layer_id);
            let (width, height, error) = match bounds {
                Ok(bounds) if bounds.is_empty() => (0, 0, Some("图层没有可见像素".to_string())),
                Ok(bounds) => {
                    let (w0, h0) = (f64::from(bounds.width().max(1)), f64::from(bounds.height().max(1)));
                    // 名称里的尺寸优先，`default` 变体再叠一层缩放（与上游生成器一致）。
                    let (mut w, mut h) = (w0, h0);
                    let scale = spec.scale.unwrap_or(1.0);
                    w *= scale;
                    h *= scale;
                    match (spec.width, spec.height) {
                        (Some(sw), Some(sh)) => {
                            w = sw;
                            h = sh;
                        }
                        (Some(sw), None) => {
                            h = h0 * sw / w0;
                            w = sw;
                        }
                        (None, Some(sh)) => {
                            w = w0 * sh / h0;
                            h = sh;
                        }
                        _ => {}
                    }
                    let variant_scale = variant.scale.unwrap_or(1.0);
                    w *= variant_scale;
                    h *= variant_scale;
                    match (variant.width, variant.height) {
                        (Some(sw), Some(sh)) => {
                            w = sw;
                            h = sh;
                        }
                        (Some(sw), None) => h = h * sw / w,
                        (None, Some(sh)) => w = w * sh / h,
                        _ => {}
                    }
                    let (w, h) = (w.round().max(1.0) as u32, h.round().max(1.0) as u32);
                    if w > budgets.max_export_dimension || h > budgets.max_export_dimension {
                        (0, 0, Some(format!("目标尺寸 {w}×{h} 超过单边预算 {}", budgets.max_export_dimension)))
                    } else {
                        (w, h, None)
                    }
                }
                Err(error) => (0, 0, Some(error)),
            };
            if error.is_none() {
                total_pixels = total_pixels.saturating_add(u64::from(width) * u64::from(height));
            }
            assets.push(AssetTarget {
                layer_id: layer_id.0,
                layer_name: layer_name.clone(),
                requested,
                delivered,
                format: actual_extension,
                quality: spec.quality,
                width,
                height,
                error,
            });
            seen_files += 1;
        }
    }
    if assets.iter().all(|asset| asset.error.is_some()) {
        return Err(bad("所有按名称资产都不可交付；请检查图层像素与名称语法"));
    }
    if total_pixels > budgets.max_asset_pixels {
        return Err(bad(format!(
            "资产像素总量 {} 超过本次预算 {}",
            total_pixels, budgets.max_asset_pixels
        )));
    }
    Ok(AssetPlan {
        assets,
        renames: naming.renames.into_iter().map(|rename| (rename.original, rename.delivered, rename.reason)).collect(),
        rejected,
        total_pixels,
    })
}

/// 计划 JSON（UI 显示与失败定位）。
pub fn plan_json(plan: &AssetPlan) -> Value {
    let budgets = budgets();
    json!({
        "kind": "assets",
        "assets": plan.assets.iter().map(|asset| json!({
            "layerId": asset.layer_id,
            "layerName": asset.layer_name,
            "requested": asset.requested,
            "fileName": asset.delivered,
            "format": asset.format,
            "quality": asset.quality,
            "width": asset.width,
            "height": asset.height,
            "ok": asset.error.is_none(),
            "error": asset.error,
        })).collect::<Vec<_>>(),
        "renames": plan.renames.iter().map(|(original, delivered, reason)| json!({
            "original": original, "delivered": delivered, "reason": reason
        })).collect::<Vec<_>>(),
        "rejected": plan.rejected,
        "totalPixels": plan.total_pixels,
        "budgets": { "files": budgets.max_asset_files, "pixels": budgets.max_asset_pixels, "bytes": budgets.max_asset_bytes },
        "ok": plan.assets.iter().any(|asset| asset.error.is_none()),
    })
}

/// 图层的隔离文档（真实像素与边界来自同一渲染）。
fn isolated_bounds(doc: &Document, id: LayerId) -> std::result::Result<photocraft_geom::Rect, String> {
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
    let mut bounds = photocraft_geom::Rect::EMPTY;
    for (index, pixel) in buffer.px.iter().enumerate() {
        if pixel[3] > 0.0 {
            let x = area.x0 + (index % width) as i32;
            let y = area.y0 + (index / width) as i32;
            bounds = bounds.union(&photocraft_geom::Rect::new(x, y, x + 1, y + 1));
        }
    }
    Ok(bounds)
}

fn settings_for(asset: &AssetTarget) -> Result<WebSettings> {
    let format = web_format_from_spec(&asset.format).ok_or_else(|| bad(format!("未知资产格式 `{}`", asset.format)))?;
    let base = WebSettings { transparency: true, matte: None, metadata: web_cmds::WebMetadata::None, ..WebSettings::default() };
    Ok(match format {
        WebFormat::Jpeg => WebSettings {
            format: WebFormat::Jpeg,
            quality: asset.quality.unwrap_or(90),
            matte: Some([1.0, 1.0, 1.0]),
            ..base
        },
        WebFormat::Png8 => WebSettings { format: WebFormat::Png8, dither: photocraft_algo::quantize::Dither::None, ..base },
        WebFormat::Png24 => WebSettings { format: WebFormat::Png24, ..base },
        WebFormat::Gif => WebSettings { format: WebFormat::Gif, dither: photocraft_algo::quantize::Dither::None, ..base },
        WebFormat::Wbmp => return Err(bad("WBMP 不在本 change 的交付范围")),
    })
}

/// 交付按名称资产包（一次用户触发；内存 ZIP + `report.json`）。
pub fn export_assets(doc: &Document, plan: &AssetPlan, revision: u64, content_hash: &str) -> Result<super::export::EncodedImage> {
    let budgets = budgets();
    let mut writer = photocraft_format::zip::ZipWriter::new();
    let mut entries = Vec::with_capacity(plan.assets.len());
    let mut total_bytes: usize = 0;
    let mut paths = std::collections::BTreeSet::new();
    for asset in &plan.assets {
        if let Some(error) = &asset.error {
            entries.push(json!({
                "fileName": asset.delivered,
                "layerId": asset.layer_id,
                "layerName": asset.layer_name,
                "requested": asset.requested,
                "ok": false,
                "error": error,
            }));
            continue;
        }
        if !paths.insert(asset.delivered.to_ascii_lowercase()) {
            entries.push(json!({
                "fileName": asset.delivered,
                "layerId": asset.layer_id,
                "layerName": asset.layer_name,
                "requested": asset.requested,
                "ok": false,
                "error": "交付路径重复（同名资产已存在）",
            }));
            continue;
        }
        let encoded = (|| -> Result<Vec<u8>> {
            let isolated = photocraft_engine::layer_menu_cmds::layer_document(doc, LayerId(asset.layer_id))
                .map_err(|error| bad(format!("无法隔离图层 {}：{error}", asset.layer_name)))?;
            // WebP 先分流：它没有 Save for Web 的调色板设置，走通用导出。
            let settings = if is_webp_asset(asset) {
                WebSettings { transparency: true, matte: None, metadata: web_cmds::WebMetadata::None, ..WebSettings::default() }
            } else {
                settings_for(asset)?
            };
            let params = json!({ "width": asset.width, "height": asset.height, "resample": "bicubic" });
            let (web_doc, _, _) = web_cmds::web_document(&isolated, &params, &settings)
                .map_err(|error| bad(format!("无法缩放到 {}×{}：{error}", asset.width, asset.height)))?;
            let buffer = photocraft_compose::flatten(&web_doc);
            if buffer.rect.is_empty() {
                return Err(bad("资产没有可见像素"));
            }
            // WebP 资产走上游通用导出：`web_cmds::optimize` 只编码 GIF/PNG-8/PNG-24/JPEG，
            // 不含 WebP，否则会把 `.webp` 交付成 PNG 字节。
            if is_webp_asset(asset) {
                let options = photocraft_io::ExportOptions {
                    encode: photocraft_codecs::EncodeOptions {
                        webp_lossless: false,
                        webp_quality: asset.quality.unwrap_or(80),
                        ..Default::default()
                    },
                    xmp: photocraft_io::XmpEmbed::None,
                    image_previews: false,
                    psd_maximize_compatibility: false,
                    ..Default::default()
                };
                return photocraft_io::export(&web_doc, "webp", &options)
                    .map(|exported| exported.bytes)
                    .map_err(|error| bad(format!("WebP 资产编码失败：{error}")));
            }
            let icc = web_doc.icc_profile.as_deref().map(|profile| profile.as_slice());
            let optimized = web_cmds::optimize(
                &buffer.px,
                buffer.rect.width() as usize,
                buffer.rect,
                &settings,
                if settings.embed_icc { icc } else { None },
                None,
                web_doc.resolution_dpi,
                false,
            )
            .map_err(|error| bad(format!("资产编码失败：{error}")))?;
            Ok(optimized.bytes)
        })();
        match encoded {
            Ok(bytes) => {
                if total_bytes.saturating_add(bytes.len()) > budgets.max_asset_bytes {
                    return Err(bad(format!("资产包超过字节预算 {}", budgets.max_asset_bytes)));
                }
                writer.add(&asset.delivered, &bytes).map_err(|error| bad(format!("打包失败：{error}")))?;
                total_bytes = total_bytes.saturating_add(bytes.len());
                entries.push(json!({
                    "fileName": asset.delivered,
                    "layerId": asset.layer_id,
                    "layerName": asset.layer_name,
                    "requested": asset.requested,
                    "format": asset.format,
                    "width": asset.width,
                    "height": asset.height,
                    "bytes": bytes.len(),
                    "ok": true,
                }));
            }
            Err(error) => entries.push(json!({
                "fileName": asset.delivered,
                "layerId": asset.layer_id,
                "layerName": asset.layer_name,
                "requested": asset.requested,
                "ok": false,
                "error": error.message(),
            })),
        }
    }
    let ok_count = entries.iter().filter(|entry| entry["ok"] == true).count();
    if ok_count == 0 {
        return Err(bad("没有任何资产可交付"));
    }
    let report = json!({
        "kind": "assets",
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
        "budgets": { "files": budgets.max_asset_files, "pixels": budgets.max_asset_pixels, "bytes": budgets.max_asset_bytes },
        "documentChanged": false,
    });
    writer
        .add("report.json", serde_json::to_string_pretty(&report).map_err(|error| bad(error.to_string()))?.as_bytes())
        .map_err(|error| bad(format!("打包报告失败：{error}")))?;
    let bytes = writer.finish().map_err(|error| bad(format!("打包失败：{error}")))?;
    Ok(super::export::EncodedImage { bytes, report })
}

#[cfg(test)]
#[path = "tests_assets.rs"]
mod tests;
