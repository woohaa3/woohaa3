import type { ServerCanvas } from "@woohaa3/contracts";

export type WorkspaceTarget = { canvas: ServerCanvas | null; nodeId: string | null; writable: boolean };
export type WorkspaceToken = { canvasId: string; nodeId: string; epoch: number; sequence: number; identity: string };

/** A workspace request belongs to one continuous target lifetime and one authored definition. */
export function createWorkspaceGuard(read: () => WorkspaceTarget) {
  let key: string | null = null;
  let epoch = 0;
  let sequence = 0;
  const refresh = () => {
    const target = read();
    const node = target.canvas?.document.nodes.find(node => node.id === target.nodeId);
    const data = target.nodeId ? target.canvas?.nodeData[target.nodeId] : undefined;
    const next = node?.type === "composite-asset" && data?.extensionId === "game-furnace"
      ? `${target.canvas!.id}\0${target.nodeId}` : null;
    if (next !== key) { key = next; epoch += 1; sequence += 1; }
    return target;
  };
  const identity = (target: WorkspaceTarget) => {
    const data = target.canvas!.nodeData[target.nodeId!] ?? {};
    return JSON.stringify({
      extensionId: data.extensionId, modelScript: data.modelScript,
      modelScriptLanguage: data.modelScriptLanguage, modelScriptVersion: data.modelScriptVersion,
      modelContentVersion: data.modelContentVersion, modelPlacement: data.modelPlacement, scenePlacement: data.scenePlacement,
      projectStorageKey: data.projectStorageKey, inputHash: data.inputHash, activeBuildId: data.activeBuildId
    });
  };
  return {
    refresh,
    epoch: () => { refresh(); return epoch; },
    capture(write = false, advance = false): WorkspaceToken | null {
      const target = refresh();
      if (key === null || (write && !target.writable)) return null;
      if (advance) sequence += 1;
      return { canvasId: target.canvas!.id, nodeId: target.nodeId!, epoch, sequence, identity: identity(target) };
    },
    lifetime(token: WorkspaceToken): boolean {
      refresh();
      return key === `${token.canvasId}\0${token.nodeId}` && epoch === token.epoch;
    },
    current(token: WorkspaceToken, write = false, definition = true): boolean {
      const target = refresh();
      return key === `${token.canvasId}\0${token.nodeId}` && epoch === token.epoch && sequence === token.sequence
        && (!write || target.writable) && (!definition || identity(target) === token.identity);
    }
  };
}
