/**
 * 通用扩展节点模板菜单合并测试
 * （change: 2026-10-10-add-game-furnace-extension，任务 2.4/2.6）。
 *
 * 宿主 `canvas-menu` 只按通用节点契约把 `canvas.node-template` 贡献合并为菜单项：
 * - 缺省 section「创作工具」、缺省 order 排在内置创作工具项之后；
 * - `createNodeData()` 返回 undefined 或抛错的模板不产生菜单项（扩展未就绪时不可见）；
 * - 只读时禁用；与内置菜单项一起经 section/order 规范化排序。
 */
import { describe, expect, it } from "vitest";
import { CANVAS_MENU_SECTION, normalizeCanvasMenuSections } from "@woohaa3/contracts";
import {
  EXTENSION_NODE_TEMPLATE_ITEM_PREFIX,
  extensionNodeTemplateMenuItems,
  type ExtensionNodeTemplateContribution
} from "./plugin.js";

const context = { nodeId: null, screen: { x: 0, y: 0 }, world: { x: 0, y: 0 }, writable: true } as const;

function contribution(overrides: Partial<ExtensionNodeTemplateContribution> = {}): ExtensionNodeTemplateContribution {
  return {
    id: "game-furnace-node",
    label: "游戏炼丹炉",
    nodeType: "composite-asset",
    createNodeData: () => ({ title: "游戏炼丹炉", modelScript: "scene.group({ id: 'root' });" }),
    ...overrides
  };
}

describe("extensionNodeTemplateMenuItems（任务 2.4/2.6）", () => {
  it("把已就绪模板合并为创作工具项，ID 前缀稳定（缺省 order 排在内置项之后）", () => {
    const items = extensionNodeTemplateMenuItems([contribution()], true, context);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: `${EXTENSION_NODE_TEMPLATE_ITEM_PREFIX}game-furnace-node`,
      label: "游戏炼丹炉",
      section: CANVAS_MENU_SECTION.creationTools,
      order: 100,
      disabled: false
    });
  });

  it("贡献声明的 section/order 被保留（扩展显式 order 1 紧随导演场）", () => {
    const items = extensionNodeTemplateMenuItems([contribution({ order: 1 })], true, context);
    expect(items[0]).toMatchObject({ order: 1, section: CANVAS_MENU_SECTION.creationTools });
  });

  it("createNodeData 返回 undefined 或抛错的模板不产生菜单项（扩展未就绪不可见）", () => {
    const items = extensionNodeTemplateMenuItems(
      [
        contribution({ id: "not-ready", createNodeData: () => undefined }),
        contribution({ id: "broken", createNodeData: () => { throw new Error("boom"); } }),
        contribution({ id: "ready" })
      ],
      true,
      context
    );
    expect(items.map((item) => item.id)).toEqual([`${EXTENSION_NODE_TEMPLATE_ITEM_PREFIX}ready`]);
  });

  it("只读时禁用扩展节点模板项", () => {
    const items = extensionNodeTemplateMenuItems([contribution()], false, context);
    expect(items[0]?.disabled).toBe(true);
  });

  it("与内置创作工具项一起经 section/order 规范化排序（紧随导演场）", () => {
    const items = normalizeCanvasMenuSections([
      { id: "insert:image", label: "图片", section: CANVAS_MENU_SECTION.basicMaterial },
      { id: "insert:animation3d", label: "导演场", section: CANVAS_MENU_SECTION.creationTools, order: 0 },
      ...extensionNodeTemplateMenuItems([contribution()], true, context),
      { id: "upload", label: "上传…", section: CANVAS_MENU_SECTION.other }
    ]);
    const ids = items.map((item) => item.id);
    // 创作工具：导演场在前，扩展节点模板紧随其后。
    expect(ids.indexOf("insert:animation3d")).toBeLessThan(ids.indexOf(`${EXTENSION_NODE_TEMPLATE_ITEM_PREFIX}game-furnace-node`));
    // section 顺序：基础素材 → 创作工具 → 其他。
    expect(ids.indexOf("insert:image")).toBeLessThan(ids.indexOf("insert:animation3d"));
    expect(ids.indexOf(`${EXTENSION_NODE_TEMPLATE_ITEM_PREFIX}game-furnace-node`)).toBeLessThan(ids.indexOf("upload"));
  });
});
