/**
 * 外部 clipboard adapter 受控扩展点
 * （change: add-paste-import-workflows，任务 6.1 / design D8）。
 *
 * owner-scoped registry：adapter 具有稳定 ID/priority 和 disposer，必须先做纯 `canHandle`
 * 判定，再返回**受限 semantic import plan**。adapter 不能直接写 Y.Doc、调用 fetch、接受任意
 * 远端 URL 或绕过 Media Remote / Canvas Session —— 这些由 plan validator 静态/结构保证。
 *
 * 首版只提供接口与 unknown/no-op 测试，不装配具体产品 adapter。
 */
import { isLocalPathValue } from "@woohaa3/contracts";

/** adapter 可声明的导入意图；最终仍由 importService 经受控 Media/Canvas API 落地。 */
export type SemanticImportPlan = {
  /** 计划来源标签（诊断用，不参与持久化）。 */
  source: string;
  /** 需要导入的受支持文件句柄；adapter 不能携带任意 URL 代替文件。 */
  files: readonly File[];
  /** 可选普通文本节点意图（v1 不启用）。 */
  text?: never;
};

export type ClipboardAdapterPayload = {
  /** `text/plain` 原始文本（可能为空）。 */
  text: string | null;
  /** 是否为受支持的内部节点载荷（由 dispatcher 先判定；adapter 只在未命中时调用）。 */
  internal: unknown;
  files: readonly File[];
};

export type ClipboardAdapter = {
  id: string;
  priority?: number;
  /** 纯判定：是否接受该结构化 payload。 */
  canHandle(payload: ClipboardAdapterPayload): boolean;
  /** 返回受限计划；返回 null 表示放弃（无操作）。 */
  plan(payload: ClipboardAdapterPayload): SemanticImportPlan | null;
};

const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * 校验 adapter plan 是否受限：不得携带 URL、本机路径、Yjs update 或原始字节。
 * 返回失败原因（`null` 表示合法）。
 */
export function validateSemanticImportPlan(plan: SemanticImportPlan): string | null {
  if (!plan || typeof plan !== "object") return "plan 必须是对象";
  if (typeof plan.source !== "string" || plan.source === "") return "plan.source 不能为空";
  if (!Array.isArray(plan.files)) return "plan.files 必须是数组";
  for (const file of plan.files) {
    if (!file || typeof file !== "object" || typeof (file as File).arrayBuffer !== "function") {
      return "plan.files 只能包含浏览器 File";
    }
    // File 结构里不存在 URL/路径字段；显式拒绝伪造的 url/path/data 字段。
    const record = file as unknown as Record<string, unknown>;
    for (const key of ["url", "path", "data", "src", "signedUrl"]) {
      const value = record[key];
      if (typeof value === "string" && value !== "" && isLocalPathValue(value)) {
        return `plan.files 不允许携带 ${key} 字段`;
      }
    }
  }
  return null;
}

/** owner-scoped adapter registry；重复 ID 抛错，disposer 幂等。 */
export class ClipboardAdapterRegistry {
  private readonly adapters = new Map<string, ClipboardAdapter>();

  register(adapter: ClipboardAdapter): () => void {
    if (!ADAPTER_ID_PATTERN.test(adapter.id ?? "")) {
      throw new Error(`clipboard adapter id 非法：${adapter.id}`);
    }
    if (this.adapters.has(adapter.id)) {
      throw new Error(`clipboard adapter "${adapter.id}" 已被注册`);
    }
    this.adapters.set(adapter.id, adapter);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id);
    };
  }

  /** 稳定顺序：priority 升序，再按 id。 */
  list(): ClipboardAdapter[] {
    return [...this.adapters.values()].sort((a, b) => {
      const priority = (a.priority ?? 0) - (b.priority ?? 0);
      if (priority !== 0) return priority;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /** 返回第一个接受该 payload 的 adapter 的受限计划；无命中返回 null。 */
  resolve(payload: ClipboardAdapterPayload): { adapter: ClipboardAdapter; plan: SemanticImportPlan } | null {
    for (const adapter of this.list()) {
      let accepted = false;
      try {
        accepted = adapter.canHandle(payload);
      } catch {
        accepted = false;
      }
      if (!accepted) continue;
      let plan: SemanticImportPlan | null = null;
      try {
        plan = adapter.plan(payload);
      } catch {
        plan = null;
      }
      if (!plan) continue;
      if (validateSemanticImportPlan(plan) !== null) continue;
      return { adapter, plan };
    }
    return null;
  }

  dispose(): void {
    this.adapters.clear();
  }
}
