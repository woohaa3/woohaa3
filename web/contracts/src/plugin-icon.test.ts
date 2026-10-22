/**
 * 插件图标词汇表：语义图形名白名单 + 品牌图形路径校验。
 *
 * 品牌图形只允许站内固定前缀 `/plugin-icons/` 下的单层图片文件名——任意 URL、协议相对地址、
 * data URI 与目录穿越都必须在契约层被拒，前端才有「插件塞不进任意地址」的性质。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import {
  PLUGIN_ICON_ASSET_PREFIX,
  PLUGIN_ICON_NAMES,
  isPluginIcon,
  isPluginIconAsset,
  isPluginIconName
} from "./plugin-icon.js";

describe("插件图标词汇表", () => {
  it("白名单里的名字都是合法图标", () => {
    for (const name of PLUGIN_ICON_NAMES) {
      expect(isPluginIconName(name), name).toBe(true);
      expect(isPluginIcon(name), name).toBe(true);
    }
  });

  it("固定前缀下的图片路径是合法品牌图形", () => {
    expect(PLUGIN_ICON_ASSET_PREFIX).toBe("/plugin-icons/");
    for (const asset of ["/plugin-icons/litellm.png", "/plugin-icons/a-b_c.1.svg", "/plugin-icons/x.webp", "/plugin-icons/y.jpeg"]) {
      expect(isPluginIconAsset(asset), asset).toBe(true);
      expect(isPluginIcon(asset), asset).toBe(true);
    }
  });

  it("拒绝任意 URL、协议相对地址、data URI、目录穿越与非图片路径", () => {
    const rejected = [
      "https://evil.example/logo.png",
      "http://evil.example/logo.png",
      "//evil.example/logo.png",
      "data:image/png;base64,AAAA",
      "/plugin-icons/../secrets.png",
      "/plugin-icons/",
      "/plugin-icons/logo.gif",
      "/plugin-icons/sub/logo.png",
      "/other/logo.png",
      "plugin-icons/logo.png",
      "/plugin-icons/a b.png",
      "/plugin-icons/logo.png?x=1",
      "/plugin-icons/litellm.png#frag",
      "litellm",
      "provider "
    ];
    for (const value of rejected) {
      expect(isPluginIconAsset(value), value).toBe(false);
      expect(isPluginIcon(value), value).toBe(false);
    }
  });
});
