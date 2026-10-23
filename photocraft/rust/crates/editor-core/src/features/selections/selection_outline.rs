//! 从内核选区掩码提取边界；不依赖 UI，不合成图片。
use photocraft_raster::Surface;

/// 文档像素坐标中的线段 [x0, y0, x1, y1]。
/// 大选区按有界网格采样，保留孔洞与分离区域，不把任意选区显示成外接矩形。
pub(crate) fn selection_outline(mask: &Surface) -> Vec<[i32; 4]> {
    let bounds = mask.content_bounds();
    if bounds.is_empty() {
        return Vec::new();
    }
    let width = i64::from(bounds.x1) - i64::from(bounds.x0);
    let height = i64::from(bounds.y1) - i64::from(bounds.y0);
    let mut step = 1_i64;
    while ((width + step - 1) / step) * ((height + step - 1) / step) > 262_144 {
        step *= 2;
    }
    let w = ((width + step - 1) / step) as usize;
    let h = ((height + step - 1) / step) as usize;
    let x = |i: usize| (i64::from(bounds.x0) + i as i64 * step).min(i64::from(bounds.x1)) as i32;
    let y = |i: usize| (i64::from(bounds.y0) + i as i64 * step).min(i64::from(bounds.y1)) as i32;
    let mut grid = vec![false; w * h];
    for row in 0..h {
        let py = (i64::from(y(row)) + step / 2).min(i64::from(bounds.y1) - 1) as i32;
        let mut values = vec![0.0; w];
        // 最后一列可能不足 step，单独钳制，避免漏掉细选区。
        mask.sample_row_strided(py, x(0).saturating_add((step / 2) as i32), step as i32, 0, &mut values);
        for col in 0..w {
            let px = (i64::from(x(col)) + step / 2).min(i64::from(bounds.x1) - 1) as i32;
            grid[row * w + col] = if col == w - 1 { mask.sample_channel(px, py, 0) } else { values[col] } > 0.5;
        }
    }
    let inside = |col: usize, row: usize| grid[row * w + col];
    let mut segments = Vec::new();
    for row in 0..=h {
        let mut start = None;
        for col in 0..=w {
            let edge = col < w && ((row > 0 && inside(col, row - 1)) != (row < h && inside(col, row)));
            match (edge, start) {
                (true, None) => start = Some(col),
                (false, Some(first)) => {
                    segments.push([x(first), y(row), x(col), y(row)]);
                    start = None;
                }
                _ => {}
            }
        }
    }
    for col in 0..=w {
        let mut start = None;
        for row in 0..=h {
            let edge = row < h && ((col > 0 && inside(col - 1, row)) != (col < w && inside(col, row)));
            match (edge, start) {
                (true, None) => start = Some(row),
                (false, Some(first)) => {
                    segments.push([x(col), y(first), x(col), y(row)]);
                    start = None;
                }
                _ => {}
            }
        }
    }
    segments
}
