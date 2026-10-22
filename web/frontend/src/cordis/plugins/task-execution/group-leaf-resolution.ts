/**
 * group 叶子展开与目录模型身份解析（change: add-canvas-node-grouping，任务 3.3；
 * change: 2026-10-16-add-group-selection-toolbar，任务 1.1：旧的 `createBatchRunner` /
 * `resolveGroupRunLeaves` 近似过滤已删除，分组提交统一走 `GroupRunService` + `leaf-run-precheck`）。
 *
 * 保留的只是两件**唯一**的共享纯函数：
 * - `collectGroupLeafDescendants`：按 `parentId` 递归展开非 group 后代（成员关系唯一事实源）；
 * - `resolveCatalogModelKey`：显式模型选择在目录里合法时生效，否则回落到该 model type 的默认/
 *   首个模型（与执行面板同一语义，避免各入口各写一套回落）。
 *
 * 本模块不读草稿、不做可执行性判定、不发请求——那是 `resolveLeafRunPrecheck` 的职责。
 */
import type { CanvasTaskCatalog, CanvasTaskModelType } from "@woohaa3/contracts";

/**
 * 递归展开 group 的非 group 后代（change: add-canvas-node-grouping，任务 3.3）。
 *
 * `parentId` 是成员关系的唯一事实源；本函数不读 nodeData。
 */
export function collectGroupLeafDescendants(
  nodes: readonly { id: string; type: string; parentId?: string }[],
  groupNodeId: string
): string[] {
  const childrenByParent = new Map<string, Array<{ id: string; type: string }>>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push({ id: node.id, type: node.type });
    childrenByParent.set(node.parentId, list);
  }
  const leaves: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const child of childrenByParent.get(id) ?? []) {
      if (child.type === "group") visit(child.id);
      else leaves.push(child.id);
    }
  };
  visit(groupNodeId);
  return leaves;
}

/** catalog 模型的稳定身份（opaque modelKey）。 */
export function catalogModelIdentity(model: { modelKey: string }): string {
  return model.modelKey;
}

/**
 * 解析某面板 kind 最终使用的模型身份。
 *
 * 与 `ExecutionPanel` 的语义一致：显式选择只有在目录里是合法选项时才生效，否则回落到
 * `catalog.defaultModels[kind]`（合法时）或该 kind 的第一个模型。目录不可用时原样退回显式值。
 */
export function resolveCatalogModelKey(
  catalog: CanvasTaskCatalog,
  modelType: CanvasTaskModelType,
  candidate: string
): string {
  if (!catalog.available) return candidate;
  const options = catalog.models.filter((model) => model.modelType === modelType);
  if (options.some((model) => catalogModelIdentity(model) === candidate)) return candidate;
  const configured = catalog.defaultModels?.[modelType];
  if (configured && options.some((model) => catalogModelIdentity(model) === configured)) {
    return configured;
  }
  return options[0] ? catalogModelIdentity(options[0]) : "";
}
