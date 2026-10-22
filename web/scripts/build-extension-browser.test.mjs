import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildExtensionBrowser } from "./build-extension-browser.mjs";

test("browser SDK bindings follow facade, reexport and lazy implementation dependencies", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "extension-browser-"));
  try {
    const sources = {
      "package.json": JSON.stringify({ type: "module" }),
      "src/frontend/index.ts": 'export { descriptor } from "../integration/browser/plugin.js";',
      "src/frontend/metadata.ts": 'export const metadata = { extensionId: "fixture" };',
      "src/integration/browser/plugin.ts": `
        import { hostValue } from "../../state/shared/value.js";
        export const descriptor = { value: hostValue, run: async () => (await import("../../authoring/browser/action.js")).run() };
      `,
      "src/state/shared/value.ts": 'export { hostValue } from "@woohaa3/frontend/extension-api";',
      "src/authoring/browser/action.ts": 'import { hostAction } from "@woohaa3/frontend/extension-api"; export const run = () => hostAction();',
      // An unreachable backend module must not pollute the browser SDK closure.
      "src/integration/backend/controller.ts": 'import sdk from "@woohaa3/frontend/extension-api"; export default sdk;'
    };
    for (const [relative, source] of Object.entries(sources)) {
      const file = path.join(cwd, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const result = await buildExtensionBrowser({ cwd });
    assert.deepEqual(result.manifest.requiredSdkExports, ["hostAction", "hostValue"]);
    const entry = await import(pathToFileURL(path.join(result.outDir, result.entry)).href);
    const hostValue = {};
    const { descriptor } = await entry.loadExtension({ token: {}, sdk: { hostValue, hostAction: () => "called" } });
    assert.equal(descriptor.value, hostValue);
    assert.equal(await descriptor.run(), "called");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
