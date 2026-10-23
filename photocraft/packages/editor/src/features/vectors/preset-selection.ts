/**
 * 自定形状的当前选择（U16，change: 2026-10-22-add-photocraft-vector-canvas-tools）。
 *
 * 面板里的「预设」下拉与画布上的 Custom Shape 拖绘必须看**同一个**选择，否则会出现
 * 「面板显示已选箭头、画布却提示未选预设」。选择是工具状态（不进文档、不进历史），
 * 因此用域内的小 store，而不是往共享控制器或文档模型里塞字段。
 */

export type PresetChoice = { group: string; name: string; custom: boolean };

let current: PresetChoice | null = null;
const listeners = new Set<() => void>();

export function presetChoice(): PresetChoice | null {
  return current;
}

export function setPresetChoice(next: PresetChoice | null): void {
  if (current === next) return;
  if (current && next && current.group === next.group && current.name === next.name && current.custom === next.custom) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribePresetChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
