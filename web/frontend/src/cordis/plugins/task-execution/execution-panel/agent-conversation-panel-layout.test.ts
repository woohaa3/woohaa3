/**
 * Agent 对话详情头部布局回归
 * （change: 2026-10-12-add-agent-conversation-panel，design D6a）。
 *
 * 实机缺陷：片场聚焦里打开对话详情后，头部只看得到「清空上下文」，「返回生成面板」不见了。
 * 根因不在 DOM（该按钮无条件渲染），而在 CSS 收缩：会话标题取首条提示词、可能很长，头部
 * 只有标题与动作两个 flex 项，两者按比例收缩，动作行被压到小于自身内容，第二个按钮溢出面板
 * 右边界；详情侧栏贴右（`right: var(--focus-rail)`），`body{overflow:hidden}` 直接把它裁掉。
 * 真实 Chromium 几何测量（长标题、面板 320/270/220/400px）：修复前 `返回生成面板` 右缘超出
 * 面板 114/114/114/96px，修复后为 0。
 *
 * jsdom 不会根据 import 的 CSS 计算布局（同 `prompt-max-height.test.ts`），这里按既有守卫
 * 约定直接读样式源，断言「只有标题吸收收缩、动作行不被压缩、极窄面板换行而不是裁掉入口」。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(
  fileURLToPath(new URL("./agent-conversation-panel.css", import.meta.url)),
  "utf8",
);

/** 取出匹配选择器后第一个声明块的内容。 */
function ruleBody(selector: string): string {
  const match = CSS.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`未找到规则：${selector}`);
  return match[1];
}

describe("Agent 对话详情头部布局（长标题不得挤掉返回入口）", () => {
  it("头部允许换行：极窄面板下动作整行换行，而不是被挤出可视区", () => {
    expect(ruleBody(".agent-detail__header")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("只有标题吸收收缩（flex: 1 1 0），长标题以省略号呈现", () => {
    const title = ruleBody(".agent-detail__title");
    expect(title).toMatch(/flex:\s*1\s+1\s+0/);
    expect(title).toMatch(/min-width:\s*0/);
    expect(title).toMatch(/overflow:\s*hidden/);
    expect(title).toMatch(/text-overflow:\s*ellipsis/);
    expect(title).toMatch(/white-space:\s*nowrap/);
  });

  it("动作行不被压缩：flex-shrink 0", () => {
    expect(ruleBody(".agent-detail__actions")).toMatch(/flex-shrink:\s*0/);
  });

  it("清空上下文与返回生成面板两个按钮本身也不被压缩", () => {
    expect(ruleBody(".agent-detail__clear")).toMatch(/flex-shrink:\s*0/);
    expect(ruleBody(".agent-detail__back")).toMatch(/flex-shrink:\s*0/);
  });

  it("聚焦态详情填充公共侧栏容器（宽度由容器给出，不叠加第二栏）", () => {
    const body = ruleBody(".app[data-focus-kind] .agent-detail");
    expect(body).toMatch(/position:\s*static/);
    expect(body).toMatch(/width:\s*100%/);
  });
});
