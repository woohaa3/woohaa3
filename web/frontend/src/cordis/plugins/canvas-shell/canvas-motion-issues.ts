import {
  buildFilmSetObjectMotions,
  checkAnimationMotion,
  readFilmSetAnimationProjection, readFilmSetGroupMarker, filmSetAnimationsOf, resolveFilmSetClip, isFilmSetNode
} from "@woohaa3/contracts";

export type CanvasMotionIssue = { nodeId: string; title: string; details: string[] };
type CanvasInput = { document: { nodes: readonly { id: string; type: string }[] }; nodeData: Record<string, unknown> };
// Canonical node data is immutable. Viewport/selection changes must not recompile motion scripts.
const checks = new WeakMap<object, { title: string; details: string[] }>();

export function canvasMotionIssues(canvas: CanvasInput | null): CanvasMotionIssue[] {
  if (!canvas) return [];
  const issues: CanvasMotionIssue[] = [];
  for (const node of canvas.document.nodes) {
    if (!isFilmSetNode(node.type, canvas.nodeData[node.id]) && !(node.type === "group" && readFilmSetGroupMarker(canvas.nodeData[node.id]))) continue;
    const data = canvas.nodeData[node.id];
    if (!data || typeof data !== "object") continue;
    let check = node.type === "group" ? undefined : checks.get(data);
    if (!check) {
      const animation = readFilmSetAnimationProjection(canvas, node.id);
      if (!animation) {
        check = { title: "片场", details: ["动画数据无法读取"] };
      } else {
        const names = new Map(animation.filmSetContent.items.map(item => [item.id, item.name]));
        const details = filmSetAnimationsOf(animation).clips.flatMap(clip => {
          const selected = resolveFilmSetClip(animation, clip.id)!;
          const state = checkAnimationMotion(selected);
          const child = buildFilmSetObjectMotions({ filmSetContent: selected.content, bindings: selected.clip.bindings });
          return [
            ...state.issues.map(issue => `片段「${clip.name}」（${clip.id}）动作暂不能播放：${issue.code}：${issue.message}`),
            ...child.diagnostics.map(message => `片段「${clip.name}」（${clip.id}）：` + message.replace(/片场对象 (\S+)/, (_, id: string) => `片场对象 ${names.get(id) ?? id}（${id}）`) + "。已跳过该对象的非法动作，其他对象仍可播放。")
          ];
        });
        check = { title: animation.title, details };
      }
      checks.set(data, check);
    }
    if (check.details.length) issues.push({ nodeId: node.id, ...check });
  }
  return issues;
}
