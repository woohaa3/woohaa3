/**
 * 诊断接线测试：从宿主 logger 到扩展可读缓冲，整条链路。
 *
 * 单测覆盖了投影规则；这里锁的是**装配**：application 服务把宿主诊断缓冲交给可信扩展，
 * 扩展在 `activate` 里 `host.logger` 写的事件真的会出现在 `host.diagnostics` 里。
 * 任何一环没接上，前端调试窗口都会表现为「日志永远为空」——这是最难从界面上归因的故障。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationBackendExtensionDefinition, ApplicationBackendHost } from "@woohaa3/contracts";
import { createBackendService } from "../src/composition.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "woohaa3-diagnostics-"));
  dirs.push(dir);
  return dir;
}

function memoryStorage() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
    },
    async get(key: string) {
      return objects.get(key)!;
    },
    async exists(key: string) {
      return objects.has(key);
    },
    async stat(key: string) {
      const record = objects.get(key);
      if (!record) throw new Error("missing");
      return { size: record.bytes.byteLength, contentType: record.contentType };
    },
    async getHttpsUrl(key: string) {
      return `https://cos.invalid/${key}?sign=test`;
    }
  };
}

describe("诊断缓冲接线", () => {
  it("扩展拿到 host.diagnostics，host.logger 的白名单事件可读且已脱敏", async () => {
    const dir = tempDir();
    const captured: { host: ApplicationBackendHost | null } = { host: null };
    // 不声明元数据：这个定义由 runtime 直接激活，走的是与站点插件相同的宿主实例。
    const definition: ApplicationBackendExtensionDefinition = {
      extensionId: "remote-server",
      activate: (host) => {
        captured.host = host;
      }
    };
    const service = await createBackendService({
      env: {
        WOOHAA3_CONFIG_FILE: path.join(dir, "woohaa.config.yml"),
        WOOHAA3_SECRETS_FILE: path.join(dir, "woohaa.secrets.yml"),
        WOOHAA3_TASK_STORE_PATH: path.join(dir, "task.sqlite"),
        WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
        WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(dir, "canvas.sqlite"),
        WOOHAA3_APPLICATION_STORE_PATH: path.join(dir, "application.sqlite")
      },
      logger: () => {},
      modelsConfig: { version: 1, models: [] },
      mediaStorage: memoryStorage() as never,
      enableYjsSync: false,
      applicationBackendExtensions: [definition],
      applicationExtensionMetadata: []
    });
    try {
      const host = captured.host;
      expect(host).not.toBeNull();
      expect(host?.diagnostics).toBeDefined();

      host?.logger({ event: "remote-probe-ok", serverHost: "srv.example:443" });
      host?.logger({ event: "remote-login-failed", code: "unauthenticated", message: "凭证无效", token: "session-secret" });
      // 事件名不是稳定标识时不会进入缓冲（不是「先收下再显示」）。
      host?.logger({ event: "Remote Bad Event", token: "session-secret" });

      const entries = host?.diagnostics?.snapshot() ?? [];
      const events = entries.map((entry) => entry.event);
      // 扩展激活本身也是一条该扩展的事件，允许出现在缓冲里。
      expect(events).toContain("remote-probe-ok");
      expect(events).toContain("remote-login-failed");
      expect(events).not.toContain("Remote Bad Event");

      const probe = entries.find((entry) => entry.event === "remote-probe-ok");
      // 细节走 attributes；没有主文本时 message 缺省（这里连 message 字段都不该出现）。
      expect(probe).toMatchObject({
        category: "application",
        event: "remote-probe-ok",
        attributes: { server: "srv.example:443" }
      });
      expect(probe?.message).toBeUndefined();
      const login = entries.find((entry) => entry.event === "remote-login-failed");
      expect(login).toMatchObject({ code: "unauthenticated", message: "凭证无效" });
      expect(JSON.stringify(entries)).not.toContain("session-secret");
      // 每次读取都是副本：调用方改动不会污染缓冲。
      probe!.event = "mutated";
      expect(host?.diagnostics?.snapshot().some((entry) => entry.event === "remote-probe-ok")).toBe(true);
    } finally {
      await service.close();
    }
  }, 30_000);
});
