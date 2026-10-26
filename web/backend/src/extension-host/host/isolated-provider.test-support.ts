/**
 * 测试用：把 `scripts/fixtures/marketplace/<fixture>` 复制到临时目录并打出 backend-dist，
 * 返回可直接喂给隔离控制器的 isolated 描述（与扫描器 `isolatedDescriptorOf` 同形）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IsolatedPluginDescriptor } from "./descriptor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../../../..");
export const CHILD_ENTRY = path.resolve(here, "../../../dist/extension-host-child.js");

export function buildFixture(name: string, mutate?: (dir: string) => void): { dir: string; descriptor: IsolatedPluginDescriptor; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `eh-${name}-`));
  const dir = path.join(root, name);
  fs.cpSync(path.join(REPO_ROOT, "scripts/fixtures/marketplace", name), dir, { recursive: true });
  mutate?.(dir);
  execFileSync(process.execPath, [path.join(REPO_ROOT, "web/scripts/build-extension-backend.mjs")], { cwd: dir, stdio: "pipe" });
  const extension = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(dir, "backend-dist/config-schema.json"), "utf8"));
  const descriptor: IsolatedPluginDescriptor = {
    isolated: true,
    extensionId: extension.extensionId,
    version: extension.version,
    directory: dir,
    entry: fs.realpathSync(path.join(dir, "backend-dist/entry.mjs")),
    factory: extension.hostPlugin.factory,
    kind: "provider",
    order: extension.hostPlugin.order,
    permissions: extension.permissions ?? {},
    publicRoutes: [],
    plugin: schema.plugin,
    origin: { managed: true, rootWritable: false }
  };
  return { dir, descriptor, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
