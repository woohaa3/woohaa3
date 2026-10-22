/**
 * 把子项目构建出的 PhotoCraft WASM 复制到宿主前端源码图
 * （change: 2026-10-21-extract-photocraft-subproject，宿主 dev 资源边界修正）。
 *
 * 子项目仍是唯一构建者与产物所有者；宿主只复制**已生成**的 glue/wasm/声明到
 * `web/frontend/src/photocraft-wasm/`，让 Vite 从自身 root 提供文件，避免 linked package
 * 位于 web workspace 之外时被 `server.fs.allow` 拒绝（浏览器报 403）。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const PHOTOCRAFT_WASM_FILES = [
  "photocraft_editor.js",
  "photocraft_editor_bg.wasm",
  "photocraft_editor.d.ts",
  "photocraft_editor_bg.wasm.d.ts"
];

/** @param {string} root 仓库根目录 */
export function photocraftWasmDirs(root) {
  return {
    source: join(root, "photocraft", "packages", "editor", "dist", "wasm"),
    destination: join(root, "web", "frontend", "src", "photocraft-wasm")
  };
}

function isCurrent(source, destination, names) {
  for (const name of names) {
    const from = join(source, name);
    const to = join(destination, name);
    if (!existsSync(from) || !existsSync(to)) return false;
    const a = statSync(from);
    const b = statSync(to);
    if (a.size !== b.size || a.mtimeMs > b.mtimeMs) return false;
  }
  return true;
}

/**
 * 同步副本；源产物缺失时返回 `{ copied: false, missingSource: true }`，由调用方决定是否先构建。
 * 源文件不存在但可选的声明缺失不构成失败。
 * @param {string} root
 */
export function syncPhotocraftWasm(root) {
  const { source, destination } = photocraftWasmDirs(root);
  const required = ["photocraft_editor.js", "photocraft_editor_bg.wasm"];
  if (!required.every(name => existsSync(join(source, name)))) {
    return { copied: false, missingSource: true, source, destination };
  }
  if (isCurrent(source, destination, PHOTOCRAFT_WASM_FILES)) {
    return { copied: false, missingSource: false, source, destination };
  }
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const copied = [];
  for (const name of PHOTOCRAFT_WASM_FILES) {
    const from = join(source, name);
    if (!existsSync(from)) continue;
    copyFileSync(from, join(destination, name));
    copied.push(name);
  }
  return { copied: true, missingSource: false, source, destination, files: copied };
}
