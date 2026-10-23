import { createHash } from "node:crypto";
import { GAME_SITE_BASE, readSourcePackageForPreview } from "./host.js";
import { addAppBasePath } from "@woohaa3/contracts";
import { safeMessage } from "../../state/shared/diagnostics.js";
import { projectKey, type Runtime } from "../../state/backend/runtime.js";
import { readBuildResources } from "../../state/backend/build-resources.js";

export async function runOpenPreview(rt: Runtime, input: { canvasId: string; nodeId: string; buildId: string }): Promise<Record<string, unknown>> {
  const project = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!project) return { ok: false, code: "target-missing", message: "项目尚未打开或已删除" };
  const build = project.state.builds.find((candidate) => candidate.buildId === input.buildId);
  if (!build) return { ok: false, code: "target-missing", message: "构建版本不存在或不可读" };
  if (!rt.services.media.resources) return { ok: false, code: "preview-policy-rejected", message: "缺少媒体读取能力" };
  let pkg;
  try {
    pkg = readSourcePackageForPreview((await rt.services.media.resources.read(build.sourceAssetId)).bytes);
  } catch (error) {
    return { ok: false, code: "preview-policy-rejected", message: safeMessage(error) };
  }
  if (!pkg) return { ok: false, code: "preview-policy-rejected", message: "源码包无法解析" };
  const files = new Map<string, { bytes: Uint8Array; contentType: string }>();
  try {
    if (pkg.site) {
      for (const file of pkg.site.files) {
        const saved = await rt.services.media.resources.read(file.storageKey);
        if (saved.bytes.length !== file.size || createHash("sha256").update(saved.bytes).digest("hex") !== file.checksum) throw Error("构建文件完整性校验失败");
        files.set(file.path, { bytes: saved.bytes, contentType: file.contentType });
      }
    }
    const resources = pkg.site ? new Map() : await readBuildResources(rt, pkg.manifest);
    const session = rt.preview.registerSession({ projectKey: projectKey(input.canvasId, input.nodeId), manifest: pkg.manifest, html: pkg.html, resources, files });
    return { ok: true, sessionId: session.sessionId, buildId: build.buildId, format: pkg.site ? "vite-static-site" : "legacy-static-site",
      // 入口 URL 是**公开**地址：逻辑站点前缀加一次当前挂载前缀（design D6）。
      entryUrl: `${addAppBasePath(rt.deploymentBasePath, `${GAME_SITE_BASE}/${session.sessionId}/index.html`)}`, files: pkg.site?.files.map(({ path, contentType, size }) => ({ path, contentType, size })) ?? [...files.keys()], expiresAt: session.expiresAt };
  } catch { return { ok: false, code: "preview-resource-missing", message: "构建文件缺失，无法打开试玩" }; }
}
