/**
 * `model-pipeline.mjs` 的类型声明。
 *
 * 实现在 `model-pipeline.mjs`：构建期脚本（`generate-models.mjs`）与运行期刷新
 * （`src/discovery.ts`）共用同一份规则。这里只补形状，不改行为。
 */

/** 上游端点级条目（官方 registry 的 `models[]` 与 `scripts/upstream/*.json` 同形）。 */
export type RunningHubEndpointEntry = {
  endpoint: string;
  output_type: "image" | "video" | string;
  name_cn?: string;
  display_name?: string;
  params?: readonly unknown[];
};

/** 由端点条目合并出来的逻辑模型（`data/models.json` 的一条）。 */
export type RunningHubPipelineModel = {
  id: string;
  family: string;
  outputType: "image" | "video";
  label: string;
  promptRequirement: "required" | "optional";
  cancel: "unsupported";
  routes: readonly unknown[];
  inputSchema: Record<string, unknown>;
  defaultInput: Record<string, unknown>;
};

export declare function familyOf(endpoint: string): string | null;

export declare function logicalModelsOf(entries: readonly RunningHubEndpointEntry[]): RunningHubPipelineModel[];

export declare function mergeWithBase(
  models: readonly RunningHubPipelineModel[],
  base: readonly RunningHubPipelineModel[]
): { models: RunningHubPipelineModel[]; preserved: RunningHubPipelineModel[] };

export declare const IGNORED_MEDIA_FIELDS: ReadonlySet<string>;
