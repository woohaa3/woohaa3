//! 修饰域的有界内容核验（change: 2026-10-22-add-photocraft-retouch-workflows）。
//!
//! 修饰工具**不新增持久内容类型**，因此本域没有自己的内容分支要遍历：
//! - 修补／内容识别移动／移除／红眼只改写既有像素层，落笔后就是普通像素；
//! - 图案图章落笔后也是普通像素；它引用的图案资源归 layers 域的唯一表示
//!   （`pattern_support::supported` / `supported_manifest`，已由共享遍历调用）；
//! - 历史画笔只**读取**既有历史栈，历史不进工程；
//! - 减淡/加深的范围与曝光、海绵的增/减饱和、涂抹强度、多仿制源槽位与叠加选项都是会话工具
//!   状态，不进内容指纹、不写工程，因此也不属于核验内容。
//!
//! 这里返回 `None` 表示「本域不认领这个图层内容」，由其他域接手；**不能**用
//! `Some(Ok(()))` 放行，否则共享遍历会把本域当成像素/文字/形状的通用放行者，让未知对象
//! 绕过校验。像素层的格式/尺寸边界由既有共享核验负责，本域不复制第二份预算。
use super::*;

pub(super) fn inspect(
    _layer: &photocraft_doc::Layer,
    _depth: usize,
    _out: &mut LayerInspection,
    _embedded_smart: bool,
) -> Option<Result<(), VerifyError>> {
    None
}
