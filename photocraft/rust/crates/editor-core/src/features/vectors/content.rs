use super::*;

/// 已存命名路径 / 工作路径 / 裁切路径的身份摘要。
///
/// 这三者是**持久字段**（写进 `.pcraft` 的 `manifest.document.paths` / `work_path` /
/// `clipping_path`），因此必须进入内容身份：否则只改一条已存路径，工程字节变了而
/// `contentHash` 不变，宿主会把「有净变化」判成「无变化」而丢工作
/// （change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
///
/// 形态与 `identity.rs` 的规范化逐字节对应；**空值整体省略**，因此没有路径的旧工程指纹不变。
pub fn document_paths_identity(doc: &Document) -> Value {
    if doc.paths.is_empty() && doc.work_path.is_none() && doc.clipping_path.is_none() {
        return Value::Null;
    }
    let mut content = serde_json::Map::new();
    if !doc.paths.is_empty() {
        // 已存路径按名字稳定排序；同名再按摘要，避免加载顺序影响指纹。
        let mut paths: Vec<_> = doc
            .paths
            .iter()
            .map(|named| (named.name.clone(), path_hash(&named.path)))
            .collect();
        paths.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        content.insert(
            "paths".into(),
            Value::Array(paths.into_iter().map(|(name, hash)| json!({ "name": name, "contentHash": hash })).collect()),
        );
    }
    if let Some(work) = &doc.work_path {
        content.insert("workPath".into(), json!({ "contentHash": path_hash(work) }));
    }
    if let Some(clipping) = &doc.clipping_path {
        content.insert(
            "clippingPath".into(),
            json!({ "name": clipping.name, "flatness": f64::from(clipping.flatness) }),
        );
    }
    Value::Object(content)
}

pub fn path_hash(path: &photocraft_doc::vector::Path) -> String {
    let mut hash = Sha256::new();
    hash.update(b"photocraft-path-v1:");
    hash.update(format!("{:?}", path.fill_rule).as_bytes());
    hash.update([path.inverted as u8]);
    for subpath in &path.subpaths {
        hash.update(format!("{:?}", subpath.op).as_bytes());
        hash.update([subpath.closed as u8]);
        for knot in &subpath.knots {
            for point in [knot.anchor, knot.in_ctrl, knot.out_ctrl] {
                hash.update(point_coordinate(point.x));
                hash.update(point_coordinate(point.y));
            }
            hash.update([knot.smooth as u8]);
        }
    }
    hash.finalize()[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 形状层外观摘要：填充、描边与规范参数。
///
/// 这三者都是**持久字段**（写进 `.pcraft` 的形状层，重开后逐字段还原），因此必须并入
/// 形状层的内容身份；只算路径几何会让「只改描边宽度/颜色」「把填充改成无填充」被判成
/// 无净变化而丢工作（change: 2026-10-22-add-photocraft-vector-canvas-tools，任务 3.2）。
///
/// 形状层**路径几何**仍由 [`path_hash`] 单独摘要，两者在内容描述里是两个平行字段
/// （`shape.contentHash` / `shape.appearanceHash`），不合并成一套，避免改一处丢另一处。
pub fn shape_appearance_hash(shape: &photocraft_doc::vector::ShapeLayer) -> String {
    let mut hash = Sha256::new();
    hash.update(b"photocraft-shape-appearance-v1:");
    match &shape.fill {
        None => hash.update(b"fill:none;"),
        Some(fill) => {
            hash.update(b"fill:");
            hash.update(fill_signature(fill));
            hash.update(b";");
        }
    }
    match &shape.stroke {
        None => hash.update(b"stroke:none;"),
        Some(stroke) => {
            hash.update(b"stroke:");
            hash.update(format!("{};", js_number(f64::from(stroke.width))).as_bytes());
            hash.update(format!("{};", js_number(f64::from(stroke.opacity))).as_bytes());
            hash.update(format!("{:?};", stroke.align).as_bytes());
            hash.update(format!("{:?};", stroke.cap).as_bytes());
            hash.update(format!("{:?};", stroke.join).as_bytes());
            hash.update(format!("{};", js_number(f64::from(stroke.miter_limit))).as_bytes());
            for dash in &stroke.dashes {
                hash.update(format!("{},", js_number(f64::from(*dash))).as_bytes());
            }
            hash.update(b";");
            hash.update(format!("{};", js_number(f64::from(stroke.dash_offset))).as_bytes());
            hash.update(fill_signature(&stroke.paint));
        }
    }
    match &shape.live {
        None => hash.update(b"live:none"),
        Some(live) => {
            hash.update(b"live:");
            // 规范参数用 serde 的稳定文本（`LiveShape` 的 `kind` 标签 + 固定字段顺序），
            // 数值统一走 `js_number` 口径，与 TS 侧同一套取整规则。
            for value in live_numbers(live) {
                hash.update(format!("{},", js_number(value)).as_bytes());
            }
        }
    }
    hash.finalize()[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `LiveShape` 的规范参数序列（顺序固定，含种类编码）。
///
/// 种类也要参与：`Rect { radii: [0;4] }` 与在 `rect` 上调 `convertPoint` 得到的心智等价路径
/// 不是同一份可编辑参数，重开后的属性面板也不同。
fn live_numbers(live: &photocraft_doc::vector::LiveShape) -> Vec<f64> {
    use photocraft_doc::vector::LiveShape;
    match live {
        LiveShape::Rect { rect, radii } => {
            let mut out = vec![0.0];
            out.extend(rect.iter().copied());
            out.extend(radii.iter().copied());
            out
        }
        LiveShape::Ellipse { rect } => {
            let mut out = vec![1.0];
            out.extend(rect.iter().copied());
            out
        }
        LiveShape::Polygon { rect, sides, star_ratio } => {
            let mut out = vec![2.0];
            out.extend(rect.iter().copied());
            out.push(f64::from(*sides));
            out.push(*star_ratio);
            out
        }
        LiveShape::Line { from, to, weight } => {
            let mut out = vec![3.0];
            out.extend(from.iter().copied());
            out.extend(to.iter().copied());
            out.push(*weight);
            out
        }
    }
}

/// 填充的稳定签名：颜色（含透明度）或渐变/图案的全部参数。
fn fill_signature(fill: &photocraft_doc::Fill) -> Vec<u8> {
    use photocraft_doc::Fill;
    match fill {
        Fill::Solid(color) => {
            let mut out = b"solid:".to_vec();
            out.extend(color_signature(color));
            out
        }
        Fill::Gradient { stops, angle, scale, style, reverse, opacity_stops, midpoints, offset, dither, align } => {
            let mut out = format!(
                "gradient:{}:{}:{style:?}:{}:{}:{}:{}:",
                js_number(f64::from(*angle)),
                js_number(f64::from(*scale)),
                u8::from(*reverse),
                u8::from(*dither),
                u8::from(*align),
                js_number(f64::from(opacity_stops.len() as u32))
            )
            .into_bytes();
            for (location, color) in stops {
                out.extend(format!("{};", js_number(f64::from(*location))).as_bytes());
                out.extend(color_signature(color));
                out.push(b',');
            }
            out.push(b';');
            for (location, opacity) in opacity_stops {
                out.extend(format!("{};", js_number(f64::from(*location))).as_bytes());
                out.extend(format!("{};", js_number(f64::from(*opacity))).as_bytes());
            }
            for midpoint in midpoints {
                out.extend(format!("{},", js_number(f64::from(*midpoint))).as_bytes());
            }
            out.extend(
                format!(
                    ";{}:{}",
                    js_number(f64::from(offset.0)),
                    js_number(f64::from(offset.1))
                )
                .into_bytes(),
            );
            out
        }
        Fill::Pattern { name, scale, id, angle, link, phase } => format!(
            "pattern:{}:{}:{}:{}:{}:{}:{}",
            name,
            js_number(f64::from(*scale)),
            id,
            js_number(f64::from(*angle)),
            u8::from(*link),
            js_number(f64::from(phase.0)),
            js_number(f64::from(phase.1))
        )
        .into_bytes(),
    }
}

/// 颜色签名：色彩空间 + 各分量 + 透明度（固定精度，避免 8/16 位往返噪声改变指纹）。
fn color_signature(color: &photocraft_color::Color) -> Vec<u8> {
    let mut out = format!("{:?}", color.mode).into_bytes();
    for component in color.c {
        out.push(b',');
        out.extend(format!("{}", js_number(f64::from(component))).as_bytes());
    }
    out.push(b'/');
    out.extend(format!("{}", js_number(f64::from(color.alpha))).as_bytes());
    out
}

/// 与 `identity.rs` 的 `js_rounded` 同一口径的数值文本（1e-4 固定精度、`-0` 归一）。
///
/// 直接复用内容指纹的取整实现：两套取整规则迟早会在某一位上分歧，而形状外观摘要与
/// 其余内容字段必须在同一份规范文本里比较。
fn js_number(value: f64) -> String {
    crate::identity::js_rounded(value).unwrap_or_else(|| "0".to_string())
}

pub(super) fn point_coordinate(value: f64) -> [u8; 8] {
    let rounded = if value.is_finite() { (value * 1e4).round() / 1e4 } else { 0.0 };
    (rounded as i64).to_le_bytes()
}
