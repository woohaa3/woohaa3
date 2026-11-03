/**
 * 本进程内、按回合 requestId 暂存 Codex 生图路径
 * （change: 2026-11-03-add-codex-image-import）。
 *
 * 传输层在回合进行中写入；稍后到达的导入工具按索引读取。
 * 路径不进入模型可见消息，也不进入工具参数。
 */
type GeneratedImageTurn = { codexHome: string; paths: string[] };

const turns = new Map<string, GeneratedImageTurn>();

export function recordGeneratedImage(requestId: string, savedPath: string, codexHome: string): void {
  const turn = turns.get(requestId) ?? { codexHome, paths: [] };
  turn.codexHome = codexHome;
  turn.paths.push(savedPath);
  turns.set(requestId, turn);
}

export function generatedImagePaths(requestId: string): readonly string[] {
  return turns.get(requestId)?.paths ?? [];
}

/** 本轮 Codex 进程实际使用的 home；导入时用它校验路径，而不是用户的 `~/.codex`。 */
export function generatedImageCodexHome(requestId: string): string | null {
  return turns.get(requestId)?.codexHome ?? null;
}

export function clearGeneratedImages(requestId: string): void {
  turns.delete(requestId);
}
