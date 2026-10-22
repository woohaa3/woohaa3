import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import { checkExtensionDependencies, moduleSpecifiers, sourceModules } from "../../../tooling/extension-dependencies.js";

it("actual responsibilities, environments, public entry closures and cycles", () => {
  expect(checkExtensionDependencies(ts, sourceModules(fileURLToPath(new URL("../src", import.meta.url))), ["shared.ts", "frontend/index.ts"])).toEqual([]);
});

it("resolves type imports, re-exports and literal dynamic imports before rejecting violations", () => {
  expect(moduleSpecifiers(ts, '/* import x from "ignored" */ import type { T } from "./type.js"; export * from "./barrel.js"; import("./late.js"); type U = import("./typed.js").U;')).toEqual(["./type.js", "./barrel.js", "./late.js", "./typed.js"]);
  const modules = new Map([
    ["frontend/index.ts", 'export * from "../preview/browser/view.js";'],
    ["preview/browser/view.ts", 'export type { T } from "../../state/shared/types.js"; import("../../authoring/backend/write.js");'],
    ["state/shared/types.ts", 'import type { T } from "../../integration/browser/host.js"; export type T = string;'],
    ["integration/browser/host.ts", 'export * from "../../preview/browser/view.js";'],
    ["authoring/backend/write.ts", 'import fs from "node:fs";']
  ]);
  const failures = checkExtensionDependencies(ts, modules, ["frontend/index.ts"]);
  for (const reason of ["responsibility preview -> authoring", "environment browser -> backend", "responsibility state -> integration", "environment shared -> browser", "cycle:", "Node dependency", "backend in neutral/browser closure"]) expect(failures.some(error => error.includes(reason)), reason).toBe(true);
});
