/**
 * 查看页操作记录（change: expand-showcase-execution-ux，任务 1.3）。
 *
 * fixture 的对外契约是「动作 payload 可观察」：`run`、`submitCommands`、参数预览、片段
 * 搜索/选择、视频编辑入口、快捷改写都会记到这里。`OperationLogPanel` 把记录序列化进度
 * 渲染（`data-testid="fixture-operations"`），Playwright 直接读文本即可。
 *
 * 记录用**不可变快照**：每次写入替换数组引用，`useSyncExternalStore` 才能察觉变化。
 *
 * 断言契约：
 * - 只记录，不执行；永不发网络、不写 Y.Doc（画布副本由 fixture 自己持有）。
 */

export const OPERATIONS = {
  RUN: "run",
  CANCEL: "cancel",
  SUBMIT_COMMANDS: "submitCommands",
  PARAMETER_PREVIEW: "parameterPreview",
  SNIPPET_SEARCH: "snippetSearch",
  SNIPPET_SELECT: "snippetSelect",
  PROMPT_SKILL: "promptSkill",
  OPEN_VIDEO_EDIT: "openVideoEditIntent",
  PANEL_PRESENTATION: "panelPresentation",
  PANEL_CLOSE: "panelClose"
} as const;

export type OperationKind = (typeof OPERATIONS)[keyof typeof OPERATIONS];

export type OperationEntry = {
  kind: OperationKind;
  payload: unknown;
};

export type OperationLog = {
  /** 当前快照（引用稳定，直到下一次写入）。 */
  entries: readonly OperationEntry[];
  record: (kind: OperationKind, payload: unknown) => void;
};

let snapshot: readonly OperationEntry[] = [];
const listeners = new Set<() => void>();

/** 记录一条操作（模块级，跨 fixture 重建仍可读）。 */
export function recordOperation(kind: OperationKind, payload: unknown): void {
  snapshot = [...snapshot, { kind, payload: serializable(payload) }];
  emit();
}

/** 当前全部记录（`useSyncExternalStore` 的 getSnapshot）。 */
export function operationEntries(): readonly OperationEntry[] {
  return snapshot;
}

export function clearOperations(): void {
  if (snapshot.length === 0) return;
  snapshot = [];
  emit();
}

export function subscribeOperations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 等价于某个 fixture 局部 log 的 `record`。 */
export function createOperationLog(): OperationLog {
  const log: OperationLog = {
    get entries() {
      return snapshot;
    },
    record: recordOperation
  };
  return log;
}

function emit(): void {
  for (const listener of listeners) listener();
}

/** 保证 payload 可 JSON 序列化（丢掉函数等非数据字段）。 */
function serializable(payload: unknown): unknown {
  try {
    return JSON.parse(
      JSON.stringify(payload, (_key, value) => (typeof value === "function" ? undefined : value))
    );
  } catch {
    return { unserializable: true };
  }
}
