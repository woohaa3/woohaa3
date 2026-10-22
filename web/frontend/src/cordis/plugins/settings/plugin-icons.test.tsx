/**
 * 设置页插件图标解析：契约白名单（`PLUGIN_ICON_NAMES`）里的每个名字都要有图形，品牌图形路径
 * （`/plugin-icons/*.png`）解析成图片，未声明 / 未知名字 / 非法路径统一回退通用插件图标。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PLUGIN_ICON_NAMES } from "@woohaa3/contracts";
import { PLUGIN_ICONS, PluginIconMark, resolvePluginIcon } from "./plugin-icons.js";

describe("插件图标映射", () => {
  it("白名单里的每个名字都有图标组件，且能渲染出 svg", () => {
    for (const name of PLUGIN_ICON_NAMES) {
      const Icon = PLUGIN_ICONS[name];
      expect(Icon, `缺少 ${name} 的映射`).toBeTypeOf("function");
      expect(renderToStaticMarkup(<Icon />)).toContain("<svg");
    }
  });

  it("品牌图形路径解析成图片；未知名字与非法路径回退通用图形", () => {
    expect(resolvePluginIcon("/plugin-icons/litellm.png")).toEqual({ kind: "image", src: "/plugin-icons/litellm.png" });
    expect(resolvePluginIcon("provider")).toEqual({ kind: "glyph", Icon: PLUGIN_ICONS.provider });
    for (const fallback of [undefined, "", "not-an-icon", "https://evil.example/logo.png", "/plugin-icons/../x.png"]) {
      expect(resolvePluginIcon(fallback), String(fallback)).toEqual({ kind: "glyph", Icon: PLUGIN_ICONS.plugin });
    }
  });

  it("PluginIconMark：品牌图形渲染成图片并保留声明值与测试钩子", () => {
    const html = renderToStaticMarkup(<PluginIconMark icon="/plugin-icons/litellm.png" testId="litellm-mark" />);
    expect(html).toContain('class="plugin-card__icon is-image"');
    expect(html).toContain('data-plugin-icon="/plugin-icons/litellm.png"');
    expect(html).toContain('data-testid="litellm-mark"');
    expect(html).toContain('src="/plugin-icons/litellm.png"');
  });

  it("PluginIconMark：语义图形渲染 facade 组件，未声明时数据属性标成兜底名", () => {
    const html = renderToStaticMarkup(<PluginIconMark icon="provider" />);
    expect(html).toContain('class="plugin-card__icon"');
    expect(html).toContain('data-plugin-icon="provider"');
    expect(html).toContain("<svg");
    expect(renderToStaticMarkup(<PluginIconMark icon={undefined} />)).toContain('data-plugin-icon="plugin"');
  });
});
