/**
 * 历史/动作/数据驱动域的视图模型与解码
 * （change: 2026-10-22-add-photocraft-history-automation-workflows）。
 *
 * 内核返回的是 JSON；这一层把**面板需要的最小结构**折叠成稳定类型，并且对任何形状异常返回
 * `null`（调用方显示可读错误），不把未校验的对象透传进 React state。解码是纯函数，可在
 * Node 里直接测试。
 */

export type HistoryEntry = { index: number; label: string; current: boolean };

/** 快照视图。`activeLayer` 是取样时的活动图层 id（不是图层数量）。 */
export type SnapshotView = { id: number; name: string; activeLayer: number | null };

/** 历史源句柄。`live` 区分「当前活文档」与「归档状态」，历史画笔取样时不能混用。 */
export type HistorySourceView = { index: number; label: string; live: boolean };

export type HistoryStateView = {
  entries: HistoryEntry[];
  redo: string[];
  current: number;
  canUndo: boolean;
  canRedo: boolean;
  snapshots: SnapshotView[];
  /** 历史源身份：清理/删除状态/回到快照都会改变它。 */
  epoch: string;
  sources: HistorySourceView[];
};

export type PurgePlanView = {
  command: string;
  scope: string;
  bytes: number;
  recoverable: false;
  /** 这个范围现在是否有内容可清（来自内核的前置条件，不是界面猜的）。 */
  available: boolean;
  /** 不可用时的原因（例如「the clipboard is empty」）。 */
  reason: string | null;
  /**
   * `bytes` 是否为**低估值**：`all` 释放的形状描边缓存没有公开字节读数，只能报「已可测部分之和」。
   * 界面据此说「约」；其余范围是精确值，说「正好」。
   */
  approximate: boolean;
};

/**
 * 历史源样本：一个历史状态的合成预览。
 *
 * `live` 区分活文档与归档状态；`epoch` 是取样时的源身份，下次取样要原样带回，让内核判定
 * 句柄是否还指向同一个状态（清理/删除状态/切快照之后不是）。
 */
export type HistorySampleView = {
  epoch: string;
  state: number;
  label: string;
  live: boolean;
  width: number;
  height: number;
  sources: number;
  /** RGBA8 预览（base64）。 */
  pixels: string;
};

/**
 * 只校验过的历史源（`preview: false`）：没有像素，只有身份与来源尺寸。
 *
 * 历史画笔落笔前只需要「这个源还能用吗」；为这句话合成一张缩略图既慢又占内存。
 */
export type HistorySourceCheckView = Omit<HistorySampleView, "pixels">;

export type ActionSummary = { name: string; steps: number; set: string | null };

/** 动作详情。`color` 是 Button Mode 色标（空串表示未设）。 */
export type ActionDetailView = {
  name: string;
  steps: ActionStep[];
  disabled: number[];
  dialogs: number[];
  color: string;
};

export type ActionStep = { id: string; params: Record<string, unknown> };

export type ActionPreflightStep = {
  step: number;
  id: string;
  enabled: boolean;
  playable: boolean;
  reason: string | null;
};

export type ActionsStateView = {
  actions: ActionSummary[];
  recording: string | null;
  detail: ActionDetailView | null;
  preflight: { steps: ActionPreflightStep[]; blocked: ActionPreflightStep[]; playable: boolean } | null;
  budget: { maxActions: number; maxStepsPerAction: number; maxAtnBytes: number } | null;
};

export type UnsupportedStep = { action: string; step: number; event: string; name: string };

export type VariableDefView = {
  name: string;
  layer: number;
  /**
   * 已知三种种类，或 `null` 表示**本客户端不认识**。
   *
   * `image.variables.define` 是整份替换：把不认识的种类猜成 `visibility` 会让「删掉另一个变量」
   * 这种无关操作把它悄悄改写成显隐变量。因此不认识的种类必须如实标成 `null`，面板据此拒绝
   * 重发整份定义（并说明原因），而不是猜一个值写回去。
   */
  kind: "visibility" | "textReplacement" | "pixelReplacement" | null;
  /** 内核报的原始种类字符串（`kind` 为 `null` 时用于提示用户）。 */
  rawKind?: string;
  /**
   * 像素替换变量的选项。`image.variables.define` 是**整份替换**，面板重发已有定义时必须带回这些
   * 值，否则会把 `fill`/`center`/`clip` 悄悄重置成默认；因此解码不能丢掉它们。
   */
  method?: string;
  align?: string;
  clip?: boolean;
};

/**
 * 一个数据集的只读视图。
 *
 * `values` 是**取值条数**（界面显示用）；`entries` 是内核原始取值（`{variable, kind, value}`）。
 * 两者都要留：`image.variables.dataSets` 是**整份替换**语义，删掉一行必须把其余行原样重发。
 * 只记条数的话重发时无法还原 `kind`/`value`，只能编造——编不出来就等于删一行连带清空别人。
 */
export type DataSetView = {
  name: string;
  values: number;
  /** 内核原样返回的取值列表；替身给非数组时为空，此时面板不提供删除。 */
  entries: Array<Record<string, unknown>>;
};

export type VariablesStateView = {
  defs: VariableDefView[];
  dataSets: DataSetView[];
  active: number | null;
  /**
   * 本域对变量/数据集的预算（内核下发）。
   *
   * 面板用它在**读取文件之前**就拒绝超预算的 CSV：`file.text()` 会把整个文件读进内存，
   * 读完了再让内核拒绝等于白读一遍。缺预算时按「不预检」处理（内核仍会拒绝）。
   */
  budget: VariablesBudgetView | null;
};

export type VariablesBudgetView = {
  maxCsvBytes: number;
  maxDataSets: number;
  maxValuesPerSet: number;
  maxVariables: number;
};

export type ExportedFile = { name: string; fileName: string; bytes: number; data: string };

export type BatchFileResult = {
  file: string;
  ok: boolean;
  error: string | null;
  output: string | null;
  bytes: number | null;
};

export type BatchProgressView = {
  mode: string | null;
  total: number;
  completed: number;
  remaining: number;
  running: boolean;
  cancelled: boolean;
  outputBytes: number;
  results: BatchFileResult[];
};

export type ScriptReportView = {
  ok: boolean;
  preflight: { steps: ActionPreflightStep[]; playable: boolean } | null;
  results: Array<{ step: number; id: string; error?: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numbers(value: unknown): number[] {
  return list(value).filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

/** 历史面板视图；缺 `entries` 视为结构非法。 */
export function decodeHistoryState(value: unknown): HistoryStateView | null {
  const source = record(value);
  if (!source || !Array.isArray(source.entries)) return null;
  const entries: HistoryEntry[] = source.entries.map((label, index) => ({
    index,
    label: string(label, `状态 ${index + 1}`),
    current: false
  }));
  const current = Math.min(number(source.current, entries.length - 1), Math.max(0, entries.length - 1));
  if (entries[current]) entries[current] = { ...entries[current], current: true };
  const snapshots: SnapshotView[] = list(source.snapshots).flatMap((raw) => {
    const snap = record(raw);
    if (!snap || typeof snap.id !== "number") return [];
    return [{
      id: snap.id,
      name: string(snap.name, `快照 ${snap.id}`),
      activeLayer: typeof snap.activeLayer === "number" ? snap.activeLayer : null
    }];
  });
  return {
    entries,
    redo: list(source.redo).map((label) => string(label)),
    current,
    canUndo: bool(source.canUndo),
    canRedo: bool(source.canRedo),
    snapshots,
    epoch: string(source.epoch),
    // `sources` 是可选的：精简宿主可能只给 entries/epoch。缺失时按 entries 推导，
    // 让消费者始终有一个「哪个是活文档」的答案，而不是全都当作活文档。
    sources: Array.isArray(source.sources)
      ? list(source.sources).flatMap((raw) => {
          const entry = record(raw);
          if (!entry || typeof entry.index !== "number") return [];
          return [{ index: entry.index, label: string(entry.label), live: bool(entry.live) }];
        })
      : entries.map((entry) => ({
          index: entry.index,
          label: entry.label,
          live: entry.index === entries.length - 1,
        }))
  };
}

/** 清理前的范围说明；`recoverable` 必须是 false（可恢复的东西不该走清理）。 */
export function decodePurgePlan(value: unknown): PurgePlanView | null {
  const source = record(value);
  if (!source) return null;
  const command = string(source.command);
  const scope = string(source.scope);
  if (!command || !scope) return null;
  if (source.recoverable !== false) return null;
  return {
    command,
    scope,
    bytes: number(source.bytes),
    recoverable: false,
    // 缺少 `available` 时按「有内容」处理：老运行时没有这个字段，而按字节数猜「空」会把
    // 真能清理的范围误禁用。相反的做法（缺字段就当不可用）会让所有范围都点不动。
    available: bool(source.available, true),
    reason: typeof source.reason === "string" ? source.reason : null,
    // 老运行时没有这个字段：按精确值处理（多数范围本来就是精确的），不把「没标」当成「低报」。
    approximate: bool(source.approximate, false)
  };
}

/**
 * 历史源样本；缺 `pixels`/`epoch` 视为结构非法。
 *
 * 这里**不**校验 base64 本身：解码失败由调用方（面板）如实报错，而不是让「结构合法但像素坏了」
 * 变成 `null`、被当成「没有返回」。
 */
export function decodeHistorySample(value: unknown): HistorySampleView | null {
  const source = record(value);
  if (!source) return null;
  const epoch = string(source.epoch);
  const pixels = typeof source.pixels === "string" ? source.pixels : "";
  if (!epoch || !pixels) return null;
  return {
    epoch,
    state: number(source.state),
    label: string(source.label),
    live: bool(source.live),
    width: Math.max(0, number(source.width)),
    height: Math.max(0, number(source.height)),
    sources: Math.max(0, number(source.sources)),
    pixels
  };
}

/**
 * 只校验句柄、不带像素的历史源检查（`preview: false`）。
 *
 * 与 [`decodeHistorySample`] 分开：这里没有 `pixels`，要求它反而会把一个合法的「源可用」
 * 答案判成结构非法。拒绝条件（过期 `epoch`、越界 `state`、缺 `epoch`）与取样完全相同。
 */
export function decodeHistorySourceCheck(value: unknown): HistorySourceCheckView | null {
  const source = record(value);
  if (!source) return null;
  const epoch = string(source.epoch);
  if (!epoch) return null;
  if (typeof source.pixels === "string") return null;
  return {
    epoch,
    state: number(source.state),
    label: string(source.label),
    live: bool(source.live),
    width: Math.max(0, number(source.width)),
    height: Math.max(0, number(source.height)),
    sources: Math.max(0, number(source.sources))
  };
}

function decodeSteps(value: unknown): ActionStep[] {
  return list(value).flatMap((raw) => {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") return [];
    const params = record(raw[1]) ?? {};
    return [{ id: raw[0], params }];
  });
}

function decodePreflight(value: unknown): ActionsStateView["preflight"] {
  const source = record(value);
  if (!source) return null;
  const steps: ActionPreflightStep[] = list(source.steps).flatMap((raw) => {
    const step = record(raw);
    if (!step) return [];
    return [{
      step: number(step.step),
      id: string(step.id),
      enabled: bool(step.enabled, true),
      playable: bool(step.playable),
      reason: typeof step.reason === "string" ? step.reason : null
    }];
  });
  const blocked = steps.filter((step) => !step.playable);
  return { steps, blocked, playable: bool(source.playable, blocked.length === 0) };
}

/** 动作面板视图；`actions` 必须存在。 */
export function decodeActionsState(value: unknown): ActionsStateView | null {
  const source = record(value);
  if (!source || !Array.isArray(source.actions)) return null;
  const actions: ActionSummary[] = source.actions.flatMap((raw) => {
    const action = record(raw);
    if (!action || typeof action.name !== "string") return [];
    return [{
      name: action.name,
      steps: number(action.steps),
      set: typeof action.set === "string" ? action.set : null
    }];
  });
  const detailSource = record(source.detail);
  const budgetSource = record(source.budget);
  return {
    actions,
    recording: typeof source.recording === "string" ? source.recording : null,
    detail: detailSource && typeof detailSource.name === "string"
      ? {
          name: detailSource.name,
          steps: decodeSteps(detailSource.steps),
          disabled: numbers(detailSource.disabled),
          dialogs: numbers(detailSource.dialogs),
          color: string(detailSource.color)
        }
      : null,
    preflight: decodePreflight(source.preflight),
    budget: budgetSource
      ? {
          maxActions: number(budgetSource.maxActions),
          maxStepsPerAction: number(budgetSource.maxStepsPerAction),
          maxAtnBytes: number(budgetSource.maxAtnBytes)
        }
      : null
  };
}

/** ATN 导入结果里的未知步骤报告（必须有；没有报告就当结构非法）。 */
export function decodeUnsupported(value: unknown): UnsupportedStep[] | null {
  const source = record(value);
  if (!source) return null;
  const raw = source.unsupported;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((item) => {
    const step = record(item);
    if (!step) return [];
    return [{
      action: string(step.action),
      step: number(step.step),
      event: string(step.event),
      name: string(step.name)
    }];
  });
}

/**
 * ATN 导入的警告（`warnings`）。
 *
 * 上游在 `.atn` 有「N 个尾部字节被忽略」这类问题时给的是**警告而不是失败**：文件能用，但内容
 * 可能少了东西。丢掉它等于宣称「完整读入」。缺字段按空数组处理（老运行时不带这个键）。
 */
export function decodeWarnings(value: unknown): string[] {
  const source = record(value);
  return list(source?.warnings).flatMap((entry) => (typeof entry === "string" ? [entry] : []));
}

/** 变量与数据集视图。 */
export function decodeVariablesState(value: unknown): VariablesStateView | null {
  const source = record(value);
  if (!source || !Array.isArray(source.defs) || !Array.isArray(source.dataSets)) return null;
  const kinds = ["visibility", "textReplacement", "pixelReplacement"] as const;
  const defs: VariableDefView[] = source.defs.flatMap((raw) => {
    const def = record(raw);
    if (!def || typeof def.name !== "string" || typeof def.layer !== "number") return [];
    // 上游把种类展平成 `{name, layer, type|kind:{type}, method?, align?, clip?}`；
    // `kind` 既可能是字符串也可能是对象，两种形状都要读。
    const kindRecord = record(def.kind);
    const kind = kindRecord?.type ?? def.type;
    // 不认识的种类**不能**猜成 `visibility`：整份替换会把它写坏。留 `null` 让面板拒绝重发。
    const resolved = kinds.find((candidate) => candidate === kind) ?? null;
    const entry: VariableDefView = { name: def.name, layer: def.layer, kind: resolved };
    if (resolved === null) entry.rawKind = typeof kind === "string" ? kind : "未知";
    if (resolved === "pixelReplacement") {
      // 重发定义时要原样带回这三个选项，否则整份替换会把它们重置为内核默认值。
      const method = kindRecord?.method ?? def.method;
      const align = kindRecord?.align ?? def.align;
      const clip = kindRecord?.clip ?? def.clip;
      if (typeof method === "string") entry.method = method;
      if (typeof align === "string") entry.align = align;
      if (typeof clip === "boolean") entry.clip = clip;
    }
    return [entry];
  });
  const dataSets: DataSetView[] = source.dataSets.flatMap((raw) => {
    const set = record(raw);
    if (!set || typeof set.name !== "string") return [];
    // 内核把 `values` 返回成 `[{variable, kind, value}, …]`；也接受直接是数字或映射的替身。
    // 数组形态要**原样保留**（整份替换语义下删除一行需要重发其余行），其余形态只数得出条数。
    const entries: Array<Record<string, unknown>> = Array.isArray(set.values)
      ? set.values.flatMap((value) => {
          const entry = record(value);
          return entry ? [entry] : [];
        })
      : [];
    const values = Array.isArray(set.values) ? set.values.length
      : typeof set.values === "number" ? set.values
        : set.values && typeof set.values === "object" ? Object.keys(set.values).length
          : 0;
    return [{ name: set.name, values, entries }];
  });
  const budgetSource = record(source.budget);
  const budget: VariablesBudgetView | null = budgetSource
    ? {
        maxCsvBytes: number(budgetSource.maxCsvBytes),
        maxDataSets: number(budgetSource.maxDataSets),
        maxValuesPerSet: number(budgetSource.maxValuesPerSet),
        maxVariables: number(budgetSource.maxVariables)
      }
    : null;
  return { defs, dataSets, active: typeof source.active === "number" ? source.active : null, budget };
}

/** CSV 导入结果：`imported`/`skipped` 由本域字节入口补充。 */
export function decodeCsvImport(value: unknown): { imported: number; skipped: Array<{ column: string; reason: string }> } | null {
  const source = record(value);
  if (!source) return null;
  if (typeof source.imported !== "number") return null;
  const skipped = list(source.skipped).flatMap((raw) => {
    const column = record(raw);
    if (!column) return [];
    return [{ column: string(column.column), reason: string(column.reason) }];
  });
  return { imported: source.imported, skipped };
}

/** 数据集导出文件清单；没有 `files` 视为结构非法。 */
export function decodeExportedFiles(value: unknown): ExportedFile[] | null {
  const source = record(value);
  if (!source || !Array.isArray(source.files)) return null;
  return source.files.flatMap((raw) => {
    const file = record(raw);
    if (!file || typeof file.fileName !== "string" || typeof file.data !== "string") return [];
    return [{ name: string(file.name), fileName: file.fileName, bytes: number(file.bytes), data: file.data }];
  });
}

/** 批处理进度（逐文件报告）。 */
export function decodeBatchProgress(value: unknown): BatchProgressView | null {
  const source = record(value);
  if (!source) return null;
  const results: BatchFileResult[] = list(source.results).flatMap((raw) => {
    const result = record(raw);
    if (!result || typeof result.file !== "string") return [];
    return [{
      file: result.file,
      ok: bool(result.ok),
      error: typeof result.error === "string" ? result.error : null,
      output: typeof result.output === "string" ? result.output : null,
      bytes: typeof result.bytes === "number" ? result.bytes : null
    }];
  });
  return {
    mode: typeof source.mode === "string" ? source.mode : null,
    total: number(source.total),
    completed: number(source.completed),
    remaining: number(source.remaining),
    running: bool(source.running),
    cancelled: bool(source.cancelled),
    outputBytes: number(source.outputBytes),
    results
  };
}

/** 脚本执行报告（`ok:false` 时 `results` 的最后一条带 `error`）。 */
export function decodeScriptReport(value: unknown): ScriptReportView | null {
  const source = record(value);
  if (!source || typeof source.ok !== "boolean") return null;
  const preflight = decodePreflight(source.preflight);
  const results = list(source.results).flatMap((raw) => {
    const result = record(raw);
    if (!result) return [];
    return [{
      step: number(result.step),
      id: string(result.id),
      ...(typeof result.error === "string" ? { error: result.error } : {})
    }];
  });
  return {
    ok: source.ok,
    preflight: preflight ? { steps: preflight.steps, playable: preflight.playable } : null,
    results
  };
}

/** 动作快捷键绑定（`actions.play:<name>` → 键位）。 */
export function decodeShortcuts(value: unknown): Array<{ action: string; shortcut: string }> {
  const source = record(value);
  if (!source) return [];
  return list(source.bindings).flatMap((raw) => {
    const binding = record(raw);
    if (!binding || typeof binding.action !== "string" || typeof binding.shortcut !== "string") return [];
    return [{ action: binding.action, shortcut: binding.shortcut }];
  });
}

/** 队列 id：`batch_begin` 的返回值；缺失时给出可读错误而不是 0。 */
export function decodeQueueId(value: unknown): number | null {
  const source = record(value);
  const id = source?.queue;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}
