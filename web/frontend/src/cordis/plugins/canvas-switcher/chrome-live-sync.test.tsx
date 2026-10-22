/**
 * 画布切换器触发器的**实时连接态**测试
 * （change: 2026-10-21-recover-canvas-connection-explicitly）。
 *
 * 目录快照（`CanvasSummary.sync`）回答「本机↔远端存储同步到哪一步」，可能已经过期：
 * 画布连接被服务端关闭后它仍写着「已同步」。触发器必须以当前会话为准，否则顶栏胶囊会和
 * 右下角同步气泡说两套话。单独成文件：`chrome.test.tsx` 已接近单文件行数守卫上限。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasSwitcherTrigger } from "./chrome.js";
import type { CanvasSummary } from "../../contract/canvas-catalog.js";
import type { CanvasNavigationService } from "../../navigation/index.js";

const navigation = {
  subscribe: () => () => undefined,
  getSnapshot: () => ({ mode: { type: "overview" }, panel: null, menu: null })
} as unknown as CanvasNavigationService;

/** 渲染触发器：`live` 省略表示未注入实时态（只看目录快照）。 */
function renderTrigger(
  live: "offline" | "connecting" | "ready" | undefined,
  sync?: CanvasSummary["sync"]
): string {
  return renderToStaticMarkup(
    <CanvasSwitcherTrigger
      getTitle={() => "我的画布"}
      getSync={() => sync}
      {...(live === undefined ? {} : { getLiveSync: () => live })}
      subscribeTitle={() => () => undefined}
      onOpen={() => undefined}
      navigation={navigation}
    />
  );
}

describe("CanvasSwitcherTrigger 实时连接态", () => {
  it("会话离线时胶囊显示「离线只读」：压过目录快照的「已同步」", () => {
    // 目录快照可能过期：服务端断开后它仍写着「已同步」，胶囊不能再跟着说。
    const markup = renderTrigger("offline", "synced");
    expect(markup).toContain("离线只读");
    expect(markup).toContain('data-sync="offline"');
    expect(markup).not.toContain("已同步");
    // aria-label 同步带上实时态，而不是只报目录状态。
    expect(markup).toContain("画布连接已断开，只读");
    // 目录尚无条目（sync 未知）时，实时态自己就能撑起胶囊。
    expect(renderTrigger("offline", undefined)).toContain("离线只读");
  });

  it("会话在建连时胶囊显示「连接中」，不显示目录标签", () => {
    const markup = renderTrigger("connecting", "local-only");
    expect(markup).toContain("连接中");
    // 连接中沿用目录「同步中」的视觉相位，不新增一套配色。
    expect(markup).toContain('data-sync="syncing"');
    expect(markup).toContain("正在连接画布服务");
    expect(markup).not.toContain("仅本机");
  });

  it("连接就绪时维持目录标签（实时态 ready 不额外加词）", () => {
    expect(renderTrigger("ready", "synced")).toContain("已同步");
    expect(renderTrigger("ready", "syncing")).toContain("同步中");
    expect(renderTrigger("ready", "local-only")).toContain("仅本机");
    // 纯本地部署（目录没有条目的同步结论）时不凭空造一个胶囊。
    expect(renderTrigger("ready", undefined)).not.toContain("canvas-switcher-trigger__sync");
  });
});
