//! 编辑内核的错误类型：每条错误带稳定 code，供 React 层直接展示与分支。

use std::fmt;

/// 编辑内核错误。`code()` 是稳定的机器可读标识，`message()` 是给用户看的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditorError {
    /// 当前没有活动文档。
    NoDocument,
    /// 图片解码/导入失败。
    ImportFailed(String),
    /// 字节不是 `.pcraft` 工程容器。
    NotAProject,
    /// 工程容器存在但无法解析。
    LoadFailed(String),
    /// 工程序列化失败。
    SaveFailed(String),
    /// 命令被拒绝或执行失败。
    CommandFailed { id: String, message: String },
    /// 命令不在首期能力清单内（菜单、快捷键与命令入口共用同一道门）。
    CapabilityDisabled(String),
    /// 合成预览失败。
    RenderFailed(String),
}

impl EditorError {
    /// 稳定的机器可读错误码。
    pub fn code(&self) -> &'static str {
        match self {
            EditorError::NoDocument => "no-document",
            EditorError::ImportFailed(_) => "import-failed",
            EditorError::NotAProject => "not-a-project",
            EditorError::LoadFailed(_) => "load-failed",
            EditorError::SaveFailed(_) => "save-failed",
            EditorError::CommandFailed { .. } => "command-failed",
            EditorError::CapabilityDisabled(_) => "capability-disabled",
            EditorError::RenderFailed(_) => "render-failed",
        }
    }

    /// 面向用户的原因文本（不含错误码前缀）。
    pub fn message(&self) -> String {
        match self {
            EditorError::NoDocument => "没有正在编辑的文档".into(),
            EditorError::ImportFailed(m) => format!("无法导入图片：{m}"),
            EditorError::NotAProject => "这不是 PhotoCraft 工程文件".into(),
            EditorError::LoadFailed(m) => format!("无法打开工程：{m}"),
            EditorError::SaveFailed(m) => format!("无法保存工程：{m}"),
            EditorError::CommandFailed { id, message } => format!("命令 {id} 被拒绝：{message}"),
            EditorError::CapabilityDisabled(id) => format!("首期未开放的功能：{id}"),
            EditorError::RenderFailed(m) => format!("无法生成预览：{m}"),
        }
    }
}

impl fmt::Display for EditorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message())
    }
}

impl std::error::Error for EditorError {}

/// 编辑内核 Result。
pub type Result<T> = std::result::Result<T, EditorError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_error_carries_a_stable_code() {
        assert_eq!(EditorError::NoDocument.code(), "no-document");
        assert_eq!(EditorError::NotAProject.code(), "not-a-project");
        assert_eq!(EditorError::CapabilityDisabled("x".into()).code(), "capability-disabled");
        assert_eq!(EditorError::CommandFailed { id: "x".into(), message: "y".into() }.code(), "command-failed");
        assert!(EditorError::ImportFailed("boom".into()).message().contains("boom"));
    }
}
