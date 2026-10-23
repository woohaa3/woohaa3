export type FeatureEditorInstance = {
vectorCommand(id: string, paramsJson: string): string;
vectorSnapshotJson(): string;
vectorPresetsJson(): string;
vectorDrawParamsJson(inputJson: string): string;
};
