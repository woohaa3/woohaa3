//! U76 的前台自动化：Batch / Image Processor / Contact Sheet / Load Stack / 受限脚本
//! （change: 2026-10-22-add-photocraft-history-automation-workflows，design D3/D4）。
//!
//! 上游这些入口全部以 `input: folder|[paths]` 为输入、以目录为输出，浏览器里一律不可用。
//! 本域用**字节输入 + 字节交付**重写同一套语义，并保持三个可验证的性质：
//!
//! 1. **有界**：文件数、单文件字节、累计字节、步骤数与输出字节都有上限；
//! 2. **可取消**：队列是 `begin → step → cancel` 的形状，取消后**不再启动下一项**（不是「跑完
//!    再报取消」）；
//! 3. **逐文件报告**：每个输入都有一条独立结果（成功/失败原因），失败不影响后续项。
//!
//! 每个批处理项在**独立草稿会话**里处理：不改活动文档、不写宿主路径、不进本会话历史。处理结果
//! 以编码字节返回，由宿主交付。Contact Sheet 与 Load Stack 是「多输入 → 一份输出」，因此它们在
//! 第一步里一次合成，后续 `step` 立即报告完成。
use std::collections::HashSet;

use serde_json::{Value, json};

use crate::error::{EditorError, Result};
use crate::editor::*;
use super::command_error;
use super::preflight;

/// 一次队列的文件数上限。
pub const MAX_QUEUE_FILES: usize = 64;
/// 单个输入文件字节上限（64 MiB，与工程预算同量级）。
pub const MAX_INPUT_BYTES: usize = photocraft_project_verify::limits::MAX_PROJECT_BYTES;
/// 一次队列所有输入的累计字节上限（256 MiB）。
pub const MAX_QUEUE_BYTES: usize = photocraft_project_verify::limits::MAX_DECOMPRESSED_RESOURCE_BYTES as usize;
/// 一次交付的累计字节上限（64 MiB）。
pub const MAX_OUTPUT_BYTES: usize = photocraft_project_verify::limits::MAX_PROJECT_BYTES;
/// 单个批处理步骤数上限（与动作步骤预算一致）。
pub const MAX_BATCH_STEPS: usize = 2048;
/// Contact Sheet 的格子上限（列×行）。
pub const MAX_CONTACT_CELLS: usize = 64;
/// 受限脚本最多步骤数。
pub const MAX_SCRIPT_STEPS: usize = 512;
/// Contact Sheet 单格默认边长（像素）。
pub const DEFAULT_CELL: u32 = 240;

/// 队列的一项：名字（用于报告与命名）与字节。
#[derive(Clone, Debug)]
pub struct QueueItem {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// 一条逐文件结果。
#[derive(Clone, Debug)]
pub struct QueueResult {
    pub name: String,
    pub ok: bool,
    pub message: Option<String>,
    pub output_name: Option<String>,
    pub bytes: Option<Vec<u8>>,
}

/// 前台队列：一次 `begin` 规划整批，`step` 逐项推进，`cancel` 立刻停止。
#[derive(Debug, Default)]
pub struct BatchQueue {
    pub items: Vec<QueueItem>,
    pub cursor: usize,
    pub mode: String,
    pub format: String,
    pub steps: Vec<(String, Value)>,
    pub naming: Option<String>,
    pub fit: Option<(f64, f64)>,
    pub output_bytes: usize,
    pub results: Vec<QueueResult>,
    pub cancelled: bool,
}

impl BatchQueue {
    fn remaining(&self) -> usize {
        self.items.len().saturating_sub(self.cursor)
    }

    fn done(&self) -> bool {
        self.cancelled || self.cursor >= self.items.len()
    }
}

impl Editor {
    /// 规划队列：`{mode: batch|imageProcessor|contactSheet|loadStack, steps?, format?, input:[{name,data}]}`。
    ///
    /// `input` 里每项 `data` 是 base64 字节；不存在任何路径参数。超预算或步骤不可执行时在开始前
    /// 拒绝，因此「开始」要么完整成立，要么什么都没发生。
    pub fn batch_begin(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let mode = params.get("mode").and_then(Value::as_str).unwrap_or("batch").to_string();
        if !matches!(mode.as_str(), "batch" | "imageProcessor" | "contactSheet" | "loadStack") {
            return Err(command_error(
                "file.automate.batch",
                format!("未知的前台自动化 `{mode}`（batch|imageProcessor|contactSheet|loadStack）"),
            ));
        }
        let format = params.get("format").and_then(Value::as_str).unwrap_or("png").to_ascii_lowercase();
        if !matches!(format.as_str(), "png" | "jpg" | "jpeg" | "tif" | "tiff") {
            return Err(command_error(
                "file.automate.batch",
                format!("首期只支持 png/jpg/tif 交付，收到 `{format}`"),
            ));
        }
        let mut steps = script::parse_steps(params.get("steps"), "file.automate.batch")?;
        if mode == "loadStack" {
            // Load Stack 的合成在第一步里完成；步骤作用于结果文档。
        }
        if steps.len() > MAX_BATCH_STEPS {
            return Err(command_error(
                "file.automate.batch",
                format!("步骤数超过上限（{MAX_BATCH_STEPS}）"),
            ));
        }
        if !steps.is_empty() {
            preflight::confirm_steps(&steps).map_err(|message| command_error("file.automate.batch", message))?;
        }
        let items = decode_inputs(params.get("input"))?;
        if items.is_empty() {
            return Err(command_error("file.automate.batch", "没有输入文件"));
        }
        let fit = match (
            params.get("width").and_then(Value::as_f64),
            params.get("height").and_then(Value::as_f64),
        ) {
            (None, None) => None,
            (width, height) => {
                let width = width.unwrap_or(f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE)).max(1.0);
                let height = height.unwrap_or(f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE)).max(1.0);
                Some((width, height))
            }
        };
        if mode == "contactSheet" {
            let columns = params.get("columns").and_then(Value::as_u64).unwrap_or(5).max(1);
            let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(6).max(1);
            let cells = usize::try_from(columns.saturating_mul(rows)).unwrap_or(usize::MAX);
            if cells > MAX_CONTACT_CELLS {
                return Err(command_error(
                    "file.automate.contactSheetII",
                    format!("联系表网格超过上限（{MAX_CONTACT_CELLS} 格）"),
                ));
            }
            if items.len() > cells {
                return Err(command_error(
                    "file.automate.contactSheetII",
                    format!("输入 {} 张图片超过网格容量 {cells}", items.len()),
                ));
            }
            // 联系表本身不再套用逐步处理：它的参数是版面而不是动作步骤。
            steps.clear();
        }
        if mode == "loadStack" && items.len() < 2 {
            return Err(command_error("file.scripts.loadFilesIntoStack", "载入堆栈至少需要两个文件"));
        }
        let total = items.len();
        let queue = BatchQueue {
            items,
            mode: mode.clone(),
            format,
            steps,
            naming: params.get("naming").and_then(Value::as_str).map(str::to_string),
            fit,
            ..Default::default()
        };
        let id = preflight::insert(queue).map_err(|message| command_error("file.automate.batch", message))?;
        Ok(json!({
            "queue": id,
            "mode": mode,
            "files": total,
            "budget": batch_budget(),
        }))
    }

    /// 处理**一项**并返回进度；调用方（界面）每次 `step` 后都能看到逐项报告。
    pub fn batch_step(&mut self, id: u64) -> Result<Value> {
        preflight::with(id, |queue| {
            if queue.cancelled || queue.cursor >= queue.items.len() {
                return progress(queue);
            }
            // Contact Sheet / Load Stack 是「多输入 → 一份输出」，一次做完。
            if matches!(queue.mode.as_str(), "contactSheet" | "loadStack") {
                let result = if queue.mode == "contactSheet" {
                    run_contact_sheet(queue)
                } else {
                    run_load_stack(queue)
                };
                queue.cursor = queue.items.len();
                return finish_item(queue, result);
            }
            let item = queue.items[queue.cursor].clone();
            let result = run_one(queue, &item);
            queue.cursor = queue.cursor.saturating_add(1);
            finish_item(queue, result)
        })
        .ok_or_else(|| command_error("file.automate.batch", format!("队列 {id} 不存在或已收尾")))
    }

    /// 取消：清空剩余项，**不启动下一项**。已完成项的结果保留。
    pub fn batch_cancel(&mut self, id: u64) -> Value {
        let state = preflight::with(id, |queue| {
            queue.cancelled = true;
            if queue.cursor < queue.items.len() {
                queue.items.truncate(queue.cursor);
            }
            progress(queue)
        });
        state.unwrap_or_else(|| json!({ "cancelled": false, "message": format!("队列 {id} 不存在") }))
    }

    /// 收尾：取回全部结果的**摘要**并移除队列。
    ///
    /// 注意：交付字节随队列一起释放。尚未 [`Self::batch_take`] 领取的项在收尾后就取不到了
    /// （用户会以为只是整理列表而丢掉交付结果），因此界面必须在有未领取项时先说明并要求确认。
    pub fn batch_finish(&mut self, id: u64) -> Value {
        match preflight::take(id) {
            Some(queue) => {
                let mut cancelled = queue.cancelled;
                if queue.cursor < queue.items.len() {
                    // 未跑完就 finish：等同于取消，剩余项不再启动。
                    cancelled = true;
                }
                let results: Vec<Value> = queue
                    .results
                    .iter()
                    .map(|result| {
                        json!({
                            "file": result.name,
                            "ok": result.ok,
                            "error": result.message,
                            "output": result.output_name,
                            "bytes": result.bytes.as_ref().map(Vec::len),
                        })
                    })
                    .collect();
                json!({
                    "mode": queue.mode,
                    "cancelled": cancelled,
                    "completed": queue.results.len(),
                    "total": queue.items.len(),
                    "results": results,
                })
            }
            None => json!({ "mode": null, "cancelled": false, "completed": 0, "total": 0, "results": [] }),
        }
    }

    /// 取回一项的交付字节（base64），随后该项的字节从队列里移除，避免重复交付。
    pub fn batch_take(&mut self, id: u64, index: usize) -> Result<Value> {
        preflight::with(id, |queue| {
            let result = queue
                .results
                .get_mut(index)
                .ok_or_else(|| command_error("file.automate.batch", format!("没有第 {index} 项结果")))?;
            let bytes = result.bytes.take().ok_or_else(|| {
                command_error(
                    "file.automate.batch",
                    format!("第 {index} 项没有可交付的字节（失败项或已交付）"),
                )
            })?;
            Ok(json!({
                "file": result.name,
                "output": result.output_name,
                "data": photocraft_paint::tile::b64_encode(&bytes),
            }))
        })
        .unwrap_or_else(|| Err(command_error("file.automate.batch", format!("队列 {id} 不存在或已收尾"))))
    }

    /// 队列状态（界面在忙时禁用入口）。
    pub fn batch_state(&self, id: u64) -> Value {
        preflight::with(id, |queue| progress(queue)).unwrap_or_else(idle_state)
    }

    /// 受限声明式脚本：只能调用已开放命令，逐步骤预检，不 eval 任意代码。
    ///
    /// `{steps:[[id, params], …]}` 或 `{script: "command.id {json}" 每行一条}`。脚本不接受
    /// 路径，也不接受 ExtendScript；任一未知/未开放步骤在**执行前**整组拒绝。
    pub fn script_run(&mut self, params: Value) -> Result<Value> {
        self.require_no_stroke()?;
        self.require_no_tool_draft()?;
        let mut steps = script::parse_steps(params.get("steps"), "file.scripts.browse")?;
        if steps.is_empty() {
            let text = params
                .get("script")
                .and_then(Value::as_str)
                .ok_or_else(|| command_error("file.scripts.browse", "需要 steps 或 script 文本"))?;
            steps = script::parse_text(text)?;
        }
        if steps.is_empty() {
            return Err(command_error("file.scripts.browse", "脚本没有步骤"));
        }
        if steps.len() > MAX_SCRIPT_STEPS {
            return Err(command_error(
                "file.scripts.browse",
                format!("脚本步骤超过上限（{MAX_SCRIPT_STEPS}）"),
            ));
        }
        let report = preflight::confirm_steps(&steps)
            .map_err(|message| command_error("file.scripts.browse", message))?;
        let mut results = Vec::with_capacity(steps.len());
        let mut ok = true;
        for (index, (id, step_params)) in steps.into_iter().enumerate() {
            match self.execute(&id, step_params) {
                Ok(value) => results.push(json!({ "step": index, "id": id, "result": value })),
                Err(failure) => {
                    ok = false;
                    results.push(json!({ "step": index, "id": id, "error": failure.message() }));
                    break;
                }
            }
        }
        Ok(json!({ "ok": ok, "preflight": report, "results": results }))
    }
}

fn idle_state() -> Value {
    json!({ "mode": null, "total": 0, "completed": 0, "remaining": 0, "running": false, "cancelled": false, "results": [] })
}

fn progress(queue: &BatchQueue) -> Value {
    json!({
        "mode": queue.mode,
        "total": queue.items.len(),
        "completed": queue.cursor.min(queue.items.len()),
        "remaining": queue.remaining(),
        "running": !queue.done(),
        "cancelled": queue.cancelled,
        "outputBytes": queue.output_bytes,
        "results": queue.results.iter().map(|result| json!({
            "file": result.name,
            "ok": result.ok,
            "error": result.message,
            "output": result.output_name,
            "bytes": result.bytes.as_ref().map(Vec::len),
        })).collect::<Vec<_>>(),
    })
}

/// 追加一条结果并做交付字节预算。
fn finish_item(queue: &mut BatchQueue, result: QueueResult) -> Value {
    if let Some(bytes) = &result.bytes {
        queue.output_bytes = queue.output_bytes.saturating_add(bytes.len());
        if queue.output_bytes > MAX_OUTPUT_BYTES {
            queue.cancelled = true;
            queue.results.push(QueueResult {
                name: result.name,
                ok: false,
                message: Some(format!("交付总字节超过上限（{} MiB）", MAX_OUTPUT_BYTES / 1024 / 1024)),
                output_name: None,
                bytes: None,
            });
            return progress(queue);
        }
    }
    queue.results.push(result);
    progress(queue)
}

fn batch_budget() -> Value {
    json!({
        "maxFiles": MAX_QUEUE_FILES,
        "maxInputBytes": MAX_INPUT_BYTES,
        "maxTotalBytes": MAX_QUEUE_BYTES,
        "maxOutputBytes": MAX_OUTPUT_BYTES,
        "maxSteps": MAX_BATCH_STEPS,
        "maxContactCells": MAX_CONTACT_CELLS,
    })
}

/// 解析 `input:[{name, data}]`；超预算、缺字节或重复名称都整批拒绝。
fn decode_inputs(value: Option<&Value>) -> Result<Vec<QueueItem>> {
    let list = value
        .and_then(Value::as_array)
        .ok_or_else(|| command_error("file.automate.batch", "缺少 input（[{name, data}]）"))?;
    if list.len() > MAX_QUEUE_FILES {
        return Err(command_error(
            "file.automate.batch",
            format!("一次最多处理 {MAX_QUEUE_FILES} 个文件，当前 {} 个", list.len()),
        ));
    }
    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(list.len());
    let mut total = 0usize;
    for (index, entry) in list.iter().enumerate() {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| command_error("file.automate.batch", format!("第 {} 个输入缺少 name", index + 1)))?;
        if !seen.insert(name.to_lowercase()) {
            return Err(command_error(
                "file.automate.batch",
                format!("输入名称 `{name}` 重复：交付文件名会冲突"),
            ));
        }
        let data = entry
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| command_error("file.automate.batch", format!("输入 `{name}` 缺少 data（base64）")))?;
        let bytes = photocraft_paint::tile::b64_decode(data)
            .ok_or_else(|| command_error("file.automate.batch", format!("输入 `{name}` 不是合法 base64")))?;
        if bytes.is_empty() {
            return Err(command_error("file.automate.batch", format!("输入 `{name}` 是空文件")));
        }
        if bytes.len() > MAX_INPUT_BYTES {
            return Err(command_error(
                "file.automate.batch",
                format!("输入 `{name}` 超过单文件上限（{} MiB）", MAX_INPUT_BYTES / 1024 / 1024),
            ));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_QUEUE_BYTES {
            return Err(command_error(
                "file.automate.batch",
                format!("输入总字节超过上限（{} MiB）", MAX_QUEUE_BYTES / 1024 / 1024),
            ));
        }
        items.push(QueueItem { name: name.to_string(), bytes });
    }
    Ok(items)
}

/// 导入字节并转成可写的草稿会话。
fn scratch_session(name: &str, bytes: &[u8]) -> Result<photocraft_engine::Session> {
    let imported = photocraft_io::import(name, bytes)
        .map_err(|failure| command_error("file.automate.batch", format!("无法解码 `{name}`：{failure}")))?;
    let mut session = photocraft_engine::Session::new();
    session.add_document(imported.document, None);
    Ok(session)
}

/// 处理一项：解码 → 在草稿会话里缩放与跑步骤 → 编码交付。
fn run_one(queue: &BatchQueue, item: &QueueItem) -> QueueResult {
    let outcome = (|| -> std::result::Result<(String, Vec<u8>), EditorError> {
        let mut session = scratch_session(&item.name, &item.bytes)?;
        if let Some((width, height)) = queue.fit {
            fit(&mut session, width, height)?;
        }
        for (id, params) in &queue.steps {
            session
                .execute(id, params.clone())
                .map_err(|failure| command_error(id, failure))?;
        }
        let doc = session.active().ok_or(EditorError::NoDocument)?.doc.clone();
        let bytes = photocraft_io::export(&doc, &queue.format, &photocraft_io::ExportOptions::default())
            .map_err(|failure| command_error("file.automate.batch", format!("导出失败：{failure}")))?
            .bytes;
        Ok((output_name(queue, &item.name), bytes))
    })();
    match outcome {
        Ok((name, bytes)) => QueueResult {
            name: item.name.clone(),
            ok: true,
            message: None,
            output_name: Some(name),
            bytes: Some(bytes),
        },
        Err(failure) => QueueResult {
            name: item.name.clone(),
            ok: false,
            message: Some(failure.message()),
            output_name: None,
            bytes: None,
        },
    }
}

/// 等比缩放（不放大），与 Image Processor 的「适应」一致。
fn fit(session: &mut photocraft_engine::Session, width: f64, height: f64) -> Result<()> {
    let state = session.active().ok_or(EditorError::NoDocument)?;
    let (w, h) = (f64::from(state.doc.size.width.max(1)), f64::from(state.doc.size.height.max(1)));
    let scale = (width / w).min(height / h).min(1.0);
    let (nw, nh) = ((w * scale).round().max(1.0), (h * scale).round().max(1.0));
    if (nw - w).abs() < f64::EPSILON && (nh - h).abs() < f64::EPSILON {
        return Ok(());
    }
    session
        .execute("image.imageSize", json!({ "width": nw, "height": nh }))
        .map_err(|failure| command_error("image.imageSize", failure))?;
    Ok(())
}

/// 把一张已解码的图片合成为指定格式的图层表面（保持原尺寸）。
fn flatten_to_surface(doc: &photocraft_doc::Document, format: photocraft_color::PixelFormat) -> photocraft_doc::Surface {
    let buffer = photocraft_compose::render(doc, doc.bounds());
    let image = buffer.to_rgba8();
    let mut surface = photocraft_doc::Surface::new(photocraft_color::PixelFormat::RGBA8);
    let rect = photocraft_geom::Rect::from_xywh(0, 0, image.width, image.height);
    surface.write_interleaved(rect, &image.pixels);
    if format == photocraft_color::PixelFormat::RGBA8 { surface } else { surface.convert(format) }
}

/// Contact Sheet：把每张图按格缩放居中，输出一份联系表。
fn run_contact_sheet(queue: &BatchQueue) -> QueueResult {
    let outcome = (|| -> std::result::Result<(String, Vec<u8>), EditorError> {
        // 版面：固定单格边长，列数由输入数决定（最多 5 列，与默认网格一致）。
        let cell = DEFAULT_CELL;
        let margin = 8u32;
        let columns = 5u32.min(queue.items.len() as u32).max(1);
        let rows = ((queue.items.len() as u32).div_ceil(columns)).max(1);
        let width = columns.saturating_mul(cell).saturating_add(margin.saturating_mul(columns + 1));
        let height = rows.saturating_mul(cell).saturating_add(margin.saturating_mul(rows + 1));
        if width > photocraft_project_verify::limits::MAX_CANVAS_SIDE
            || height > photocraft_project_verify::limits::MAX_CANVAS_SIDE
        {
            return Err(command_error(
                "file.automate.contactSheetII",
                format!("联系表 {width}×{height} 超过画布单边上限 {}", photocraft_project_verify::limits::MAX_CANVAS_SIDE),
            ));
        }
        let mut sheet = photocraft_doc::Document::new(
            "Contact Sheet",
            photocraft_doc::Size::new(width, height),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
        );
        let format = sheet.pixel_format();
        let mut placed = 0usize;
        for item in &queue.items {
            let imported = photocraft_io::import(&item.name, &item.bytes)
                .map_err(|failure| command_error("file.automate.contactSheetII", format!("无法解码 `{}`：{failure}", item.name)))?;
            let source = flatten_to_surface(&imported.document, format);
            let (sw, sh) = (f64::from(source.content_bounds().width().max(1)), f64::from(source.content_bounds().height().max(1)));
            let scale = (f64::from(cell) / sw).min(f64::from(cell) / sh).min(1.0);
            let scaled = photocraft_algo::resample::resize_surface(
                &source,
                scale,
                scale,
                photocraft_algo::resample::Resample::Bicubic,
            );
            let (iw, ih) = (f64::from(scaled.content_bounds().width()), f64::from(scaled.content_bounds().height()));
            let column = placed as u32 % columns;
            let row = placed as u32 / columns;
            let x = margin + column * (cell + margin);
            let y = margin + row * (cell + margin);
            let dx = (f64::from(x) + (f64::from(cell) - iw) / 2.0).round() as i32;
            let dy = (f64::from(y) + (f64::from(cell) - ih) / 2.0).round() as i32;
            let cell_surface = photocraft_algo::resample::translate_surface(&scaled, dx, dy);
            sheet.layers.push(photocraft_doc::Layer::new(
                item.name.clone(),
                photocraft_doc::LayerContent::Raster(cell_surface),
            ));
            placed += 1;
        }
        let bytes = photocraft_io::export(&sheet, &queue.format, &photocraft_io::ExportOptions::default())
            .map_err(|failure| command_error("file.automate.contactSheetII", format!("导出失败：{failure}")))?
            .bytes;
        Ok((format!("contact-sheet.{}", queue.format), bytes))
    })();
    match outcome {
        Ok((name, bytes)) => QueueResult {
            name: format!("{} 张", queue.items.len()),
            ok: true,
            message: None,
            output_name: Some(name),
            bytes: Some(bytes),
        },
        Err(failure) => QueueResult {
            name: "contact-sheet".into(),
            ok: false,
            message: Some(failure.message()),
            output_name: None,
            bytes: None,
        },
    }
}

/// Load Files into Stack：一层一个文件，画布取最大尺寸。
fn run_load_stack(queue: &BatchQueue) -> QueueResult {
    let outcome = (|| -> std::result::Result<(String, Vec<u8>), EditorError> {
        let mut layers = Vec::with_capacity(queue.items.len());
        let (mut width, mut height) = (1u32, 1u32);
        for item in &queue.items {
            let imported = photocraft_io::import(&item.name, &item.bytes)
                .map_err(|failure| command_error("file.scripts.loadFilesIntoStack", format!("无法解码 `{}`：{failure}", item.name)))?;
            width = width.max(imported.document.size.width.max(1));
            height = height.max(imported.document.size.height.max(1));
            let kind = imported.document.mode;
            let depth = imported.document.depth;
            let surface = flatten_to_surface(&imported.document, photocraft_color::PixelFormat::new(kind, depth, true));
            layers.push(photocraft_doc::Layer::new(
                item.name.clone(),
                photocraft_doc::LayerContent::Raster(surface),
            ));
        }
        let mut stack = photocraft_doc::Document::new(
            "Stack",
            photocraft_doc::Size::new(width, height),
            photocraft_doc::ColorMode::Rgb,
            photocraft_doc::SampleType::U8,
        );
        stack.layers = layers;
        let mut session = photocraft_engine::Session::new();
        session.add_document(stack, None);
        for (id, params) in &queue.steps {
            session
                .execute(id, params.clone())
                .map_err(|failure| command_error(id, failure))?;
        }
        let doc = session.active().ok_or(EditorError::NoDocument)?.doc.clone();
        let bytes = photocraft_io::export(&doc, &queue.format, &photocraft_io::ExportOptions::default())
            .map_err(|failure| command_error("file.scripts.loadFilesIntoStack", format!("导出失败：{failure}")))?
            .bytes;
        Ok((format!("stack.{}", queue.format), bytes))
    })();
    match outcome {
        Ok((name, bytes)) => QueueResult {
            name: format!("{} 张", queue.items.len()),
            ok: true,
            message: None,
            output_name: Some(name),
            bytes: Some(bytes),
        },
        Err(failure) => QueueResult {
            name: "stack".into(),
            ok: false,
            message: Some(failure.message()),
            output_name: None,
            bytes: None,
        },
    }
}

/// 交付文件名：`{name}` / `{index}` 模板，默认沿用输入名的主干。
fn output_name(queue: &BatchQueue, input: &str) -> String {
    let stem = input.rsplit_once('.').map_or(input, |(base, _)| base);
    let extension = queue.format.trim_start_matches('.');
    match &queue.naming {
        Some(template) => format!(
            "{}.{extension}",
            template
                .replace("{name}", stem)
                .replace("{index}", &format!("{:03}", queue.cursor + 1))
        ),
        None => format!("{stem}.{extension}"),
    }
}

/// 受限脚本的步骤解析（JSON 数组、`{command,params}` 或每行一条命令）。
pub(crate) mod script {
    use serde_json::{Value, json};

    use crate::{EditorError, error::Result};

    fn bad(message: impl Into<String>) -> EditorError {
        EditorError::CommandFailed { id: "file.scripts.browse".into(), message: message.into() }
    }

    /// 解析 `steps`：`[id, params]`、`{command|id, params}` 或裸字符串 id。
    pub(crate) fn parse_steps(value: Option<&Value>, id: &str) -> Result<Vec<(String, Value)>> {
        let Some(value) = value else { return Ok(Vec::new()) };
        let list = value.as_array().ok_or_else(|| EditorError::CommandFailed {
            id: id.into(),
            message: "steps 必须是数组".into(),
        })?;
        let mut out = Vec::with_capacity(list.len());
        for step in list {
            let pair = match step {
                Value::Array(items) if !items.is_empty() => {
                    let command = items[0].as_str().ok_or_else(|| bad("步骤 id 必须是字符串"))?;
                    (command.to_string(), items.get(1).cloned().unwrap_or_else(|| json!({})))
                }
                Value::Object(object) => {
                    let command = object
                        .get("command")
                        .or_else(|| object.get("id"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("步骤对象需要 command"))?;
                    (command.to_string(), object.get("params").cloned().unwrap_or_else(|| json!({})))
                }
                Value::String(command) => (command.clone(), json!({})),
                _ => return Err(bad("每个步骤是 [id, params]、{command, params} 或 id")),
            };
            out.push(pair);
        }
        Ok(out)
    }

    /// 解析「每行一条 `command.id {json}`」的文本脚本；`#`/`//` 开头是注释。
    pub(crate) fn parse_text(text: &str) -> Result<Vec<(String, Value)>> {
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        let mut out = Vec::new();
        for (line_number, line) in text.lines().enumerate() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
                continue;
            }
            if line.contains("ExtendScript") || line.contains("app.activeDocument") {
                return Err(bad("不支持 ExtendScript / 任意脚本：脚本只能是已开放命令的声明式列表"));
            }
            let (id, rest) = line
                .split_once(char::is_whitespace)
                .map_or((line, ""), |(id, rest)| (id, rest.trim()));
            let params = if rest.is_empty() {
                json!({})
            } else {
                serde_json::from_str(rest).map_err(|failure| bad(format!("第 {} 行：{failure}", line_number + 1)))?
            };
            out.push((id.to_string(), params));
        }
        Ok(out)
    }
}
