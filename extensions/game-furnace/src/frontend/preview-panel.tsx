/**
 * 游戏炼丹炉工作区试玩视图（extension 自有 UI，任务 8.6）
 * （change: 2026-10-10-add-game-furnace-extension）。
 *
 * 固定 build 的受控 iframe：只有用户显式点击「试玩」并拿到合法入口后才挂载；加载失败可见原因
 * 并可重试；停止后卸载 iframe（局部游戏状态随之清零）。iframe 使用 sandbox="allow-scripts"
 * 且不带 same-origin，故不读写主页面、不导航顶层。真实像素/交互见 notes/acceptance.md。
 */
import { Button } from "@woohaa3/frontend/extension-api";
import type { RefObject } from "react";

export type GameFurnacePreviewPanelProps = {
  panelRef: RefObject<HTMLElement>;
  frameRef: RefObject<HTMLIFrameElement>;
  title: string;
  frameKey: number;
  error: string | null;
  loaded: boolean;
  url: string | null;
  html: string | null;
  /** 本次会话 nonce/generation：仅注入 srcDoc 引导脚本，供受校验消息桥识别（任务 8.5）。 */
  bridgeNonce: string;
  bridgeGeneration: number;
  onStop: () => void;
  onRetry: () => void;
  onLoaded: () => void;
};

/**
 * srcDoc 引导：只上报白名单 `ready`/`error` 并携带 nonce/generation；不暴露任意命令通道。
 * sandbox 无 same-origin，`parent.postMessage` 仍可被宿主按 `event.source` 校验。
 */
function bridgeBootstrap(nonce: string, generation: number): string {
  const payload = JSON.stringify({ nonce, generation });
  return `<script>(function(){var c=${payload};function post(kind,message){try{parent.postMessage(kind==="error"?{kind:kind,message:String(message||""),nonce:c.nonce,generation:c.generation}:{kind:kind,nonce:c.nonce,generation:c.generation},"*");}catch(e){}}window.addEventListener("error",function(e){post("error",(e&&e.message)||"脚本错误");});window.addEventListener("load",function(){post("ready");});})();<\/script>`;
}

export function GameFurnacePreviewPanel(props: GameFurnacePreviewPanelProps) {
  const { panelRef, frameRef, title, frameKey, error, loaded, url, html, bridgeNonce, bridgeGeneration, onStop, onRetry, onLoaded } = props;
  // srcDoc 需要看到 nonce/generation 才能上报；静态站点入口用 URL 片段承载（不参与服务端路径解析）。
  const frameSrcDoc = !url && html ? `${bridgeBootstrap(bridgeNonce, bridgeGeneration)}${html}` : undefined;
  return (
    <section ref={panelRef} tabIndex={-1} className="game-furnace-workspace__preview" aria-label="试玩" aria-busy={!loaded && !error}>
      <div className="game-furnace-workspace__actions">
        <strong>{title}</strong>
        <Button size="sm" onClick={onStop}>停止试玩</Button>
      </div>
      {error ? <><p role="alert">{error}</p><Button size="sm" onClick={onRetry}>重试试玩</Button></> : null}
      {!loaded && !error ? <p role="status">正在加载试玩…</p> : null}
      {url || html ? (
        <iframe
          key={frameKey}
          ref={frameRef}
          title="游戏试玩"
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={url ?? undefined}
          srcDoc={frameSrcDoc}
          onLoad={onLoaded}
        />
      ) : null}
    </section>
  );
}
