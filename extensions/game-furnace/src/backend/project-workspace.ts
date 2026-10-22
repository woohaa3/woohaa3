import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { safeSitePath, type GameSite, type SiteFile } from "../site-contract.js";
import { resourceDependencyPaths, resourceRelativePath } from "../package.js";
import { projectKey, type Runtime } from "./support.js";

type PreparedProject = { schemaVersion: 1; projectId: string; canvasId: string; nodeId: string; inputHash: string;
  resources: { resourceId: string; path: string; checksum: string; size: number; contentType?: string }[] };
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const identity = (canvasId: string, nodeId: string, inputHash: string) => digest(JSON.stringify([canvasId, nodeId, inputHash]));
export const mimeForSitePath = (file: string): string => ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" } as Record<string, string>)[path.extname(file).toLowerCase()] ?? "application/octet-stream";

/** 准备文件和固定素材；不安装依赖、不启动进程、不构建游戏。 */
export async function prepareGameProject(rt: Runtime, input: { canvasId: string; nodeId: string; expectedInputHash: string }): Promise<Record<string, unknown>> {
  const snapshot = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!snapshot || snapshot.inputHash !== input.expectedInputHash) return { ok: false, code: "content-conflict", message: "输入已变化，请重新读取炼丹炉" };
  const projectId = identity(input.canvasId, input.nodeId, snapshot.inputHash);
  const directory = path.join(rt.workspaceRoot, projectId);
  let info: PreparedProject;
  try { info = JSON.parse(await readFile(path.join(directory, ".furnace-project.json"), "utf8")) as PreparedProject; }
  catch {
    await mkdir(rt.workspaceRoot, { recursive: true });
    const staging = await mkdtemp(path.join(rt.workspaceRoot, ".prepare-"));
    info = { schemaVersion: 1, projectId, canvasId: input.canvasId, nodeId: input.nodeId, inputHash: snapshot.inputHash, resources: [] };
    try {
      await mkdir(path.join(staging, "src"));
      await mkdir(path.join(staging, "public/assets"), { recursive: true });
      await writeFile(path.join(staging, "package.json"), JSON.stringify({ name: "furnace-game", private: true, type: "module", scripts: { dev: "vite --host", build: "vite build --base=./", preview: "vite preview" }, devDependencies: { vite: "^5.4.21" } }, null, 2));
      await writeFile(path.join(staging, "index.html"), '<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><canvas id="game"></canvas><script type="module" src="./src/main.js"></script></body></html>');
      await writeFile(path.join(staging, "src/main.js"), '// Agent 在这里实现游戏。宿主不生成或构建代码。\n');
      let total = 0;
      for (const resource of snapshot.state.resources) {
        for (const file of await readResourceFiles(rt, resource)) {
          total += file.bytes.length;
          if (total > 256 * 1024 * 1024) throw Error("素材总量超过256MiB");
          await writeFile(path.join(staging, "public", file.path), file.bytes);
          info.resources.push({ resourceId: resource.resourceId, path: file.path, checksum: digest(file.bytes), size: file.bytes.length, contentType: file.contentType });
        }
      }
      await writeFile(path.join(staging, ".furnace-project.json"), JSON.stringify(info));
      await rename(staging, directory);
    } catch (error) { await rm(staging, { recursive: true, force: true }); return { ok: false, code: "project-prepare-failed", message: error instanceof Error ? error.message : "准备目录失败" }; }
  }
  if (info.projectId !== projectId || info.canvasId !== input.canvasId || info.nodeId !== input.nodeId || info.inputHash !== input.expectedInputHash) {
    return { ok: false, code: "project-prepare-failed", message: "本地项目元数据与当前输入不匹配" };
  }
  return { ok: true, projectId, inputHash: info.inputHash, projectDirectory: directory, assetsDirectory: path.join(directory, "public/assets"), outputDirectory: path.join(directory, "dist"), resources: info.resources,
    agentInstructions: "在projectDirectory编写完整游戏，自行安装依赖、运行构建并进行浏览器验证；Vite请使用相对base（默认npm run build）。完成后submit_game提交projectId，宿主仅登记dist，不执行构建。远程Agent若不能访问该目录，必须先同步源码/素材与构建产物，不要假定路径在自己的机器上存在。" };
}

/** 登记 Agent 已构建的目录为不可变文件表；不会执行任何源码或构建命令。 */
export async function readPreparedGameSite(rt: Runtime, input: { canvasId: string; nodeId: string; expectedInputHash: string; projectId: string; outputDirectory?: string }): Promise<{ site: GameSite; html: string }> {
  if (input.projectId !== identity(input.canvasId, input.nodeId, input.expectedInputHash)) throw Error("项目目录与当前节点/输入不匹配");
  const directory = path.join(rt.workspaceRoot, input.projectId);
  const info = JSON.parse(await readFile(path.join(directory, ".furnace-project.json"), "utf8")) as PreparedProject;
  if (info.projectId !== input.projectId || info.canvasId !== input.canvasId || info.nodeId !== input.nodeId || info.inputHash !== input.expectedInputHash) throw Error("项目目录归属不匹配");
  const output = input.outputDirectory ?? "dist";
  if (!safeSitePath(output)) throw Error("构建输出目录必须是项目内相对路径");
  const projectRoot = await realpath(directory);
  const workspaceRoot = await realpath(rt.workspaceRoot);
  if (!projectRoot.startsWith(workspaceRoot + path.sep) || (await lstat(directory)).isSymbolicLink()) throw Error("项目目录越界");
  const dist = path.join(directory, output);
  if (!(await realpath(dist)).startsWith(projectRoot + path.sep)) throw Error("构建目录越界");
  if (!rt.services.media.resources) throw Error("缺少媒体存储能力");
  const canonical = rt.projects.get(projectKey(input.canvasId, input.nodeId));
  if (!canonical || canonical.inputHash !== input.expectedInputHash) throw Error("登记期间输入已变化");
  const originals = new Map<string, { bytes: Uint8Array; contentType: string }>();
  for (const resource of canonical.state.resources) {
    for (const file of await readResourceFiles(rt, resource)) originals.set(file.path, file);
  }
  const files: SiteFile[] = [];
  let total = 0;
  async function visit(folder: string, prefix = "") {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (!safeSitePath(relative) || entry.isSymbolicLink()) throw Error("站点包含非法路径或符号链接");
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) await visit(absolute, relative + "/");
      else if (entry.isFile()) {
        if ((await lstat(absolute)).isSymbolicLink() || !(await realpath(absolute)).startsWith(projectRoot + path.sep)) throw Error("站点文件越界");
        const bytes = await readFile(absolute); total += bytes.length;
        if (!bytes.length || files.length >= 512 || total > 256 * 1024 * 1024 || bytes.length > 16 * 1024 * 1024) throw Error("站点文件超过预算");
        const original = originals.get(relative);
        if (original && digest(bytes) !== digest(original.bytes)) throw Error(`构建素材字节已变化：${relative}`);
        const contentType = original?.contentType ?? mimeForSitePath(relative);
        const saved = await rt.services.media.resources!.write({ bytes, contentType });
        files.push({ path: relative, storageKey: saved.storageKey, contentType, size: bytes.length, checksum: digest(bytes) });
      } else throw Error("站点包含不支持的文件");
    }
  }
  if (!rt.services.media.resources) throw Error("缺少媒体存储能力");
  await visit(dist);
  if (!files.some(file => file.path === "index.html")) throw Error("Agent尚未构建index.html入口");
  // 本地元数据由 Agent 可写；原件校验必须重新来自权威项目，不能信任缓存清单。
  if (rt.projects.get(projectKey(input.canvasId, input.nodeId)) !== canonical) throw Error("登记期间项目已变化");
  for (const [originalPath, original] of originals) {
    const artifact = files.find(file => file.path === originalPath);
    if (!artifact || artifact.checksum !== digest(original.bytes)) throw Error(`构建缺少准备素材或字节已变化：${originalPath}`);
  }
  const sourceFiles: Record<string, string> = {};
  for (const name of ["package.json", "index.html"]) sourceFiles[name] = await readFile(path.join(directory, name), "utf8");
  const html = await readFile(path.join(dist, "index.html"), "utf8");
  if (!/<(?:html|!doctype html)\b/i.test(html) || !/<script\b/i.test(html)) throw Error("站点入口缺少完整HTML或脚本");
  if (/\b(?:src|href)\s*=\s*["'](?:https?:|\/\/|\/)/i.test(html)) throw Error("站点入口须使用项目内相对资源路径（Vite base应为./）");
  return { site: { schemaVersion: 1, format: "vite", sourceFiles, files }, html };
}


/** 只读取已确认状态中的完整原件/依赖，不信任 Agent 可改写的项目清单。 */
async function readResourceFiles(rt: Runtime, resource: import("../shared.js").GameResource): Promise<{ path: string; bytes: Uint8Array; contentType: string }[]> {
  const media = rt.services.media.resources;
  if (!media) throw Error("缺少媒体读取能力");
  const files = [];
  if (resource.metadata?.storageKey) {
    const original = await media.read(resource.metadata.storageKey);
    files.push({ path: resourceRelativePath(resource), ...original });
  } else {
    if (!resource.payload.snapshot || resource.payload.snapshot.overBudget) throw Error(`素材原件缺失，请重新收集：${resource.name}`);
    const bytes = Buffer.from(resource.kind === "text" ? String(resource.payload.snapshot.text ?? "") : JSON.stringify(resource.payload.snapshot));
    files.push({ path: resourceRelativePath(resource), bytes, contentType: resource.kind === "text" ? "text/plain" : "application/json" });
  }
  for (const dependency of resourceDependencyPaths(resource)) files.push({ path: dependency.path, ...await media.read(dependency.storageKey) });
  for (const file of files) {
    if (!safeSitePath(file.path) || !file.bytes.length || file.bytes.length > 16 * 1024 * 1024) throw Error("素材路径、内容或单文件预算非法");
  }
  return files;
}
