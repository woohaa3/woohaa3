import { decodeFilmSetGroupMarker, type FilmSetGroupMarker, type NodeGenerationHistoryDetail, type ServerCanvas } from "@woohaa3/contracts";

/** History stores orchestration only; source cards remain the content authority. */
export class HistoryFilmSetSnapshots {
  private records = new Map<string, FilmSetGroupMarker>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (nodeId: string) => this.records.get(nodeId);
  set(nodeId: string, detail: NodeGenerationHistoryDetail): boolean {
    if (detail.kind !== "model" || detail.animation?.schemaVersion !== 4) { this.clear(nodeId); return false; }
    const decoded = decodeFilmSetGroupMarker(detail.animation.filmSetGroup);
    if (!decoded.ok) { this.clear(nodeId); return false; }
    this.records.set(nodeId, decoded.value); this.emit(); return true;
  }
  clear(nodeId: string): void { if (this.records.delete(nodeId)) this.emit(); }
  project(canvas: ServerCanvas | null): ServerCanvas | null {
    if (!canvas || !this.records.size) return canvas;
    const nodeData = { ...canvas.nodeData };
    for (const [id, marker] of this.records) {
      if (canvas.document.nodes.some(node => node.id === id && node.type === "group")) nodeData[id] = { ...nodeData[id], filmSetGroup: marker } as import("@woohaa3/contracts").CanvasNodeData;
    }
    return { ...canvas, nodeData };
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
