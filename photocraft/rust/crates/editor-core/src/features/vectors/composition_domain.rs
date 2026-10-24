use super::*;

/// 当前开放的矢量命令（本域唯一白名单；`vector_command` 与能力清单共用）。
///
/// change: 2026-10-22-add-photocraft-vector-canvas-tools 追加 U08–U16 的实际入口：
/// 形状拖绘复用 `shape.create`，布尔运算、锚点编辑、矢量蒙版编辑与形状预设各自补齐。
pub const VECTOR_COMMANDS: &[&str] = &[
    "shape.create",
    "shape.edit",
    "shape.info",
    "shape.rasterize",
    "path.list",
    "path.info",
    "path.set",
    "path.delete",
    "path.rename",
    "path.transform",
    "path.moveAnchors",
    "path.moveHandle",
    "path.bendSegment",
    "path.convertPoint",
    "path.addAnchor",
    "path.deleteAnchor",
    "path.toSelection",
    "path.fill",
    "path.stroke",
    "path.clippingPath.set",
    "path.clippingPath.clear",
    "layer.vectorMask.add",
    "layer.vectorMask.delete",
    "layer.vectorMask.enabled",
    "layer.vectorMask.linked",
    "layer.vectorMask.info",
    "layer.vectorMask.edit",
    "layer.vectorMask.fromPath",
    "layer.vectorMask.currentPath",
    "layer.vectorMask.hideAll",
    "layer.vectorMask.revealAll",
    "layer.rasterize.shape",
    "layer.rasterize.vectorMask",
    "layer.combineShapes.unite",
    "layer.combineShapes.subtractFrontShape",
    "layer.combineShapes.intersectShapeAreas",
    "layer.combineShapes.excludeOverlappingShapes",
    "layer.combineShapes.mergeShapeComponents",
    "shape.presets.list",
    "shape.presets.place",
    "shape.presets.new",
    "shape.presets.edit",
    "shape.presets.reset",
    "edit.defineCustomShape",
    "select.toWorkPath",
    "select.convertToShape",
];

/// 形状布尔运算：五种操作的唯一映射（层序与填充规则由上游决定，不本地重算）。
pub const COMBINE_COMMANDS: &[&str] = &[
    "layer.combineShapes.unite",
    "layer.combineShapes.subtractFrontShape",
    "layer.combineShapes.intersectShapeAreas",
    "layer.combineShapes.excludeOverlappingShapes",
    "layer.combineShapes.mergeShapeComponents",
];

/// 锚点级编辑命令（U12）。
pub const PATH_EDIT_COMMANDS: &[&str] = &[
    "path.moveAnchors",
    "path.moveHandle",
    "path.bendSegment",
    "path.convertPoint",
    "path.addAnchor",
    "path.deleteAnchor",
];

/// 形状预设命令（U16）。
pub const PRESET_COMMANDS: &[&str] =
    &["shape.presets.list", "shape.presets.place", "shape.presets.new", "shape.presets.edit", "shape.presets.reset"];

/// 矢量蒙版可编辑命令（U15）：新增/删除/启停/链接/编辑/转换。
pub const MASK_COMMANDS: &[&str] = &[
    "layer.vectorMask.add",
    "layer.vectorMask.delete",
    "layer.vectorMask.enabled",
    "layer.vectorMask.linked",
    "layer.vectorMask.fromPath",
    "layer.vectorMask.currentPath",
    "layer.vectorMask.hideAll",
    "layer.vectorMask.revealAll",
    "layer.vectorMask.edit",
];

/// 矢量路径几何校验：形状、节点与坐标必须有限且在画布范围内。
pub fn validate_path(document: &Document, path: &Value) -> Result<()> {
    let parsed = photocraft_engine::vector_cmds::parse_path(path)
        .map_err(|message| error("vector.path", message))?;
    if parsed.is_empty() {
        return Err(error("vector.path", "路径没有节点"));
    }
    let limit = f64::from(photocraft_project_verify::limits::MAX_CANVAS_SIDE) * 8.0;
    for subpath in &parsed.subpaths {
        for knot in &subpath.knots {
            for point in [knot.anchor, knot.in_ctrl, knot.out_ctrl] {
                if !point.x.is_finite() || !point.y.is_finite() || point.x.abs() > limit || point.y.abs() > limit {
                    return Err(error("vector.path", "路径坐标必须是文档范围内的有限数值"));
                }
            }
        }
    }
    // 矢量蒙版与形状都要落在文档可保存范围内（预算与核验器同一份 `project-limits.json`）。
    if parsed.subpaths.len() > photocraft_project_verify::limits::MAX_VECTOR_SUBPATHS {
        return Err(error("vector.path", "路径子路径过多"));
    }
    let mut points: u64 = 0;
    for subpath in &parsed.subpaths {
        if subpath.knots.len() > photocraft_project_verify::limits::MAX_VECTOR_KNOTS_PER_SUBPATH {
            return Err(error("vector.path", "单条子路径锚点过多"));
        }
        points = points.saturating_add(subpath.knots.len() as u64);
        if points > photocraft_project_verify::limits::MAX_VECTOR_PATH_POINTS {
            return Err(error("vector.path", "路径锚点累计过多"));
        }
    }
    let _ = document;
    Ok(())
}

/// 路径转选区：走内核，一步提交。
pub fn path_to_selection(session: &mut Session, params: Value) -> Result<Value> {
    validate_document_ready(session)?;
    session
        .execute("path.toSelection", params)
        .map_err(|failure| error("path.toSelection", failure))
}

/// 矢量蒙版：新建／删除／启停／链接／直接编辑，全部走内核一步历史。
pub fn vector_mask(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    if !MASK_COMMANDS.contains(&id) && id != "layer.vectorMask.info" {
        return Err(error("layer.vectorMask", format!("{id} 不是已开放的矢量蒙版命令")));
    }
    validate_document_ready(session)?;
    if let Some(path) = params.get("path") {
        let document = session.active().unwrap().doc.clone();
        validate_path(&document, path)?;
    }
    if id == "layer.vectorMask.edit" {
        validate_mask_edit(&params)?;
    }
    // 「从工作路径设为矢量蒙版」拿的是文档里的路径：同样不能是全零覆盖的退化几何，
    // 否则整层会直接消失，看起来像「蒙版把图层隐藏了」（2026-10-24 审片 A5）。
    if id == "layer.vectorMask.fromPath" {
        require_maskable_work_path(session, &params)?;
    }
    session.execute(id, params).map_err(|failure| error("layer.vectorMask", failure))
}

/// 从工作路径建立蒙版前，要求路径真的圈得住面积。
///
/// 空路径的语义是「全显」，但**零面积**（共线锚点、少于 3 个锚点、或在画布外）会栅格化成
/// 全零覆盖率，整层消失。这类路径多半是录制/操作时点得太随意，静默藏掉整层比直接报错更难排查。
fn require_maskable_work_path(session: &Session, params: &Value) -> Result<()> {
    let Some(state) = session.active() else { return Ok(()) };
    let name = params.get("name").and_then(Value::as_str);
    let path = match name {
        // 工作路径是文档里的 `work_path`；显式名字走文档路径表。
        None => state.doc.work_path.clone(),
        Some(name) if name == "work" => state.doc.work_path.clone(),
        Some(name) => state.doc.paths.iter().find(|entry| entry.name == name).map(|entry| entry.path.clone()),
    };
    let Some(path) = path else { return Ok(()) };
    // 已经显式反转的蒙版（"全隐"）是有意为之，不按退化几何拦。
    if path.inverted {
        return Ok(());
    }
    let knots: usize = path.subpaths.iter().map(|subpath| subpath.knots.len()).sum();
    let mut min = (f64::INFINITY, f64::INFINITY);
    let mut max = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for subpath in &path.subpaths {
        for knot in &subpath.knots {
            min.0 = min.0.min(knot.anchor.x);
            min.1 = min.1.min(knot.anchor.y);
            max.0 = max.0.max(knot.anchor.x);
            max.1 = max.1.max(knot.anchor.y);
        }
    }
    let area = (max.0 - min.0) * (max.1 - min.1);
    if path.subpaths.is_empty() || knots < 3 || !area.is_finite() || area <= 0.5 {
        return Err(error(
            "layer.vectorMask",
            "工作路径没有圈出可蒙版的区域；请用钢笔画出闭合轮廓（至少三个不共线的锚点）后再设为矢量蒙版"
        ));
    }
    Ok(())
}

/// 直接编辑矢量蒙版前的参数校验：密度/羽化范围在分配资源前裁定。
pub fn validate_mask_edit(params: &Value) -> Result<()> {
    if let Some(density) = params.get("density") {
        let value = density.as_f64().filter(|value| value.is_finite() && (0.0..=100.0).contains(value));
        if value.is_none() {
            return Err(error("layer.vectorMask", "矢量蒙版密度必须在 0–100 之间"));
        }
    }
    if let Some(feather) = params.get("feather") {
        let value = feather.as_f64().filter(|value| value.is_finite() && (0.0..=1000.0).contains(value));
        if value.is_none() {
            return Err(error("layer.vectorMask", "矢量蒙版羽化必须在 0–1000 px 之间"));
        }
    }
    if let Some(invert) = params.get("invert")
        && !invert.is_boolean()
    {
        return Err(error("layer.vectorMask", "invert 必须是布尔值"));
    }
    Ok(())
}

/// 形状新建／编辑／信息／栅格化：几何校验后走内核。
pub fn shape(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    if !matches!(id, "shape.create" | "shape.edit" | "shape.info" | "shape.rasterize") {
        return Err(error("shape", format!("{id} 不是已开放的形状命令")));
    }
    validate_document_ready(session)?;
    if let Some(path) = params.get("path") {
        let document = session.active().unwrap().doc.clone();
        validate_path(&document, path)?;
    }
    if id == "shape.edit" || id == "shape.create" {
        // 半径上限取决于**最终**矩形：请求自带 `rect` 时用它，否则沿用图层现有规范形状。
        let layer = params.get("layer").and_then(Value::as_u64);
        let rect = params
            .get("rect")
            .and_then(request_rect)
            .or_else(|| session.active().and_then(|active| previous_live_rect(&active.doc, layer)));
        // 种类同理：`shape.edit` 可以只改星形比例而不重报 `kind`，此时按图层现有种类裁定，
        // 否则星形的 1.0 会被当成合法多边形比例而把星形悄悄改成多边形。
        let kind = params
            .get("kind")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| session.active().and_then(|active| previous_live_kind(&active.doc, layer)));
        validate_shape_params(&params, rect, kind.as_deref())?;
    }
    session.execute(id, params).map_err(|failure| error("shape", failure))
}

/// 形状参数的显式范围（避免非法数值被上游静默夹到边界后提交）。
///
/// 圆角半径的上限与矩形短边有关：`shape.create` 明确带 `rect`，`shape.edit` 可以只改半径
/// 而沿用图层现有矩形——因此由调用方传入将被使用的矩形（`None` 表示无法确定，跳过上限）。
fn validate_shape_params(params: &Value, rect: Option<[f64; 4]>, kind: Option<&str>) -> Result<()> {
    // 显式给出的矩形必须真的能围出面积：上游对 `rect: [x, y, 0, h]` 是宽容的，
    // 会建出一个零面积的隐形形状。这里在提交前拒掉，避免「看不见的图层」。
    if let Some(value) = params.get("rect")
        && request_rect(value).is_none()
    {
        return Err(error("shape", "形状矩形必须是四个有限数值且宽高为正"));
    }
    for key in ["sides"] {
        if let Some(value) = params.get(key) {
            let sides = value.as_u64().filter(|value| (3..=100).contains(value));
            if sides.is_none() {
                return Err(error("shape", "多边形的边数必须在 3–100 之间"));
            }
        }
    }
    if let Some(value) = params.get("starRatio") {
        let star = kind == Some("star");
        // 上游用 `star_ratio == 1.0` 表示「正多边形」这一哨兵值，因此多边形的 1.0 合法；
        // 星形必须是真正凹进去的，1.0 及以上会退化成多边形，按非法处理。
        let ratio = value.as_f64().filter(|value| {
            value.is_finite()
                && if star {
                    (0.01..1.0).contains(value)
                } else {
                    (0.01..=1.0).contains(value)
                }
        });
        if ratio.is_none() {
            return Err(error("shape", if star {
                "星形内外比例必须在 0.01–1（不含 1）之间"
            } else {
                "多边形内外比例必须在 0.01–1 之间"
            }));
        }
    }
    if let Some(value) = params.get("radii") {
        let limit = rect.map(|rect| rect[2].min(rect[3]) / 2.0);
        let ok = |radius: f64| radius.is_finite() && radius >= 0.0 && limit.is_none_or(|limit| radius <= limit);
        let ok = match value {
            Value::Number(number) => number.as_f64().is_some_and(ok),
            Value::Array(list) => list.len() == 4 && list.iter().all(|item| item.as_f64().is_some_and(ok)),
            _ => false,
        };
        if !ok {
            return Err(error("shape", "圆角半径必须是四个非负数且不超过短边的一半"));
        }
    }
    if let Some(value) = params.get("weight") {
        let weight = value.as_f64().filter(|value| value.is_finite() && (0.0..=1_000_000.0).contains(value));
        if weight.is_none() {
            return Err(error("shape", "直线粗细必须是 0–1000000 之间的有限数值"));
        }
    }
    // 同样是「看不见的图层」：零长度直线上游也会照收，这里一并拒掉。
    if params.get("kind").and_then(Value::as_str) == Some("line")
        && let (Some(from), Some(to)) = (params.get("from"), params.get("to"))
    {
        let point = |value: &Value| -> Option<[f64; 2]> {
            let list = value.as_array().filter(|list| list.len() == 2)?;
            let x = list[0].as_f64().filter(|value| value.is_finite())?;
            let y = list[1].as_f64().filter(|value| value.is_finite())?;
            Some([x, y])
        };
        if let (Some(from), Some(to)) = (point(from), point(to))
            && (to[0] - from[0]).hypot(to[1] - from[1]) < 1e-6
        {
            return Err(error("shape", "直线长度为零，请拖出更大的范围"));
        }
    }
    if let Some(value) = params.get("op") {
        let op = value.as_str().filter(|op| ["combine", "subtract", "intersect", "exclude"].contains(op));
        if op.is_none() {
            return Err(error("shape", "未知的路径运算 op"));
        }
    }
    if let Some(value) = params.get("fillRule") {
        let rule = value.as_str().filter(|rule| ["nonzero", "evenodd"].contains(rule));
        if rule.is_none() {
            return Err(error("shape", "填充规则必须是 nonzero 或 evenodd"));
        }
    }
    Ok(())
}

/// 请求里的 `[x, y, 宽, 高]`：四个有限数值且宽高为正，否则视为未提供。
fn request_rect(value: &Value) -> Option<[f64; 4]> {
    let list = value.as_array().filter(|list| list.len() == 4)?;
    let mut rect = [0.0; 4];
    for (index, item) in list.iter().enumerate() {
        rect[index] = item.as_f64().filter(|value| value.is_finite())?;
    }
    (rect[2] > 0.0 && rect[3] > 0.0).then_some(rect)
}

/// 将被 `shape.create` / `shape.edit` 使用的矩形：优先请求自身，其次图层现有规范形状。
///
/// 圆角的合法上限由这份矩形决定；两处都没有（例如只改描边的编辑）时返回 `None`，
/// 由上游按现有矩形处理，本层不做无依据的上限裁定。
fn previous_live_rect(document: &Document, layer: Option<u64>) -> Option<[f64; 4]> {
    if let Some(layer) = layer
        && let Some(target) = document.layer(LayerId(layer))
        && let photocraft_doc::LayerContent::Shape(shape) = &target.content
    {
        match shape.live.as_ref()? {
            photocraft_doc::vector::LiveShape::Rect { rect, .. }
            | photocraft_doc::vector::LiveShape::Ellipse { rect }
            | photocraft_doc::vector::LiveShape::Polygon { rect, .. } => return Some(*rect),
            photocraft_doc::vector::LiveShape::Line { .. } => return None,
        }
    }
    None
}

/// 图层现有规范形状的**界面种类**（`star` / `polygon` / `rect` / …）。
///
/// `shape.edit` 可以只改一个参数而不重报 `kind`；校验「星形比例」这类与种类相关的范围时，
/// 必须按图层实际种类裁定，否则会放过把星形改成多边形的请求。
fn previous_live_kind(document: &Document, layer: Option<u64>) -> Option<String> {
    let layer = layer?;
    let target = document.layer(LayerId(layer))?;
    let photocraft_doc::LayerContent::Shape(shape) = &target.content else { return None };
    Some(live_kind_name(shape.live.as_ref()?).to_string())
}

pub fn combine_shapes(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    if !COMBINE_COMMANDS.contains(&id) {
        return Err(error("layer.combineShapes", format!("{id} 不是已开放的形状布尔运算")));
    }
    validate_document_ready(session)?;
    if let Some(tolerance) = params.get("tolerance") {
        let ok = tolerance.as_f64().is_some_and(|value| value.is_finite() && (0.05..=10.0).contains(&value));
        if !ok {
            return Err(error("layer.combineShapes", "合并组件的容差必须在 0.05–10 px 之间"));
        }
    }
    session.execute(id, params).map_err(|failure| error("layer.combineShapes", failure))
}

/// 形状预设：读写库状态；应用时由上游把几何写成独立路径快照。
pub fn shape_presets(session: &mut Session, id: &str, params: Value) -> Result<Value> {
    if !PRESET_COMMANDS.contains(&id) {
        return Err(error("shape.presets", format!("{id} 不是已开放的形状预设命令")));
    }
    if id == "shape.presets.place" || id == "shape.presets.new" {
        validate_document_ready(session)?;
    }
    if id == "shape.presets.new"
        && let Some(name) = params.get("name").and_then(Value::as_str)
        && !crate::features::vectors::presets::name_allowed(name)
    {
        return Err(error("shape.presets", "预设名称不能为空且不超过 200 字符"));
    }
    if id == "shape.presets.place" {
        validate_preset_place(&params)?;
    }
    session.execute(id, params).map_err(|failure| error("shape.presets", failure))
}

/// 应用预设的参数裁定：矩形必须落到有限正尺寸，比例与运算枚举显式。
fn validate_preset_place(params: &Value) -> Result<()> {
    if let Some(rect) = params.get("rect") {
        let valid = rect
            .as_array()
            .filter(|list| list.len() == 4)
            .is_some_and(|list| {
                list.iter().all(|value| value.as_f64().is_some_and(|number| number.is_finite()))
            });
        if !valid {
            return Err(error("shape.presets", "预设矩形必须是四个有限数值 [x, y, 宽, 高]"));
        }
        if let Some(list) = rect.as_array() {
            let width = list[2].as_f64().unwrap_or(0.0);
            let height = list[3].as_f64().unwrap_or(0.0);
            if width <= 0.0 || height <= 0.0 {
                return Err(error("shape.presets", "预设矩形的宽高必须大于 0"));
            }
        }
    }
    if let Some(op) = params.get("op") {
        let op = op.as_str().filter(|op| ["combine", "subtract", "intersect", "exclude"].contains(op));
        if op.is_none() {
            return Err(error("shape.presets", "未知的预设路径运算 op"));
        }
    }
    if let Some(keep) = params.get("keepAspect")
        && !keep.is_boolean()
    {
        return Err(error("shape.presets", "keepAspect 必须是布尔值"));
    }
    Ok(())
}

/// Define Custom Shape：从路径（工作路径/已存路径/当前形状/矢量蒙版）定义库项。
pub fn define_custom_shape(session: &mut Session, params: Value) -> Result<Value> {
    validate_document_ready(session)?;
    if let Some(name) = params.get("name").and_then(Value::as_str)
        && !crate::features::vectors::presets::name_allowed(name)
    {
        return Err(error("edit.defineCustomShape", "形状名称不能为空且不超过 200 字符"));
    }
    if session.edit_state.custom_shapes.len() >= crate::features::vectors::presets::MAX_CUSTOM_SHAPES {
        // 新名字会追加一条；同名是覆盖，不占新名额。
        let replacing = params
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| session.edit_state.custom_shapes.iter().any(|shape| shape.name == name));
        if !replacing {
            return Err(error(
                "edit.defineCustomShape",
                format!("自定形状已达上限 {}", crate::features::vectors::presets::MAX_CUSTOM_SHAPES),
            ));
        }
    }
    session.execute("edit.defineCustomShape", params).map_err(|failure| error("edit.defineCustomShape", failure))
}

/// 当前文档的路径、形状与参考线快照（UI 叠加层只呈现这份数据）。
///
/// change: 2026-10-22-add-photocraft-vector-canvas-tools 追加可编辑属性：形状的实时参数
/// （kind/sides/radii/starRatio/from/to/weight）、填充/描边摘要与裁切路径引用，供属性面板
/// 在同一草稿里编辑当前形状（U09/U10/U13）。
pub fn vector_snapshot(document: &Document) -> Value {
    let masks = document
        .walk()
        .into_iter()
        .filter_map(|(_, _, layer)| {
            layer
                .vector_mask
                .as_ref()
                .map(|mask| json!({ "layer": layer.id.0, "enabled": mask.enabled, "linked": mask.linked, "density": mask.density, "feather": mask.feather, "path": mask.path, "inverted": mask.path.inverted }))
        })
        .collect::<Vec<_>>();
    let shapes = document
        .walk()
        .into_iter()
        .filter_map(|(_, _, layer)| match &layer.content {
            photocraft_doc::LayerContent::Shape(shape) => Some(json!({
                "layer": layer.id.0,
                "name": layer.name,
                "path": shape.path,
                "hasFill": shape.fill.is_some(),
                "hasStroke": shape.stroke.is_some(),
                "live": shape.live.as_ref().map(|live| serde_json::to_value(live).unwrap_or(Value::Null)),
                "kind": shape.live.as_ref().map(live_kind_name).unwrap_or("path"),
                "stroke": shape.stroke.as_ref().map(stroke_summary),
                "fill": shape.fill.as_ref().map(fill_summary),
            })),
            _ => None,
        })
        .collect::<Vec<_>>();
    json!({
        "vectorMasks": masks,
        "shapes": shapes,
        "paths": document.paths.iter().map(|named| json!({ "name": named.name, "path": named.path })).collect::<Vec<_>>(),
        "workPath": document.work_path,
        "clippingPath": document.clipping_path.as_ref().map(|clipping| json!({ "name": clipping.name, "flatness": clipping.flatness })),
        "guides": { "horizontal": document.guides.horizontal, "vertical": document.guides.vertical },
        "rulerOrigin": document.ruler_origin,
    })
}

fn live_kind_name(live: &photocraft_doc::vector::LiveShape) -> &'static str {
    use photocraft_doc::vector::LiveShape;
    match live {
        LiveShape::Rect { radii, .. } if radii.iter().any(|radius| *radius > 0.0) => "roundedRect",
        LiveShape::Rect { .. } => "rect",
        LiveShape::Ellipse { .. } => "ellipse",
        LiveShape::Polygon { star_ratio, .. } if *star_ratio < 1.0 => "star",
        LiveShape::Polygon { .. } => "polygon",
        LiveShape::Line { .. } => "line",
    }
}

/// 填充摘要：面板只需回显类型与颜色，不重建第二套填充模型。
fn fill_summary(fill: &photocraft_doc::Fill) -> Value {
    use photocraft_doc::Fill;
    match fill {
        Fill::Solid(color) => json!({ "type": "solid", "hex": color_hex(*color) }),
        Fill::Gradient { .. } => json!({ "type": "gradient" }),
        Fill::Pattern { name, .. } => json!({ "type": "pattern", "name": name }),
    }
}

/// 描边摘要：线宽、线帽/拐角/虚线/对齐与不透明度（U10 的属性编辑来源）。
fn stroke_summary(stroke: &photocraft_doc::vector::ShapeStroke) -> Value {
    json!({
        "width": stroke.width,
        "opacity": stroke.opacity,
        "align": format!("{:?}", stroke.align).to_ascii_lowercase(),
        "cap": format!("{:?}", stroke.cap).to_ascii_lowercase(),
        "join": format!("{:?}", stroke.join).to_ascii_lowercase(),
        "miterLimit": stroke.miter_limit,
        "dashes": stroke.dashes,
        "dashOffset": stroke.dash_offset,
        "paint": fill_summary(&stroke.paint),
    })
}

fn color_hex(color: photocraft_color::Color) -> String {
    let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", channel(color.c[0]), channel(color.c[1]), channel(color.c[2]))
}

fn validate_document_ready(session: &Session) -> Result<()> {
    if session.active().is_none() {
        return Err(EditorError::NoDocument);
    }
    Ok(())
}
