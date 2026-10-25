/**
 * OAuth provider 列表驱动注册
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 9.6 / design D11）。
 *
 * 验证扩展按 provider 列表组织：ChatGPT 是其中一项，线路标识（`providerId`/`routePrefix`）稳定，
 * 公开路由由 `routePrefix` 派生，新增 provider 无需改动路由代码。
 */
import { describe, expect, it } from "vitest";
import { OAUTH_AGENT_PROVIDERS } from "../src/shared.js";
import { oauthProviderRouteRegistrations } from "../src/backend/index.js";

describe("OAuth provider 列表（任务 9.6）", () => {
  it("ChatGPT 是列表项，线路标识与标签稳定", () => {
    const chatgpt = OAUTH_AGENT_PROVIDERS.find((provider) => provider.providerId === "chatgpt");
    expect(chatgpt).toBeDefined();
    expect(chatgpt!.label).toBe("ChatGPT（OAuth）");
    expect(chatgpt!.routePrefix).toBe("oauth-agent");
  });

  it("路由按 provider 的 routePrefix 生成", () => {
    for (const provider of OAUTH_AGENT_PROVIDERS) {
      const routes = oauthProviderRouteRegistrations(provider);
      const prefix = provider.routePrefix;
      expect(routes.map((entry) => `${entry.method} ${entry.route}`)).toEqual([
        `GET ${prefix}`,
        `GET ${prefix}/*`,
        `POST ${prefix}/generate`,
        `POST ${prefix}/cancel`,
        `POST ${prefix}/authorize/cancel`,
        `POST ${prefix}/authorize/start`,
        `POST ${prefix}/authorize/complete`,
        `POST ${prefix}/disconnect`,
        `POST ${prefix}/*`
      ]);
      const generate = routes.find((entry) => entry.route === `${prefix}/generate`)!;
      expect(generate.purpose).toBe("new-work");
      expect(generate.streamBudget).toMatchObject({ deadlineMs: 0, maxEvents: Number.POSITIVE_INFINITY, maxBytes: Number.POSITIVE_INFINITY });
    }
  });

  it("新增一个 provider 会得到同一组同构路由（扩展点）", () => {
    const routes = oauthProviderRouteRegistrations({ providerId: "acme", label: "Acme（OAuth）", routePrefix: "acme" });
    expect(routes[0]).toMatchObject({ route: "acme", method: "GET", purpose: "read" });
    expect(routes.some((entry) => entry.route === "acme/generate")).toBe(true);
  });
});
