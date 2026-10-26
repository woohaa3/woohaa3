/**
 * 来源身份门禁（change: 2026-10-21-harden-extension-fault-isolation，任务 1.4）。
 *
 * 扩展只能经注入的 `ctx.slots`（宿主盖章代理）注册贡献：
 * - extension-api 不导出 slot registry 单例、盖章代理或来源查询（宿主私有）；
 * - 扩展前端生产源码不 import 宿主 `cordis/slots` 模块。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as extensionApi from "../extension-api/index.js";

const FORBIDDEN_EXPORTS = ["SlotRegistry", "createScopedSlots", "slotContributionOrigin", "nextExtensionAssemblyEpoch", "createExtensionFaultService"];
const EXTENSION_ROOTS = [
  fileURLToPath(new URL("../../../extensions", import.meta.url)),
  fileURLToPath(new URL("../../../../extensions", import.meta.url))
];

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", "browser-dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

describe("扩展 slot 来源身份门禁", () => {
  it("extension-api 不导出 registry 单例与盖章能力", () => {
    const exported = Object.keys(extensionApi);
    for (const name of FORBIDDEN_EXPORTS) expect(exported, name).not.toContain(name);
  });

  it("扩展前端源码不 import 宿主 slots 模块", () => {
    const offenders: string[] = [];
    for (const root of EXTENSION_ROOTS) {
      for (const file of walk(root).filter((candidate) => candidate.includes(`${path.sep}src${path.sep}`))) {
        const source = readFileSync(file, "utf8");
        if (/from\s+["'][^"']*cordis\/slots(\.js)?["']/.test(source) || /from\s+["'][^"']*cordis\/extension-faults(\.js)?["']/.test(source)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
