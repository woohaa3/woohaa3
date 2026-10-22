import { decodeFilmSetNodeData, canonicalFilmSetFields, type FilmSetNodeData, type CanvasNodeData, type NodeGenerationHistoryDetail, type ServerCanvas } from "@woohaa3/contracts";
import { buildFilmSetComposition, type FilmSetCompositionResult } from "../shared/composition.js";

type Snapshot = { animation: FilmSetNodeData; fields: CanvasNodeData; composition: FilmSetCompositionResult };
export class HistoryFilmSetSnapshots {
  private records = new Map<string, Snapshot>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (nodeId: string) => this.records.get(nodeId);
  set(nodeId: string, detail: NodeGenerationHistoryDetail): boolean {
    if (detail.kind !== "model" || !detail.animation) { this.clear(nodeId); return false; }
    const source = detail.animation;
    // 片场历史 items-only（schema 3）：独立根 + items + 片段；旧 schema 1/2 只由离线迁移转换。
    if (source.schemaVersion !== 3) { this.clear(nodeId); return false; }
    const decoded = decodeFilmSetNodeData({
      extensionId: "film-set",
      title: "片场",
      scenePlacement: source.scenePlacement,
      sceneCamera: source.sceneCamera,
      filmSetContent: source.filmSetContent,
      filmSetAnimations: source.filmSetAnimations,
      ...(source.origin ? { origin: source.origin } : {})
    });
    if (!decoded.ok) { this.clear(nodeId); return false; }
    const animation = decoded.value;
    this.records.set(nodeId, { animation, fields: canonicalFilmSetFields(animation) as CanvasNodeData, composition: buildFilmSetComposition({ nodeId, animation }) });
    this.emit(); return true;
  }
  clear(nodeId: string): void { if (this.records.delete(nodeId)) this.emit(); }
  project(canvas: ServerCanvas | null): ServerCanvas | null {
    if (!canvas || !this.records.size) return canvas;
    const nodeData = { ...canvas.nodeData };
    for (const [id, record] of this.records) {
      if (canvas.document.nodes.some(node => node.id === id && node.type === "composite-asset") && canvas.nodeData[id]?.extensionId === "film-set") nodeData[id] = record.fields;
    }
    return { ...canvas, nodeData };
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}

