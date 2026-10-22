import { join } from "node:path";

/** Desktop owns a native Bevy renderer; its distribution has no browser fallback. */
export function frontendTarget(root: string, mode: string): { nativeOnly: boolean; input: Record<string, string> } {
  const nativeOnly = mode === "desktop";
  return {
    nativeOnly,
    input: nativeOnly
      ? { main: join(root, "index.html") }
      : { main: join(root, "index.html"), renderer: join(root, "renderer.html") }
  };
}

/** Keep generated wasm-bindgen code intact on disk; only the desktop build uses a local managed asset. */
export function externalizeEditorWasm(code: string): string {
  const expected = "new URL('./photocraft_editor_bg.wasm', import.meta.url)";
  if (!code.includes(`module_or_path = ${expected};`)) throw new Error("图片编辑 WASM 入口已变化，请更新桌面组件转换器");
  const endpoint = "new URL('/api/runtime-components/image-editor/asset', globalThis.location.origin)";
  const preflight = `const response = await fetch(${endpoint});
    if (!response.ok) {
      globalThis.dispatchEvent(new CustomEvent('woohaa-runtime-component-required', { detail: { id: 'image-editor' } }));
      throw new Error('请在设置 → 运行时组件中下载图片编辑组件，然后重新打开图片编辑器。');
    }
    module_or_path = response;`;
  return code.replace(`module_or_path = ${expected};`, preflight);
}
