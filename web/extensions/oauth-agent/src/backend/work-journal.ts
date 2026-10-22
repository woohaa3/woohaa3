/**
 * ChatGPT authoring 工作的 durable 日志
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 4.1/4.2/4.4/4.6 / design D6/D7）。
 *
 * 在**推理开始前**持久化受理意图，绑定 plugin/owner(哈希)/授权 epoch/requestId/输入身份/目标；
 * 推理与提交的进展、回执与终态落到同一文件。这样：
 * - 崩溃/重启后可核对「是否已 durable commit」，而不是丢掉事实；
 * - 无法证明外部推理是否已收费或完成的工作进入 `outcome-unknown`，**绝不自动重新推理**；
 * - 只有确定未执行的受理工作（admitted，未 started）才允许在恢复时继续。
 *
 * 日志与加密凭据同目录（0700）；不保存 token；失败时保存 LLM 回复供用户检查。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export type ChatGptWorkState =
  | "admitted"
  | "running"
  | "committed"
  | "partial"
  | "failed"
  | "cancelled"
  /** 已开始但无法证明结果；禁止自动重推理。 */
  | "outcome-unknown";

export type ChatGptWorkRecord = {
  workId: string;
  requestId: string;
  /** owner 摘要（不保存原始 owner）。 */
  ownerHash: string;
  /** 授权 epoch；断开/重新绑定后改变，旧在途工作据此失效。 */
  authEpoch: number;
  /** 输入身份（canvas/node/mode/model/prompt/hash 的稳定摘要）。 */
  inputIdentity: string;
  canvasId: string;
  nodeId: string;
  clipId?: string;
  itemId?: string;
  mode: string;
  state: ChatGptWorkState;
  /** 已提交时的权威命令 id / revision。 */
  commandId?: string;
  revision?: number;
  /** 失败/部分完成的安全摘要。 */
  code?: string;
  message?: string;
  llmOutput?: string;
  /** 已应用/未完成的工具名（partial）。 */
  applied?: string[];
  failed?: Array<{ part: string; code: string; message: string }>;
  createdAt: string;
  updatedAt: string;
};

export type ChatGptWorkJournal = {
  /** 新建受理意图（admitted）。 */
  admit: (input: {
    requestId: string;
    ownerId: string;
    authEpoch: number;
    inputIdentity: string;
    canvasId: string;
    nodeId: string;
    clipId?: string;
    itemId?: string;
    mode: string;
  }) => ChatGptWorkRecord;
  /** 幂等更新状态与回执字段。 */
  update: (workId: string, patch: Partial<ChatGptWorkRecord>) => void;
  /** 按 requestId + owner 读取（重连/恢复用）。 */
  find: (requestId: string, ownerId: string) => ChatGptWorkRecord | undefined;
  /** 启动恢复：把上次进程遗留的 admitted/running 记录标记为 outcome-unknown。 */
  recoverInterrupted: () => ChatGptWorkRecord[];
  list: (ownerId?: string) => ChatGptWorkRecord[];
  /** 当前授权 epoch（进程初始化时由部署注入；断开/重绑时 +1）。 */
  authEpoch: () => number;
  bumpAuthEpoch: () => number;
  close: () => void;
};

const JOURNAL_VERSION = 1;
const MAX_RECORDS = 500;

function ownerDigest(ownerId: string): string {
  return createHash("sha256").update(ownerId, "utf8").digest("hex");
}

type JournalFile = { version: number; authEpoch: number; records: ChatGptWorkRecord[] };

export type ChatGptWorkJournalOptions = {
  /** durable 目录（与凭据同目录；缺省不持久化，仅进程内——仅用于测试）。 */
  directory?: string;
  now?: () => Date;
  logger?: (event: Record<string, unknown>) => void;
};

export function createChatGptWorkJournal(options: ChatGptWorkJournalOptions = {}): ChatGptWorkJournal {
  const now = options.now ?? (() => new Date());
  const log = options.logger ?? (() => undefined);
  const filePath = options.directory ? path.join(options.directory, "work-journal.json") : null;

  const records = new Map<string, ChatGptWorkRecord>();
  let authEpoch = 0;

  const persist = (): void => {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* 忽略不支持的文件系统 */
    }
    const payload: JournalFile = { version: JOURNAL_VERSION, authEpoch, records: [...records.values()] };
    const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  };

  // 载入既有日志（存在且可解析时）；损坏时按空处理，不阻断启动。
  if (filePath && fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as JournalFile;
      if (parsed && parsed.version === JOURNAL_VERSION && Array.isArray(parsed.records)) {
        authEpoch = typeof parsed.authEpoch === "number" ? parsed.authEpoch : 0;
        for (const record of parsed.records) records.set(record.workId, record);
      }
    } catch {
      log({ event: "chatgpt-work-journal-corrupt" });
    }
  }

  const trim = (): void => {
    if (records.size <= MAX_RECORDS) return;
    const sorted = [...records.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    for (const record of sorted.slice(0, records.size - MAX_RECORDS)) records.delete(record.workId);
  };

  return {
    admit(input) {
      const timestamp = now().toISOString();
      const record: ChatGptWorkRecord = {
        workId: `chatgpt-work-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
        requestId: input.requestId,
        ownerHash: ownerDigest(input.ownerId),
        authEpoch: input.authEpoch,
        inputIdentity: input.inputIdentity,
        canvasId: input.canvasId,
        nodeId: input.nodeId,
        clipId: input.clipId,
        itemId: input.itemId,
        mode: input.mode,
        state: "admitted",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      records.set(record.workId, record);
      trim();
      persist();
      return record;
    },
    update(workId, patch) {
      const current = records.get(workId);
      if (!current) return;
      const next: ChatGptWorkRecord = { ...current, ...patch, workId, updatedAt: now().toISOString() };
      records.set(workId, next);
      persist();
    },
    find(requestId, ownerId) {
      const digest = ownerDigest(ownerId);
      return [...records.values()].find((record) => record.requestId === requestId && record.ownerHash === digest);
    },
    recoverInterrupted() {
      const interrupted: ChatGptWorkRecord[] = [];
      for (const record of records.values()) {
        if (record.state !== "admitted" && record.state !== "running") continue;
        const next: ChatGptWorkRecord = {
          ...record,
          state: "outcome-unknown",
          message: "进程中断；无法证明外部推理是否已完成，禁止自动重新推理。",
          updatedAt: now().toISOString()
        };
        records.set(record.workId, next);
        interrupted.push(next);
      }
      if (interrupted.length > 0) {
        persist();
        log({ event: "chatgpt-work-outcome-unknown", count: interrupted.length });
      }
      return interrupted;
    },
    list(ownerId) {
      const all = [...records.values()];
      if (!ownerId) return all;
      const digest = ownerDigest(ownerId);
      return all.filter((record) => record.ownerHash === digest);
    },
    authEpoch: () => authEpoch,
    bumpAuthEpoch: () => {
      authEpoch += 1;
      persist();
      return authEpoch;
    },
    close: () => {
      /* 无打开句柄；保留供对称释放。 */
    }
  };
}
