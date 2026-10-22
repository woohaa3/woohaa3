import { useState } from "react";
import { Button } from "@woohaa3/frontend/extension-api";
import type { GameRequirements } from "../shared.js";
import { GAME_FURNACE_AUTHORING } from "../authoring.js";

export function GameFurnaceMcpGuide(props: { canvasId?: string; nodeId: string; requirements: GameRequirements; writable: boolean }) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const serverUrl = typeof window === "undefined" ? "/mcp/model-canvas" : `${window.location.origin}/mcp/model-canvas`;
  const target = JSON.stringify({ canvasId: props.canvasId ?? "", nodeId: props.nodeId });
  const requirements = JSON.stringify({ name: props.requirements.name, description: props.requirements.description, gameplay: props.requirements.gameplay ?? "" });
  const guide = props.writable
    ? `使用 Woohaa3 Model Canvas MCP 为当前炼丹炉编写游戏。\n目标：${target}\n先调用 get_game_furnace 读取需求、素材快照、resourcePaths、最新 inputHash 和 authoring 能力声明。\n当前游戏需求：${requirements}\n交付要求：\n${GAME_FURNACE_AUTHORING.deliveryRequirements.join("\n")}\n执行环境：${GAME_FURNACE_AUTHORING.limitation}\n${GAME_FURNACE_AUTHORING.rules}\n如需更新需求或收集素材，调用 update_game_furnace，带稳定 requestId 和 expectedInputHash，并使用返回的新 inputHash。\n同次提交重试复用requestId，修改代码和重建用新requestId。游戏源码示例仅供Agent编写参考：${JSON.stringify(GAME_FURNACE_AUTHORING.exampleFiles)}`
    : `使用 Woohaa3 Model Canvas MCP 查看当前炼丹炉。\n目标：${target}\n当前页面为只读，请仅调用 get_game_furnace 读取需求、素材和构建，再调用 preview_game 查看指定 buildId；不要修改需求或提交代码。`;
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback(`${label}已复制`);
    } catch { setFeedback("复制失败，请手动选择文本复制"); }
  };
  return <section className="game-furnace-mcp-guide" aria-label="MCP 游戏生成指引">
    <h3>MCP 游戏生成</h3>
    <p>把交付要求和当前接口能力一起发给 Agent。</p>
    <p>{GAME_FURNACE_AUTHORING.limitation}</p>
    <label>服务器地址
      <textarea readOnly rows={2} value={serverUrl} aria-label="炼丹炉 MCP 服务器地址" />
    </label>
    <Button size="sm" onClick={() => void copy(serverUrl, "服务器地址")}>复制 MCP 地址</Button>
    <ol>
      <li>读取需求与素材：<code>get_game_furnace</code></li>
      <li>更新需求或收集素材：<code>update_game_furnace</code></li>
      <li>创建目录并复制素材：<code>prepare_game_project</code></li>
      <li>Agent 编写并构建，登记产物：<code>submit_game</code></li>
      <li>打开静态站点，验证素材与玩法：<code>preview_game</code></li>
    </ol>
    <label>给 Agent 的指引
      <textarea readOnly rows={7} value={guide} aria-label="炼丹炉 MCP 提示词指引" />
    </label>
    <Button size="sm" disabled={!props.canvasId} onClick={() => void copy(guide, "Agent 指引")}>复制给 Agent</Button>
    <p role="status" aria-live="polite">{feedback}</p>
    <p>首次连接或未看到这些工具时，重新连接 MCP 并刷新工具列表。</p>
  </section>;
}
