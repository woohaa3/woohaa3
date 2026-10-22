/**
 * 游戏炼丹炉试玩编排 hook（任务 8.5/8.6/8.7）
 * （change: 2026-10-10-add-game-furnace-extension）。
 *
 * 把「短期只读预览会话」的生命周期从工作区组件里抽出来：开始/加载/失败/停止/重试、受校验
 * 消息桥（nonce/generation/白名单）、以及停止/切换/作用域释放时的显式会话回收。纯编排：只用
 * 注入的远端传输与画布只读 facade，不 import 宿主 store/业务实现。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ServerCanvas } from "@woohaa3/contracts";
import { toLogicalAppPath } from "@woohaa3/frontend/extension-api";
import type { GameFurnaceRemote } from "./remote.js";
import { remoteFailureMessage } from "./remote.js";
import { createPreviewNonce, previewEntryWithBridge, validatePreviewBridgeMessage } from "./preview-bridge.js";

export const GAME_FURNACE_PREVIEW_START_TIMEOUT_MS = 15_000;

export type GameFurnacePreviewController = {
  buildId: string | null;
  html: string | null;
  url: string | null;
  loaded: boolean;
  error: string | null;
  bridge: { nonce: string; generation: number } | null;
  panelRef: RefObject<HTMLElement>;
  frameRef: RefObject<HTMLIFrameElement>;
  frameKey: number;
  play: (buildId: string) => Promise<void>;
  stop: () => void;
  /** 仅用于受校验消息到达时标记就绪。 */
  markLoaded: () => void;
};

export function useGameFurnacePreview(options: {
  client: GameFurnaceRemote;
  canvas: () => ServerCanvas | null;
  nodeId: string | null;
  /** 当前画布 id（用于切换时释放旧会话）。 */
  canvasId: string | undefined;
  captureValidity: () => (() => boolean);
  stillCurrent: (canvasId: string, nodeId: string, write?: boolean) => boolean;
}): GameFurnacePreviewController {
  const { client, canvas, nodeId, canvasId, stillCurrent, captureValidity } = options;
  const [html, setHtml] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  // 任务 8.5：每次试玩新 nonce；generation 与 iframe key 一致，旧版本/其它 iframe 消息失效。
  const [bridge, setBridge] = useState<{ nonce: string; generation: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const generation = useRef(0);
  /** 当前短期只读预览会话 id（任务 8.7：停止/退出/切换时显式释放）。 */
  const session = useRef<string | null>(null);

  /** 释放当前会话（幂等）并返回其 id。 */
  const releaseSession = useCallback(() => {
    const sessionId = session.current;
    session.current = null;
    if (sessionId) void client.previewClose({ sessionId });
  }, [client]);

  const play = useCallback(async (targetBuildId: string) => {
    const current = canvas();
    if (!current || !nodeId) return;
    const valid = captureValidity();
    const token = ++generation.current;
    releaseSession();
    setExpiresAt(null);
    setBuildId(targetBuildId);
    setError(null);
    setHtml(null);
    setUrl(null);
    setLoaded(false);
    const nonce = createPreviewNonce();
    setBridge({ nonce, generation: token });
    const opened = await client.previewOpen({ canvasId: current.id, nodeId, buildId: targetBuildId });
    if (token !== generation.current || !stillCurrent(current.id, nodeId) || !valid()) {
      // The request may create a session after stop/unmount already ran. Close
      // that returned session directly, without touching any newer preview.
      if (opened.ok) {
        const staleSession = opened.value.sessionId;
        if (typeof staleSession === "string" && staleSession) void client.previewClose({ sessionId: staleSession });
      }
      return;
    }
    if (!opened.ok) {
      setError(`打开试玩失败：${remoteFailureMessage(opened)}`);
      return;
    }
    const openedSession = (opened.value as { sessionId?: string }).sessionId;
    if (typeof openedSession === "string" && openedSession !== "") session.current = openedSession;
    if (typeof opened.value.expiresAt === "number" && Number.isFinite(opened.value.expiresAt)) setExpiresAt(opened.value.expiresAt);
    const entryUrl = opened.value.entryUrl;
    if (typeof entryUrl === "string") {
      if (!/^\/api\/extensions\/game-furnace\/site\/[a-f0-9]{64}\/index\.html$/.test(toLogicalAppPath(entryUrl))) { setError("试玩入口无效，请重试"); return; }
      setUrl(previewEntryWithBridge(entryUrl, nonce, token));
      return;
    }
    // preview-open 已返回组装好的入口，避免为同一次试玩重复请求会话。
    if (typeof opened.value.html === "string" && opened.value.html.trim()) {
      setHtml(opened.value.html);
      return;
    }
    const sessionId = (opened.value as { sessionId?: string }).sessionId;
    if (!sessionId) {
      setError("试玩会话无效，请重试");
      return;
    }
    const described = await client.previewDescribe({ sessionId });
    if (token !== generation.current || !stillCurrent(current.id, nodeId) || !valid()) return;
    if (!described.ok) {
      setError(`组装试玩失败：${remoteFailureMessage(described)}`);
      return;
    }
    const describedHtml = (described.value as { html?: string }).html;
    if (typeof describedHtml !== "string" || !describedHtml.trim()) {
      setError("试玩内容为空，请重试或重新提交游戏代码");
      return;
    }
    setHtml(describedHtml);
  }, [canvas, nodeId, client, stillCurrent, captureValidity, releaseSession]);

  const stop = useCallback(() => {
    generation.current += 1;
    // 任务 8.7：显式释放短期只读会话，回收固定资源与入口；失败不阻塞 UI 释放。
    releaseSession();
    setHtml(null);
    setUrl(null);
    setLoaded(false);
    setBuildId(null);
    setError(null);
    setBridge(null);
    setExpiresAt(null);
  }, [releaseSession]);

  useEffect(() => {
    // 任务 8.7：切换节点/画布时释放旧的短期只读会话。
    generation.current += 1;
    releaseSession();
    setHtml(null);
    setUrl(null);
    setLoaded(false);
    setBuildId(null);
    setError(null);
    setBridge(null);
    setExpiresAt(null);
  }, [nodeId, canvasId, releaseSession]);

  useEffect(() => {
    // 任务 8.7：作用域释放时关闭短期只读会话，不自动恢复旧游戏。
    return () => { generation.current += 1; releaseSession(); };
  }, [releaseSession]);

  useEffect(() => {
    if (buildId) panelRef.current?.focus();
  }, [buildId]);

  useEffect(() => {
    if (!buildId || expiresAt === null) return;
    const timer = window.setTimeout(() => {
      generation.current += 1;
      releaseSession();
      setHtml(null); setUrl(null); setLoaded(false); setBridge(null); setExpiresAt(null);
      setError("试玩会话已过期，请重新开始试玩。");
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [buildId, expiresAt, releaseSession]);

  useEffect(() => {
    if (!buildId || loaded || error) return;
    const timer = window.setTimeout(() => {
      generation.current += 1;
      releaseSession();
      setHtml(null);
      setUrl(null);
      setError("试玩启动超时。页面脚本可能占用主线程；可停止或重试，浏览器不保证立即回收执行资源。");
    }, GAME_FURNACE_PREVIEW_START_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [buildId, loaded, error, releaseSession]);

  // 任务 8.5：受校验消息桥。只接受来自当前 iframe 且 nonce/generation 匹配的白名单消息；
  // 其它 iframe、旧版本或任意命令一律忽略，不产生副作用。
  useEffect(() => {
    if (!bridge) return;
    const listener = (event: MessageEvent) => {
      const message = validatePreviewBridgeMessage(
        { source: event.source, data: event.data },
        { frameWindow: frameRef.current?.contentWindow ?? null, nonce: bridge.nonce, generation: bridge.generation }
      );
      if (!message) return;
      if (message.kind === "ready") { setLoaded(true); return; }
      if (message.kind === "error") { setError(message.message ? `游戏运行错误：${message.message}` : "游戏运行出错"); return; }
      // size 目前只接受并忽略：iframe 尺寸由宿主布局控制，不接受页面自行撑开。
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [bridge]);

  return {
    buildId, html, url, loaded, error, bridge,
    panelRef, frameRef, frameKey: generation.current,
    play, stop, markLoaded: () => setLoaded(true)
  };
}
