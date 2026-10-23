export type FeatureEditorInstance = {
beginAdjustment(layer: number): string;
/** 图像 ▸ 调整（直接像素调整）；`layer` 省略时用活动层。 */
beginDirectAdjustment(kind: string, paramsJson: string, layer?: number): string;
/** 本域可开始的调整类型与命令（只含唯一命令门放开的条目）。 */
directAdjustmentTargetsJson(): string;
previewAdjustment(paramsJson: string): string;
commitAdjustment(): string;
cancelAdjustment(): void;
curveGeometry(pointsJson: string): string;
histogram(paramsJson: string): string;
};
