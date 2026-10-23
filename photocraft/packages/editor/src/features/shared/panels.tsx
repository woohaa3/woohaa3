import type { EditorWorkspaceController } from "../../editor-workspace.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 宿主端口是否具备某能力。
 *
 * 精简宿主或测试替身可能只实现部分端口；缺少时**不渲染**对应面板（design D11：
 * 端口不可用就禁用入口，而不是让界面在调用时抛错）。
 */
export function supports<K extends string>(controller: EditorWorkspaceController, ...methods: K[]): boolean {
  const target = controller as unknown as Record<string, unknown>;
  return methods.every((method) => typeof target[method] === "function");
}

export const BW_LABELS: Record<string, string> = {
  reds: "红色",
  yellows: "黄色",
  greens: "绿色",
  cyans: "青色",
  blues: "蓝色",
  magentas: "洋红"
};

export function numberOf(params: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = params?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
