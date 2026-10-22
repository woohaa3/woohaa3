import { readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Dev source tree identity, not a production JS bundle or Rust provenance. */
export function readDevBuildIdentity(root) {
  let js = "unknown", wasm = "unknown";
  try {
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z",
      "web/frontend/src", "web/frontend/vite.config.ts", "web/contracts/src", "web/extensions",
      "scripts/lib/dev-build-identity.mjs"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).sort();
    const source = createHash("sha256");
    for (const file of files) {
      source.update(file + "\0");
      try { source.update(readFileSync(resolve(root, file))); }
      catch (error) { if (error.code === "ENOENT") source.update("<missing>"); else throw error; }
    }
    js = `dev-source-sha256:${source.digest("hex")}`;
  } catch { /* Missing git/source observation must not prevent app startup. */ }
  try {
    wasm = `sha256:${createHash("sha256").update(readFileSync(resolve(root, "web/frontend/src/bevy-wasm/woohaa_bevy_canvas_bg.wasm"))).digest("hex")}`;
  } catch { /* The loader reports missing WASM; diagnostics stay unavailable. */ }
  return { js, wasm, mode: "development" };
}

/** Serve-only bootstrap; no endpoint, production bundle code or extra watcher. */
export function devBuildIdentityPlugin({ root, readIdentity = () => readDevBuildIdentity(root) }) {
  let generation = 0;
  let base = "/";
  return {
    name: "dev-build-identity",
    apply: "serve",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml() {
      const encoded = JSON.stringify(readIdentity()).replace(/</g, "\\u003c");
      return [{ tag: "script", attrs: { type: "module" }, injectTo: "head-prepend", children:
        `import { createHotContext } from ${JSON.stringify(`${base}@vite/client`)};
const initial = ${encoded};
globalThis.__woohaaBuildIdentity = { ...initial, ...globalThis.__woohaaBuildIdentity };
const hot = createHotContext(${JSON.stringify(`${base}@woohaa-build-identity`)});
let reload = 0;
const invalidate = (generation) => {
  // Hot modules can retain older controller closures or WASM instances. Do
  // not label them as a completely loaded new source/binary generation.
  globalThis.__woohaaBuildIdentity = { js: "hmr-mixed:" + generation,
    wasm: "hmr-unverified:" + generation, mode: "development" };
};
hot.on("woohaa:build-identity-invalidated", data => invalidate(data.generation));
hot.on("vite:beforeFullReload", () => invalidate("reload-" + ++reload));` }];
    },
    handleHotUpdate({ file, server }) {
      const path = relative(root, resolve(file)).split(sep).join("/");
      if (!["web/frontend/src/", "web/contracts/src/", "web/extensions/"].some(prefix => path.startsWith(prefix))) return;
      // Replace the identity object on the client, preserving earlier samples'
      // event-time snapshots. A full document reload provides a fresh identity.
      server.ws.send({ type: "custom", event: "woohaa:build-identity-invalidated", data: { generation: ++generation } });
    }
  };
}
