import { build } from "esbuild";
import { readdir, cp } from "node:fs/promises";
const sources = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== "test-support") await walk(file); }
    else if (/\.tsx?$/.test(file) && !/\.(test|stories)\./.test(file)) { if (!file.endsWith("/test-setup.ts")) sources.push(file); }
  }
}
await walk("src");
await build({ entryPoints: sources, outdir: "dist", outbase: "src", format: "esm", jsx: "automatic", platform: "browser", bundle: false });
await cp("src/styles", "dist/styles", { recursive: true });
for (const name of ["toolbar.css", "model-selector.css"]) await cp(`src/assistant/${name}`, `dist/assistant/${name}`);
// A consumer with no frontend/index.css and no application runtime dependencies.
const standalone = await build({ entryPoints: ["fixtures/standalone.tsx"], outdir: "dist/standalone", bundle: true, format: "esm", jsx: "automatic", platform: "browser", metafile: true, minify: true });
const forbidden = Object.keys(standalone.metafile.inputs).filter(file => /frontend\/|extensions\/|showcase\/|@ladle|\.stories\.|fixture(?!s\/standalone)/.test(file));
if (forbidden.length) throw new Error(`UI consumer contains application/development code: ${forbidden.join(", ")}`);
const { writeFile } = await import("node:fs/promises");
await writeFile("dist/standalone/metafile.json", JSON.stringify(standalone.metafile, null, 2));

await writeFile("dist/standalone/index.html", '<!doctype html><html><head><meta charset="utf-8"><title>Standalone UI consumer</title><link rel="stylesheet" href="standalone.css"></head><body><script type="module" src="standalone.js"></script></body></html>');

await cp("src/icons/ServiceLogo.LICENSE.md", "dist/icons/ServiceLogo.LICENSE.md");
