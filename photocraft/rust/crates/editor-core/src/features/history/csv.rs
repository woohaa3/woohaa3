//! 数据集 CSV 的唯一编解码实现（change: 2026-10-22-add-photocraft-history-automation-workflows，U76）。
//!
//! 上游 `variables_cmds` 的 CSV 入口只接受**文件路径**，浏览器里没有可用的等价物；因此本域用
//! 字节/文本为一等输入重写同一份语义，并保持三点与上游一致：
//!
//! - 首行是表头，列名 = 变量名；第一列可以留空或写 `DataSet` 表示「这一列是数据集名称」；
//! - 值按变量种类解释：显隐变量 `true/false`（也接受 `1/yes/visible/on`），文字与像素变量取原文；
//! - 逻辑记录按引号切分，引号内的逗号与换行都属于值。
//!
//! 与上游的**有意差异**（design D3：浏览器里没有本机路径）：像素替换变量的值不是磁盘路径，而是
//! 宿主提供的资源键（例如文件名或资产 id）。应用数据集时由宿主按该键交出字节；缺字节即拒绝，
//! 不会静默保留旧像素。
//!
//! 导出使用同一套规则反向生成文本，因此「导入 → 导出 → 再导入」是稳定的（回归覆盖在
//! 同目录 `tests_workflows.rs` 的 `data_set_csv_round_trips_and_reports_unknown_columns`）。

use photocraft_doc::variables::{DataSet, DataValue, Value as VarValue, VarKind};
use photocraft_doc::Variables;

/// 一行 CSV 的解析结果里，某一列被跳过的原因。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct SkippedColumn {
    /// 表头里的列名。
    pub column: String,
    /// 面向用户的原因。
    pub reason: String,
}

/// CSV 导入结果。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Parsed {
    /// 识别出的数据集（顺序与文件行序一致）。
    pub sets: Vec<DataSet>,
    /// 表头里存在、但没有对应变量定义的列。
    pub skipped: Vec<SkippedColumn>,
    /// 首列是否被当成数据集名称列。
    pub named: bool,
}

/// 按引号规则切出逻辑记录；`\r\n` 与 `\n` 都算记录分隔，引号内的换行保留。
pub fn records(text: &str) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            '\r' if !quoted => {
                if chars.peek() == Some(&'\n') {
                    let _ = chars.next();
                }
                out.push(std::mem::take(&mut current));
            }
            '\n' if !quoted => out.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// 切一行的字段：双引号包裹的字段可以含分隔符，`""` 表示一个字面引号。
pub fn split(record: &str, delimiter: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = record.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    let _ = chars.next();
                } else {
                    quoted = false;
                }
            } else {
                current.push(c);
            }
        } else if c == '"' {
            quoted = true;
        } else if c == delimiter {
            out.push(std::mem::take(&mut current));
        } else {
            current.push(c);
        }
    }
    out.push(current);
    out
}

/// 显隐值的可接受写法（与上游一致，大小写不敏感）。
fn visibility(cell: &str) -> bool {
    matches!(cell.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "visible" | "on")
}

/// 按文档里已有的变量定义解释 CSV 文本。
///
/// 空行被忽略；没有定义对应变量的列会被报告而不是静默丢弃整行。
pub fn parse(text: &str, vars: &Variables, delimiter: char) -> Parsed {
    let mut parsed = Parsed::default();
    let mut lines = records(text).into_iter().filter(|record| !record.trim().is_empty());
    let header: Vec<String> = lines.next().map(|line| split(&line, delimiter)).unwrap_or_default();
    if header.is_empty() {
        return parsed;
    }
    parsed.named = header[0].trim().is_empty() || header[0].trim().eq_ignore_ascii_case("dataset");
    let start = usize::from(parsed.named);
    for (_, column) in header.iter().enumerate().skip(start) {
        if vars.def(column.trim()).is_none() {
            parsed.skipped.push(SkippedColumn {
                column: column.clone(),
                reason: format!("没有名为 `{}` 的变量定义，这一列不会进入数据集", column.trim()),
            });
        }
    }
    for (row, record) in lines.enumerate() {
        let cells = split(&record, delimiter);
        let name = if parsed.named {
            cells.first().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).unwrap_or_else(|| format!("Data Set {}", row + 1))
        } else {
            format!("Data Set {}", row + 1)
        };
        let mut values = Vec::new();
        for (column, variable) in header.iter().enumerate().skip(start) {
            let Some(cell) = cells.get(column) else { continue };
            let Some(def) = vars.def(variable.trim()) else { continue };
            let value = match &def.kind {
                VarKind::Visibility => VarValue::Visibility(visibility(cell)),
                VarKind::TextReplacement => VarValue::Text(cell.clone()),
                // 浏览器里没有路径：这里存的是宿主资源键。
                VarKind::PixelReplacement { .. } => VarValue::Pixels(cell.clone()),
            };
            values.push(DataValue { variable: variable.trim().to_string(), value });
        }
        parsed.sets.push(DataSet { name, values });
    }
    parsed
}

/// 转义一个字段：只在必要时加引号，`"` 写成 `""`。
fn field(value: &str) -> String {
    let needs_quotes = value.contains([',', '"', '\n', '\r']) || value.trim() != value;
    if needs_quotes {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 把定义与数据集写成 CSV 文本（首列写数据集名称，表头第一格固定为 `DataSet`）。
///
/// 输出是可重复的：列序取 `defs` 顺序，行序取 `data_sets` 顺序，不带时间戳或随机量。
pub fn emit(vars: &Variables) -> String {
    let mut out = String::from("DataSet");
    for def in &vars.defs {
        out.push(',');
        out.push_str(&field(&def.name));
    }
    out.push('\n');
    for set in &vars.data_sets {
        out.push_str(&field(&set.name));
        for def in &vars.defs {
            out.push(',');
            let text = match set.get(&def.name) {
                Some(VarValue::Visibility(show)) => (if *show { "true" } else { "false" }).to_string(),
                Some(VarValue::Text(text)) => text.clone(),
                Some(VarValue::Pixels(key)) => key.clone(),
                // 缺值写成空单元：再次导入时该变量沿用文档现值（上游语义）。
                None => String::new(),
            };
            out.push_str(&field(&text));
        }
        out.push('\n');
    }
    out
}
