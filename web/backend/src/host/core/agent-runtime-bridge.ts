/**
 * 宿主依赖桥（change: 2026-11-07-add-pluggable-agent-roles；
 * 跨宿主重启授权 change: 2026-11-10-split-agent-runtime-lifecycle，任务 2.3）。
 *
 * daemon 里的执行器没有宿主的连接、工具授权和画布/媒体权限；每次回合通过本机 socket 回调
 * 这几个**受控方法**。桥只监听本机、带 workspace token，方法白名单固定。
 *
 * 跨宿主重启：
 * - 桥 token 与 HMAC host key 持久化在运行时目录（`0600`），新宿主继续接受旧 daemon；
 * - 回合 lease 是 `HMAC(claims)` 签名 token，不只是进程内 Map 的随机 id；
 * - 新宿主校验签名后按持久 turn authority（owner、连接版本、撤销/过期、方法白名单）授权，
 *   再通过 `onAdopt` 重建该回合的处理器；伪造、过期、越权在调用处理器前拒绝。
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { ApplicationToolDelegationFacade, ServerCanvas } from "@woohaa3/contracts";

/** 桥身份快照：token 与 HMAC key 在同一 workspace 内跨宿主重启复用。 */
export type BridgeIdentity = {
  schemaVersion: 1;
  token: string;
  key: string;
  socketPath: string;
};

/** 回合 lease 的签名载荷。 */
export type HostLeaseClaims = {
  v: 1;
  turnId: string;
  requestId: string;
  owner: string;
  /** 允许通过 `extension.call` 调用的方法白名单。 */
  methods: readonly string[];
  /** epoch ms；`0` 表示沿用回合边界（authority 的过期/撤销仍生效）。 */
  exp: number;
};

/** 与 application store 的 turn authority 对齐的最小只读形状。 */
export type BridgeTurnAuthority = {
  turnId: string;
  requestId: string;
  owner: string;
  canvasId: string;
  hostMethods: readonly string[];
  toolScope?: readonly string[];
  configRevision?: number | null;
  credentialEpoch?: number | null;
  expiresAt?: number | null;
  revokedAt?: string | null;
};

export type AgentRuntimeBridgeOptions = {
  socketPath: string;
  token: string;
  workspaceKey: string;
  /** 运行时目录（桥身份 `host-bridge.json` 与 host key 的位置）；缺省取 socket 所在目录。 */
  runtimeDir?: string;
  tools: ApplicationToolDelegationFacade;
  canvasRead(input: { subject: string; canvasId: string }): Promise<ServerCanvas>;
  mediaRead(input: { storageKey: string; canvasId: string }): Promise<{ bytes: Uint8Array; contentType: string }>;
  now?: () => number;
  logger?: (event: Record<string, unknown>) => void;
};

export type AgentRuntimeBridge = {
  socketPath: string;
  token: string;
  registerCall(handler: (method: string, params: unknown) => Promise<unknown>, claims?: Omit<HostLeaseClaims, "v">): { leaseId: string; release(): void };
  /** 持久 turn authority 的读取端口（新宿主导入应用库）。 */
  setTurnAuthority(reader: ((turnId: string) => BridgeTurnAuthority | null) | null): void;
  /**
   * 按 (owner, requestId) 读取同一份持久授权。
   *
   * 执行器侧的 turnId 是它自己派生的稳定键（`sha256(extensionId, executor, owner, requestId)`），
   * 与会话账本的 `turn-…` 不是同一个 id；lease 里两种身份都在，用 requestId 回退到同一份授权。
   */
  setTurnAuthorityByRequest(reader: ((owner: string, requestId: string) => BridgeTurnAuthority | null) | null): void;
  /** 新宿主接管：按 turnId 重建处理器；成功后才能继续服务旧 lease。 */
  setAdoptionHandler(handler: ((turnId: string) => Promise<boolean>) | null): void;
  /** 记录通道声明的方法白名单（写入持久回合授权）。 */
  setLeaseRecorder(recorder: ((turnId: string, methods: readonly string[]) => void) | null): void;
  close(): Promise<void>;
};

const BRIDGE_IDENTITY_FILE = "host-bridge.json";

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function hostLeaseToken(key: string, claims: HostLeaseClaims): string {
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac("sha256", key).update(payload).digest("base64url");
  return `hl1.${payload}.${signature}`;
}

export function verifyHostLease(key: string, token: string, now: number): { ok: true; claims: HostLeaseClaims } | { ok: false; reason: string } {
  const [version, payload, signature] = token.split(".");
  if (version !== "hl1" || !payload || !signature) return { ok: false, reason: "malformed-lease" };
  const expected = createHmac("sha256", key).update(payload).digest("base64url");
  const left = Buffer.from(expected);
  const right = Buffer.from(signature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { ok: false, reason: "invalid-signature" };
  let claims: HostLeaseClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HostLeaseClaims;
  } catch {
    return { ok: false, reason: "malformed-lease" };
  }
  if (claims.v !== 1 || typeof claims.turnId !== "string" || typeof claims.owner !== "string" || !Array.isArray(claims.methods)) {
    return { ok: false, reason: "malformed-lease" };
  }
  if (claims.exp > 0 && claims.exp <= now) return { ok: false, reason: "expired-lease" };
  return { ok: true, claims };
}

function readBridgeIdentity(runtimeDir: string, socketPath: string): BridgeIdentity | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(runtimeDir, BRIDGE_IDENTITY_FILE), "utf8")) as Partial<BridgeIdentity>;
    if (parsed.schemaVersion !== 1 || typeof parsed.token !== "string" || typeof parsed.key !== "string" || typeof parsed.socketPath !== "string") return null;
    // 端点变化（例如升级后路径调整）时重新签发身份；token/key 仍可保留。
    if (parsed.socketPath !== socketPath) return null;
    return parsed as BridgeIdentity;
  } catch {
    return null;
  }
}

function writeBridgeIdentity(runtimeDir: string, identity: BridgeIdentity): void {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const target = path.join(runtimeDir, BRIDGE_IDENTITY_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(identity), { mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
  if (process.platform !== "win32") fs.chmodSync(target, 0o600);
}

function reply(socket: net.Socket, id: number, result: unknown, error?: unknown): void {
  if (socket.destroyed) return;
  const message = error instanceof Error ? error.message : error === undefined ? undefined : String(error);
  socket.write(`${JSON.stringify(error ? { id, ok: false, error: message } : { id, ok: true, result })}\n`);
}

export async function createAgentRuntimeBridge(options: AgentRuntimeBridgeOptions): Promise<AgentRuntimeBridge> {
  const calls = new Map<string, (method: string, params: unknown) => Promise<unknown>>();
  const byTurn = new Map<string, (method: string, params: unknown) => Promise<unknown>>();
  const log = options.logger ?? (() => undefined);
  const now = options.now ?? (() => Date.now());
  const runtimeDir = options.runtimeDir ?? path.dirname(options.socketPath);
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });

  // 身份跨宿主重启复用：旧 daemon 仍带着上一进程签发的桥 token/key。
  const stored = readBridgeIdentity(runtimeDir, options.socketPath);
  const identity: BridgeIdentity = stored ?? {
    schemaVersion: 1,
    token: options.token,
    key: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
    socketPath: options.socketPath
  };
  writeBridgeIdentity(runtimeDir, identity);
  const bridgeToken = identity.token;
  let authorityFor: ((turnId: string) => BridgeTurnAuthority | null) | null = null;
  let authorityByRequest: ((owner: string, requestId: string) => BridgeTurnAuthority | null) | null = null;
  let onAdopt: ((turnId: string) => Promise<boolean>) | null = null;
  let leaseRecorder: ((turnId: string, methods: readonly string[]) => void) | null = null;

  if (process.platform !== "win32") {
    try { fs.unlinkSync(options.socketPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  /** lease 上的回合身份可能是执行器派生键；两种身份都能解析到同一份持久授权。 */
  const authorityOf = (claims: HostLeaseClaims): BridgeTurnAuthority | null =>
    authorityFor?.(claims.turnId) ?? authorityByRequest?.(claims.owner, claims.requestId) ?? null;
  /** 会话账本里的规范 turnId（接管与授权记账都用它）。 */
  const canonicalTurnId = (claims: HostLeaseClaims): string => authorityOf(claims)?.turnId ?? claims.turnId;

  /** 签名/过期/authority 校验；返回可继续调用的方法白名单。 */
  const authorizeLease = (token: string, method: string): HostLeaseClaims => {
    const verified = verifyHostLease(identity.key, token, now());
    if (!verified.ok) throw new Error(`Executor host lease rejected (${verified.reason})`);
    const claims = verified.claims;
    const authority = authorityOf(claims);
    if ((authorityFor || authorityByRequest) && !authority) throw new Error("Executor host lease has no persisted turn authority");
    if (authority) {
      if (authority.owner !== claims.owner || authority.requestId !== claims.requestId) throw new Error("Executor host lease owner mismatch");
      if (authority.revokedAt) throw new Error("Executor turn authority is revoked");
      if (authority.expiresAt !== null && authority.expiresAt !== undefined && authority.expiresAt <= now()) throw new Error("Executor turn authority has expired");
      const allowed = claims.methods.length > 0 ? claims.methods : authority.hostMethods;
      if (allowed.length > 0 && !allowed.includes(method)) throw new Error(`Executor host method not allowed: ${method}`);
      if (authority.hostMethods.length > 0 && !authority.hostMethods.includes(method)) throw new Error(`Executor host method not allowed: ${method}`);
    } else if (claims.methods.length > 0 && !claims.methods.includes(method)) {
      throw new Error(`Executor host method not allowed: ${method}`);
    }
    return claims;
  };

  const dispatch = async (request: { id: number; token?: string; workspaceKey?: string; method?: string; params?: unknown }): Promise<unknown> => {
    if (request.token !== bridgeToken || request.workspaceKey !== options.workspaceKey) throw new Error("Host bridge 身份校验失败");
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.method) {
      case "extension.call": {
        const leaseId = String(params.leaseId ?? "");
        const method = String(params.method ?? "");
        const handler = calls.get(leaseId);
        if (handler) {
          // 同宿主快路径：闭包仍执行自己的权限检查；签名 token 也先校验，避免伪造 id。
          if (leaseId.startsWith("hl1.")) authorizeLease(leaseId, method);
          return handler(method, params.params);
        }
        const claims = authorizeLease(leaseId, method);
        if (!authorityFor && !authorityByRequest) throw new Error("Executor host lease is unavailable");
        if (!onAdopt) throw new Error("Executor host lease is unavailable");
        const turnId = canonicalTurnId(claims);
        const adopted = await onAdopt(turnId);
        const rebuilt = byTurn.get(turnId);
        if (!adopted || !rebuilt) throw new Error("Executor host lease could not be re-established");
        return rebuilt(method, params.params);
      }
      case "tools.issue":
        return options.tools.issue(params as never);
      case "tools.revoke":
        options.tools.revoke(String(params.workId ?? ""), { subject: String(params.subject ?? ""), authLevel: "authenticated" });
        return { revoked: true };
      case "tools.authorize":
        return options.tools.authorize(params as never);
      case "canvas.read":
        return options.canvasRead({ subject: String(params.subject ?? ""), canvasId: String(params.canvasId ?? "") });
      case "media.read": {
        const media = await options.mediaRead({ storageKey: String(params.storageKey ?? ""), canvasId: String(params.canvasId ?? "") });
        return { bytes: Buffer.from(media.bytes).toString("base64"), contentType: media.contentType };
      }
      default:
        throw new Error(`未知 Host bridge 方法：${String(request.method)}`);
    }
  };

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let request: { id: number; token?: string; workspaceKey?: string; method?: string; params?: unknown };
        try { request = JSON.parse(line) as typeof request; } catch { continue; }
        void dispatch(request).then(
          (result) => reply(socket, request.id, result),
          (error) => reply(socket, request.id, undefined, error)
        );
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  if (process.platform !== "win32") {
    try { fs.chmodSync(options.socketPath, 0o600); } catch { /* best effort */ }
  }
  log({ event: "agent-runtime-bridge-started", socketPath: options.socketPath, reusedIdentity: stored !== null });
  return {
    socketPath: options.socketPath,
    token: bridgeToken,
    registerCall(handler, claims) {
      const leaseId = claims ? hostLeaseToken(identity.key, { v: 1, ...claims }) : randomUUID();
      calls.set(leaseId, handler);
      // 授权与接管都按会话账本的规范 turnId 记账，而不是执行器派生键。
      const turnId = claims ? canonicalTurnId({ v: 1, ...claims }) : undefined;
      if (turnId) {
        byTurn.set(turnId, handler);
        if (claims!.methods.length > 0) leaseRecorder?.(turnId, claims!.methods);
      }
      let released = false;
      return {
        leaseId,
        release: () => {
          if (released) return;
          released = true;
          calls.delete(leaseId);
          if (turnId && byTurn.get(turnId) === handler) byTurn.delete(turnId);
        }
      };
    },
    setTurnAuthority(reader) { authorityFor = reader; },
    setTurnAuthorityByRequest(reader) { authorityByRequest = reader; },
    setAdoptionHandler(handler) { onAdopt = handler; },
    setLeaseRecorder(recorder) { leaseRecorder = recorder; },
    close: async () => {
      calls.clear();
      byTurn.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") {
        try { fs.unlinkSync(options.socketPath); } catch { /* gone */ }
      }
    }
  };
}
