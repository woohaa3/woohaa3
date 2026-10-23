export type FeatureEditorInstance = {
beginText(paramsJson: string): string;
previewText(paramsJson: string): string;
commitText(): string;
cancelText(): void;
applyTypography(paramsJson: string): string;
checkFont(font: string): string;
/**
 * 文字域写命令（白名单与参数校验在内核）。
 *
 * 可选是**运行时协商**的一部分：`type.typography` 能力在重构基线里就已交付，能力握手无法区分
 * 「旧 WASM 没有这两个入口」和「新 WASM 有」。因此方法可缺省，入口层显式回报「内核未提供文字域
 * 入口」，而不是让界面在调用时抛 `TypeError`；匹配的新内核始终实现它。
 */
typeCommand?(id: string, paramsJson: string): string;
/** 文字域只读查询（同上，可缺省）。 */
typeQuery?(id: string, paramsJson: string): string;
};
