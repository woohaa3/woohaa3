import { createHash } from "node:crypto";
import { computeInputHash } from "../../state/shared/index.js";
import { decodeGameResult } from "../shared/output.js";
import { projectKey, type Runtime } from "../../state/backend/runtime.js";
import { applyOperations } from "../../state/backend/operations.js";
import { finalizeBuild } from "./flows.js";
import { readPreparedGameSite } from "./project-workspace.js";

/** Agent 源码提交复用完整结果校验与不可变构建，不调用站点模型或伪造 Task 结果。 */
export async function submitAgentGame(rt: Runtime, input: {
  canvasId: string; nodeId: string; requestId: string; expectedInputHash: string;
  html?: string; projectId?: string; outputDirectory?: string; title?: string; controlsSummary?: string; resourceIds?: string[];
}): Promise<Record<string, unknown>> {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开" };
  if (!!input.projectId === (typeof input.html === "string")) return { ok: false, code: "malformed-request", message: "必须且只能提交 projectId 或兼容 html" };
  let publication: Awaited<ReturnType<typeof readPreparedGameSite>> | undefined;
  if (input.projectId) {
    try { publication = await readPreparedGameSite(rt, { ...input, projectId: input.projectId }); }
    catch (error) { return { ok: false, code: "project-publish-failed", message: error instanceof Error ? error.message : "产物登记失败" }; }
  }
  const raw = JSON.stringify({ schemaVersion: 1, entry: "index.html", html: publication?.html ?? input.html,
    title: input.title ?? project.state.requirements.name, controlsSummary: input.controlsSummary ?? "", resourceIds: input.resourceIds ?? [] });
  const decoded = decodeGameResult(raw);
  if (!decoded.ok) return { ok: false, code: decoded.code, message: decoded.message };
  const generationId = `agent-${createHash("sha256").update(input.requestId).digest("hex")}`;
  const workerTaskKey = `agent-source-${createHash("sha256").update(raw + (publication ? JSON.stringify(publication.site.files.map(file => [file.path, file.checksum])) : "")).digest("hex")}`;
  const previous = project.state.generations.find(g => g.generationId === generationId);
  if (previous && (previous.workerTaskKey !== workerTaskKey || previous.inputHash !== input.expectedInputHash)) {
    return { ok: false, code: "request-id-reused", message: "requestId 已用于不同代码或输入" };
  }
  if (computeInputHash(project.state) !== input.expectedInputHash) return { ok: false, code: "content-conflict", message: "项目内容已变化，请重新读取输入" };
  if (previous?.candidateBuildId) return { ok: true, state: "succeeded", generationId, buildId: previous.candidateBuildId, reused: true };
  if (previous?.disposition === "cancelled") return { ok: false, code: "cancelled", message: "该提交已取消" };
  const admission = rt.work();
  if (!admission.ok) return { ok: false, code: "work-not-ready", message: "扩展当前不接受新构建" };
  let terminal: "succeeded" | "failed" = "failed";
  try {
    if (!previous) {
      const linked = await applyOperations(rt, input.canvasId, input.nodeId, [{ type: "generation.link", generation: {
        origin: "agent", generationId, workerTaskKey, inputHash: input.expectedInputHash, workId: admission.workId,
        pluginConfigVersion: admission.configVersion, admittedAt: new Date().toISOString(), disposition: "candidate"
      } }]);
      if (!linked.ok) return linked;
    }
    const result = await finalizeBuild(rt, project.state, input.canvasId, input.nodeId, generationId, input.expectedInputHash, raw, publication?.site);
    if (result.ok === true) terminal = "succeeded";
    return { ...result, generationId };
  } finally {
    rt.settleWork?.(admission.workId, terminal);
  }
}
