//! 逐层/按名称资产的有界命名（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
//!
//! 图层名是**用户数据**，可以包含路径分隔符、Windows 保留名、控制字符或超长文本。这里把它
//! 收敛成可交付的文件名并报告每次改写，而不是失败或静默截断：
//!
//! - 单组件（文件名）拒绝空串、`.`/`..`、控制字符、`\ : * ? " < > |` 与结尾的点/空格；
//! - Windows 设备名（`CON`、`NUL`、`COM1`…）前缀 `_`；
//! - 超过预算的 stem 按字符边界截断并标记；
//! - 重名按出现顺序追加 `-2`、`-3`…，扩展名保持在最后。
//!
//! 这里只做**名称**，不读写磁盘：包在内存里组装成 ZIP，由宿主/浏览器交付。

use std::collections::BTreeMap;

use super::budgets::budgets;

/// 一次命名改写记录（UI 用它说明「原名 → 交付名」）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rename {
    pub original: String,
    pub delivered: String,
    pub reason: &'static str,
}

fn is_windows_device(stem: &str) -> bool {
    let upper = stem.trim_end_matches([' ', '.']).to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$" | "CONIN$" | "CONOUT$")
        || upper.strip_prefix("COM").is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
        || upper.strip_prefix("LPT").is_some_and(|n| matches!(n, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"))
}

/// 清理单个路径组件；返回（清理后的组件，改写原因）。
pub fn sanitize_component(raw: &str) -> (String, Option<&'static str>) {
    let mut reason: Option<&'static str> = None;
    let mut out = String::with_capacity(raw.len());
    for character in raw.chars() {
        let replaced = character.is_control()
            || matches!(character, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
        if replaced {
            reason = Some("非法文件名字符已替换为 _");
            out.push('_');
        } else {
            out.push(character);
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        reason = Some("空名称使用默认名");
        return ("未命名".into(), reason);
    }
    if trimmed == "." || trimmed == ".." {
        reason = Some("相对路径片段已替换");
        return ("未命名".into(), reason);
    }
    // 开头的点会造出隐藏文件，或（`../x` 的残留）看起来像相对路径片段；一律去掉。
    let mut name = trimmed.to_string();
    if name.starts_with('.') {
        name = name.trim_start_matches('.').to_string();
        reason = Some("开头的点已移除");
        if name.is_empty() {
            return ("未命名".into(), Some("空名称使用默认名"));
        }
    }
    if name.ends_with('.') || name.ends_with(' ') {
        name = name.trim_end_matches([' ', '.']).to_string();
        reason = Some("结尾的点或空格已移除");
        if name.is_empty() {
            return ("未命名".into(), Some("空名称使用默认名"));
        }
    }
    if is_windows_device(&name) {
        name = format!("_{name}");
        reason = Some("Windows 保留设备名已加前缀");
    }
    (name, reason)
}

/// 把图层名拆成（stem, 扩展名）。
///
/// 只有**已知栅格扩展名**才当作输出格式；`版本1.2`、`报告.final` 这类不是格式的后缀留在
/// stem 里，使用 `fallback_extension`，避免把版本号当文件类型。
pub fn split_name(raw: &str, fallback_extension: &str) -> (String, String) {
    match raw.rsplit_once('.') {
        Some((stem, extension))
            if !stem.trim().is_empty()
                && photocraft_codecs::from_extension(extension).is_some_and(|format| format.caps().write) =>
        {
            (stem.to_string(), extension.to_ascii_lowercase())
        }
        _ => (raw.to_string(), fallback_extension.to_string()),
    }
}

/// 截断到预算内的字符长度（按字符边界，不切坏 UTF-8）。
fn clamp_chars(value: &str, max_chars: usize) -> (String, bool) {
    if value.chars().count() <= max_chars {
        return (value.to_string(), false);
    }
    let kept: String = value.chars().take(max_chars).collect();
    (kept, true)
}

/// 一次命名分配：给每个候选（stem, 扩展名）产出唯一、有界的文件名。
#[derive(Default)]
pub struct NamingPlan {
    used: BTreeMap<String, usize>,
    pub renames: Vec<Rename>,
}

impl NamingPlan {
    pub fn new() -> Self {
        Self::default()
    }

    /// 分配一个文件名；`original` 是完整原名（仅用于报告）。
    pub fn assign(&mut self, original: &str, stem: &str, extension: &str) -> String {
        let budgets = budgets();
        // 预留扩展名与去重后缀的长度，避免截断后又被追加后缀。
        let max_stem = budgets.max_file_name_length.saturating_sub(extension.chars().count() + 5).max(8);
        let (stem, truncated) = clamp_chars(stem, max_stem);
        let (mut clean, cleaned) = sanitize_component(&stem);
        if truncated {
            clean.push('~');
        }
        let mut reason = cleaned;
        if truncated {
            reason = Some("名称超出长度预算已截断");
        }
        let mut candidate = format!("{clean}.{extension}");
        if let Some(seen) = self.used.get_mut(&candidate.to_ascii_lowercase()) {
            *seen += 1;
            let suffix = *seen;
            candidate = format!("{clean}-{suffix}.{extension}");
            reason = Some("重名已追加序号");
            // 连续重名（-2 已被占用）继续递增直到唯一。
            while self.used.contains_key(&candidate.to_ascii_lowercase()) {
                let next = self.used.get(&candidate.to_ascii_lowercase()).copied().unwrap_or(1) + 1;
                self.used.insert(candidate.to_ascii_lowercase(), next);
                candidate = format!("{clean}-{next}.{extension}");
            }
        }
        self.used.insert(candidate.to_ascii_lowercase(), 1);
        if reason.is_some() || candidate != format!("{original}") {
            self.renames.push(Rename {
                original: original.to_string(),
                delivered: candidate.clone(),
                reason: reason.unwrap_or("按扩展名规范化"),
            });
        }
        candidate
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_unsafe_components_without_failing() {
        assert_eq!(sanitize_component("ok.png").0, "ok.png");
        assert_eq!(sanitize_component("a/b").0, "a_b");
        assert_eq!(sanitize_component("C:\\x").0, "C__x");
        assert_eq!(sanitize_component("nul").0, "_nul");
        assert_eq!(sanitize_component("..").0, "未命名");
        assert_eq!(sanitize_component("trail.").0, "trail");
        assert_eq!(sanitize_component("   ").0, "未命名");
        assert!(sanitize_component("bad:name").1.is_some());
    }

    #[test]
    fn assigns_unique_bounded_names_and_reports_every_rename() {
        let mut plan = NamingPlan::new();
        assert_eq!(plan.assign("图层.png", "图层", "png"), "图层.png");
        assert_eq!(plan.assign("图层.png", "图层", "png"), "图层-2.png");
        assert_eq!(plan.assign("图层.png", "图层", "png"), "图层-3.png");
        assert!(plan.renames.iter().all(|rename| rename.reason == "重名已追加序号"));
        let long = "很长的名字".repeat(40);
        let assigned = plan.assign(&long, &long, "png");
        assert!(assigned.chars().count() <= budgets().max_file_name_length);
        assert!(assigned.ends_with(".png"));
        assert!(plan.renames.iter().any(|rename| rename.reason.contains("截断")));
    }

    #[test]
    fn name_parts_keep_a_bounded_extension_or_fall_back() {
        assert_eq!(split_name("图标.png", "png"), ("图标".into(), "png".into()));
        assert_eq!(split_name("图标", "png"), ("图标".into(), "png".into()));
        // 不是已知可写栅格格式的后缀留在 stem 里，不当成文件类型。
        assert_eq!(split_name("版本1.2", "png"), ("版本1.2".into(), "png".into()));
        assert_eq!(split_name("报告.final", "png"), ("报告.final".into(), "png".into()));
        assert_eq!(split_name("photo.JPG", "png"), ("photo".into(), "jpg".into()));
    }
}
