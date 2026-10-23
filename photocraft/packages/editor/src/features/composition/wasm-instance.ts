export type FeatureEditorInstance = {
beginCompose(id: string, paramsJson: string): string;
updateCompose(paramsJson: string): string;
commitCompose(): string;
cancelCompose(): string;
beginTransform(): void;
beginMove(paramsJson: string): boolean;
previewTransform(matrixJson: string): void;
commitTransform(): string;
cancelTransform(): void;
workflowManifestJson(): string;
runWorkflow(id: string, paramsJson: string): string;
compositionExportPlanJson(kind: string): string;
compositionExportPng(rectJson: string): Uint8Array;
};
