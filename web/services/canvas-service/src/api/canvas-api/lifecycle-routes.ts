import { createHash } from "node:crypto";
/**
 * Canvas API：lifecycle / list / get / delete / health 路由
 * （自 `canvas-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R23；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 4.4/6.1/6.2 —— 资源授权接缝）。
 *
 * 资源授权模型：宿主注入 `authenticate`（可信 principal）与 `access`（ResourceAccessPolicy 适配）后，
 * 每个路由在读取/写入前按 read/write/delete 判定，未认证 401、无权限 403、provider 故障 503、
 * 不存在 404。**未注入** `authenticate` 时保持历史服务令牌/loopback 行为（独立 Canvas 服务部署）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_CANVAS_MAX_BODY_BYTES, type CanvasLogger, type CanvasReadiness, type CanvasRequestHandlerOptions } from "./types.js";
import { etagFor, readInt, readJsonBody, sendError, sendJson } from "./http-codec.js";
import { authorizeCanvasRequest, httpStatusForCanvasAccess } from "../../access/resolve-access.js";

/** 统一资源授权（仅在宿主注入 authenticate 时执行）；返回是否放行。 */
async function requireCanvasAccess(input: {
  req: IncomingMessage;
  res: ServerResponse;
  canvasId: string;
  permission: "read" | "write" | "manageSharing" | "delete";
  options: CanvasRequestHandlerOptions;
  log: CanvasLogger;
}): Promise<{ ok: true; principal?: import("@woohaa3/contracts").PrincipalContext } | { ok: false }> {
  if (!input.options.authenticate) return { ok: true };
  const decision = await authorizeCanvasRequest({
    req: input.req,
    canvasId: input.canvasId,
    permission: input.permission,
    authenticate: input.options.authenticate,
    access: input.options.access ?? { authorize: async () => ({ allowed: false, code: "provider-unavailable", message: "画布授权提供者不可用" }) }
  });
  if (decision.ok) return { ok: true, principal: decision.principal };
  const mapped = httpStatusForCanvasAccess(decision.decision);
  input.log?.({ event: "canvas-access-denied", status: mapped.status, code: mapped.code });
  sendError(input.res, mapped.status, mapped.code, decision.decision.message);
  return { ok: false };
}

export async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  // 未注入授权时保持历史行为（独立 Canvas 服务/loopback 服务令牌路径）。
  if (!options.authenticate) {
    sendJson(res, 200, await loadCanvasListPage(req, options));
    log?.({ event: "canvas-list", status: 200 });
    return true;
  }
  let principal: import("@woohaa3/contracts").PrincipalContext | null;
  try {
    principal = await options.authenticate(req, "http");
  } catch {
    sendError(res, 503, "NOT_READY", "画布认证提供者不可用");
    return true;
  }
  if (!principal) {
    sendError(res, 401, "UNAUTHORIZED", "未认证");
    return true;
  }
  // 任务 5.5：先解析可信主体的**可发现集合** ID 全集，再在**分页之前**过滤。
  // 旧实现「先取一页再逐条丢弃」使散落在后续页的可发现画布永远不可见（total 也只反映当页）。
  if (options.discoverableCanvasIds) {
    let ids: string[] | null;
    try {
      ids = await options.discoverableCanvasIds(principal);
    } catch {
      log?.({ event: "canvas-list-access-provider-failed", status: 503 });
      sendError(res, 503, "REPOSITORY_FAILURE", "画布授权提供者不可用");
      return true;
    }
    // 空数组即 fail closed（无可发现画布）；不因 provider 返回空而退回列出全库。
    if (ids) {
      // 任务 5.5：白名单进仓库**分页之前**过滤，`total`/翻页因此覆盖全部可发现画布。
      sendJson(res, 200, await loadCanvasListPage(req, options, ids));
      log?.({ event: "canvas-list", status: 200 });
      return true;
    }
  }
  // provider 未注入/不可用：回退逐项判定（仍不列出他人画布，但不保证翻页覆盖全部可发现画布）。
  const page = await loadCanvasListPage(req, options);
  const access = options.access;
  const items = [];
  for (const item of page.items) {
    const decision = access ? await access.authorize({ principal, canvasId: item.id, permission: "read" }) : { allowed: false as const };
    if (decision.allowed) items.push(item);
  }
  // 分页元数据必须原样带上：前端 `decodeCanvasListPage` 要求 offset/limit。
  sendJson(res, 200, { items, total: items.length, offset: page.offset, limit: page.limit });
  log?.({ event: "canvas-list", status: 200 });
  return true;
}

/**
 * 读取目录页数据（不发送）；供列表 ACL 过滤复用（任务 5.5）。
 *
 * `ids` 为可发现画布 ID 白名单（分页前过滤）；省略表示不过滤。
 */
export async function loadCanvasListPage(
  req: IncomingMessage,
  options: CanvasRequestHandlerOptions,
  ids?: readonly string[]
): Promise<import("@woohaa3/contracts").CanvasListPage> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const offset = readInt(url.searchParams.get("offset"));
  const limit = readInt(url.searchParams.get("pageSize") ?? url.searchParams.get("limit"));
  const query = { offset, limit, ...(ids ? { ids } : {}) };
  return options.catalog
    ? await options.catalog.listCanvases(query)
    : await options.service.listCanvases(query);
}

export async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  const body = await readJsonBody(req, options.maxBodyBytes ?? DEFAULT_CANVAS_MAX_BODY_BYTES);
  const requestedCanvasId = typeof body.canvasId === "string" ? body.canvasId : undefined;
  const title = typeof body.title === "string" ? body.title : undefined;
  const operationId = typeof body.operationId === "string" && body.operationId.trim() !== "" ? body.operationId.trim() : undefined;

  const canvasId = requestedCanvasId ?? (operationId ? `canvas-${createHash("sha256").update(operationId).digest("hex")}` : undefined);

  // 注入认证/生命周期时先预留 owner（provisioning 不公开），创建后 finalize；失败 tombstone。
  if (options.authenticate && options.lifecycle) {
    let principal;
    try { principal = await options.authenticate(req, "http"); }
    catch { sendError(res, 503, "NOT_READY", "画布认证提供者不可用"); return true; }
    if (!principal) {
      sendError(res, 401, "UNAUTHORIZED", "未认证");
      return true;
    }
    const effectiveCanvasId = canvasId ?? crypto.randomUUID();
    const opId = operationId ?? `create:${effectiveCanvasId}`;
    const reserved = await options.lifecycle.reserve({ canvasId: effectiveCanvasId, principal, operationId: opId });
    if (!reserved.ok) {
      const status = reserved.code === "exists" ? 409 : reserved.code === "provider-unavailable" ? 503 : 403;
      sendError(res, status, reserved.code === "exists" ? "COMMAND_REJECTED" : "FORBIDDEN", reserved.message);
      return true;
    }
    /** 读取已存在的画布：确实不存在返回 null；其它存储故障原样抛出。 */
    const loadExistingCanvas = async () => {
      try {
        return await options.service.getCanvas(effectiveCanvasId);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === "CANVAS_NOT_FOUND") return null;
        throw error;
      }
    };
    try {
      // 崩溃恢复（任务 11.2 / D1）：同一 operation 续作时内容可能已由上次尝试创建，
      // 先复用已有画布，只有确实不存在才创建——不产生第二份内容。
      const canvas = reserved.resumed
        ? await loadExistingCanvas() ?? await options.service.createCanvas({ canvasId: effectiveCanvasId, operationId: opId, ...(title !== undefined ? { title } : {}) })
        : await options.service.createCanvas({ canvasId: effectiveCanvasId, operationId: opId, ...(title !== undefined ? { title } : {}) });
      const finalized = await options.lifecycle.finalize({ canvasId: canvas.id, principal, operationId: opId });
      if (!finalized.ok) {
        sendError(res, finalized.code === "provider-unavailable" ? 503 : 500, "REPOSITORY_FAILURE", "画布已创建但授权最终化失败");
        return true;
      }
      sendJson(res, 201, { canvas, revision: canvas.revision });
      log?.({ event: "canvas-create", status: 201, ...(reserved.resumed ? { resumed: true } : {}) });
      return true;
    } catch (error) {
      // 失败补偿（任务 11.2 / D1）：内容其实已落库（写后超时/报错）→ 按同一 receipt 补齐 finalize，
      // 不产生孤儿内容；内容确实没建成 → 释放预留，允许客户端换 operation 重试；探测也失败 →
      // 保留 provisioning 预留（不公开），交给客户端重试或下次启动结算。
      const existing = await loadExistingCanvas().catch(() => undefined);
      if (existing) {
        const finalized = await options.lifecycle.finalize({ canvasId: existing.id, principal, operationId: opId });
        if (finalized.ok) {
          sendJson(res, 201, { canvas: existing, revision: existing.revision });
          log?.({ event: "canvas-create-recovered", status: 201 });
          return true;
        }
      } else if (existing === null) {
        await options.lifecycle.cancelReservation?.({ canvasId: effectiveCanvasId, principal, operationId: opId }).catch(() => undefined);
      }
      throw error;
    }
  }

  const canvas = await options.service.createCanvas({ canvasId, operationId, ...(title !== undefined ? { title } : {}) });
  sendJson(res, 201, { canvas, revision: canvas.revision });
  log?.({ event: "canvas-create", status: 201 });
  return true;
}

export async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  if (!(await requireCanvasAccess({ req, res, canvasId, permission: "read", options, log })).ok) return true;
  /**
   * 调用者在这张画布上的内容权限（远端判定；纯本地画布为 null = 未知）。
   *
   * 必须随**打开画布**的响应一起回去：只读提示要出现在进入画布这一步，而不是等第一次
   * 服务端写入（生成/存储）被拒绝才暴露。读取失败只是"这次没答案"，不影响打开。
   */
  const access = await options.catalog?.accessOf(canvasId).catch(() => null);
  const accessField = access === null || access === undefined ? {} : { access };
  try {
    const canvas = await options.service.getCanvas(canvasId);
    res.setHeader("ETag", etagFor(canvas.revision, canvas.updatedAt));
    sendJson(res, 200, { canvas, revision: canvas.revision, ...accessField });
    log?.({ event: "canvas-get", status: 200 });
    return true;
  } catch (error) {
    // 本机没有这张画布时，问一次远端目录来源：只在远端存在的画布必须能打开，
    // 否则"两个来源都生效"在界面上就是一列表点不开的条目。
    const remote = await options.catalog?.remoteSummary(canvasId).catch(() => null);
    if (!remote) throw error;
    // 返回的是**来源摘要**，不是内容：内容由 room 从上游拉取（seedFromUpstream）。
    // 这里刻意给出空 document/asset，nodeCount 由摘要携带，避免看起来像"内容丢了"。
    const canvas = {
      id: remote.id,
      title: remote.title,
      revision: remote.revision,
      updatedAt: remote.updatedAt,
      document: { nodes: [] },
      assets: [],
      ...(remote.createdAt ? { createdAt: remote.createdAt } : {})
    };
    res.setHeader("ETag", etagFor(remote.revision, remote.updatedAt));
    sendJson(res, 200, { canvas, revision: remote.revision, pendingFetch: true, ...accessField });
    log?.({ event: "canvas-get-remote-only", status: 200 });
    return true;
  }
}

export async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  canvasId: string,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const header = req.headers["if-match"] ?? req.headers["x-expected-revision"];
  const raw = url.searchParams.get("expectedRevision")
    ?? (Array.isArray(header) ? header[0] : header);
  const expectedRevision = readInt(raw);
  if (expectedRevision === undefined) {
    sendError(res, 400, "INVALID_COMMAND_BATCH", "缺少 expectedRevision");
    return true;
  }
  const access = await requireCanvasAccess({ req, res, canvasId, permission: "delete", options, log });
  if (!access.ok) return true;

  // 任务 5.2：先进入 `deleting` 中间态（读者被阻断、连接将由下面断开），再删权威内容，
  // 最后保存 tombstone。中间态写入失败（除 provider 不支持/无 ACL）即中止，不留半删状态。
  const principal = access.principal;
  if (options.lifecycle && principal) {
    const begun = await options.lifecycle.beginDelete({
      canvasId,
      principal,
      operationId: `delete-begin:${canvasId}:${expectedRevision}`
    });
    if (!begun.ok && begun.code !== "unsupported" && begun.code !== "not-found") {
      const status = begun.code === "provider-unavailable" ? 503 : 403;
      sendError(res, status, begun.code === "provider-unavailable" ? "REPOSITORY_FAILURE" : "FORBIDDEN", begun.message);
      log?.({ event: "canvas-delete-begin-failed", status, code: begun.code });
      return true;
    }
  }

  try {
    await options.service.deleteCanvas(canvasId, expectedRevision, `delete:${canvasId}:${expectedRevision}`);
  } catch (error) {
    // 删除失败：复原 ACL 为 active（可恢复，不把画布永久留在不可读的 deleting），再上抛。
    if (options.lifecycle && principal) {
      await options.lifecycle
        .finalize({ canvasId, principal, operationId: `delete-revert:${canvasId}:${expectedRevision}` })
        .catch(() => undefined);
    }
    throw error;
  }

  // 删除成功后断开该画布的全部实时会话，使撤权在生效后同步可见（任务 5.2）。
  await options.closeSessions?.(canvasId, "canvas-deleted");
  // 保存 tombstone（best-effort；缺失不使已删画布变成可认领孤儿）。
  if (options.lifecycle && principal) {
    await options.lifecycle.tombstone({ canvasId, principal, operationId: `delete:${canvasId}:${expectedRevision}` }).catch(() => undefined);
  }
  res.statusCode = 204;
  res.end();
  log?.({ event: "canvas-delete", status: 204 });
  return true;
}

export async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  options: CanvasRequestHandlerOptions,
  log: CanvasLogger
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const isReady = url.pathname.endsWith("/ready");
  if (!isReady) {
    sendJson(res, 200, { status: "ok" });
    log?.({ event: "canvas-live", status: 200 });
    return true;
  }
  const readiness = options.readiness
    ? await options.readiness()
    : toReadiness(await options.service.health());
  if (!readiness.ready) {
    sendJson(res, 503, { status: "not-ready", reason: readiness.reason ?? "依赖不可用" });
    log?.({ event: "canvas-ready", status: 503 });
    return true;
  }
  sendJson(res, 200, { status: "ready" });
  log?.({ event: "canvas-ready", status: 200 });
  return true;
}

function toReadiness(health: { ok: boolean; backend: string; reason?: string }): CanvasReadiness {
  return health.ok
    ? { ready: true }
    : { ready: false, reason: `数据库不可用（${health.backend}）` };
}
