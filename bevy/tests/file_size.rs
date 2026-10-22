//! 文件体积守卫（change: refactor-bevy-rust-file-size，任务 1.3 / design D4）。
//!
//! 遍历 `bevy/src`、`bevy/tests`、`bevy/examples` 下的全部 `.rs`（含源码、测试与
//! 示例），按**物理行**计数，任何超过 800 行的文件都会让测试失败并逐一列出。
//!
//! 这是导航与可评审性护栏，不是复杂度指标：注释、空行、生成代码与测试代码都计入。
//! 计数与 `wc -l` 在换行结尾的文件上一致；末尾未换行的一行按 design D4 计为一行。

use std::fs;
use std::path::{Path, PathBuf};

/// 单文件物理行上限（含注释、空行与测试）。
const MAX_PHYSICAL_LINES: usize = 800;

/// 需要守卫的根目录（相对 crate 根）。当前不存在的目录会被跳过。
const SCOPED_ROOTS: [&str; 3] = ["src", "tests", "examples"];

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// 物理行数：换行数 + （末尾未换行且非空时再加一行）。
///
/// 对换行结尾的文件等价于 `wc -l`；对末尾未换行的文件，按 design D4 把最后一行也计入。
fn physical_lines(source: &str) -> usize {
    source.lines().count()
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // 目录不存在（例如当前仓库没有 examples）：跳过而不报错。
        Err(_) => return,
    };
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs(&path, out);
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn scoped_rust_files_stay_within_physical_line_cap() {
    let root = crate_root();
    let mut files = Vec::new();
    for scoped in SCOPED_ROOTS {
        collect_rs(&root.join(scoped), &mut files);
    }
    files.sort();
    files.dedup();

    // 守卫必须真的扫描到源文件，避免路径写错时“空集通过”。
    assert!(
        !files.is_empty(),
        "未找到任何被守卫的 .rs 文件，请检查 SCOPED_ROOTS 与 crate 根 {}",
        root.display()
    );

    let mut violations = Vec::new();
    for file in &files {
        let source = fs::read_to_string(file)
            .unwrap_or_else(|error| panic!("无法读取 {}: {error}", file.display()));
        let lines = physical_lines(&source);
        if lines > MAX_PHYSICAL_LINES {
            let relative = file.strip_prefix(&root).unwrap_or(file);
            violations.push(format!("  {}: {lines} 行", relative.display()));
        }
    }

    assert!(
        violations.is_empty(),
        "以下 Rust 文件超过 {MAX_PHYSICAL_LINES} 物理行上限（共 {} 个）：\n{}",
        violations.len(),
        violations.join("\n")
    );
}

#[cfg(test)]
mod self_check {
    use super::physical_lines;

    /// 计数规则：换行结尾 == 换行数；末尾未换行也计一行；空文件为 0。
    #[test]
    fn physical_line_counting_matches_design_rule() {
        assert_eq!(physical_lines(""), 0);
        assert_eq!(physical_lines("a\n"), 1);
        assert_eq!(physical_lines("a\nb\n"), 2);
        assert_eq!(physical_lines("a\nb"), 2);
        assert_eq!(physical_lines("\n"), 1);
    }
}
