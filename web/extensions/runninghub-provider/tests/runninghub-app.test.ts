/**
 * RunningHub App 专用交互测试（extension 前端 owner）
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.2；
 *   change: 2026-10-10-extract-optional-feature-extensions，任务 3.1：由宿主
 *   `cordis/plugins/task-execution/runninghub-app-plugin.test.ts` 迁入）。
 *
 * 覆盖：server-active 入口描述、以包稳定 identity 注册 `runninghub-app@1`、dispose 释放注册。
 * Registry 语义（精确 id+version、重复拒绝、排序、subscribe）由宿主
 * `cordis/services/model-interaction-service.test.ts` 覆盖。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelInteractionDefinition } from "@woohaa3/frontend/extension-api";
import { descriptor } from "../src/frontend/index.js";
import {
  runningHubAppInteractionExtension,
  RUNNINGHUB_APP_INTERACTION_ID,
  RUNNINGHUB_APP_INTERACTION_VERSION
} from "../src/frontend/plugin.js";

function fakeRegistry() {
  const registered: ModelInteractionDefinition[] = [];
  const disposers: Array<() => void> = [];
  return {
    registered,
    register(definition: ModelInteractionDefinition) {
      registered.push(definition);
      let done = false;
      const dispose = () => {
        if (done) return;
        done = true;
        const index = registered.indexOf(definition);
        if (index >= 0) registered.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
    resolve: () => null,
    list: () => [],
    subscribe: () => () => undefined
  };
}

describe("RunningHub App interaction（任务 3.1）", () => {
  it("server-active 入口使用包稳定 identity，不另建独立开关 extension", () => {
    expect(descriptor.extensionId).toBe("runninghub-provider");
    expect(descriptor.configScope).toBe("site");
    expect(descriptor.activation).toBe("server-active");
    expect(descriptor.required).not.toBe(true);
  });

  it("激活时以 owner=runninghub-provider 注册 runninghub-app@1，dispose 释放", () => {
    const registry = fakeRegistry();
    const effects: Array<() => void> = [];
    const ctx = {
      modelInteractions: registry,
      effect: (factory: () => () => void) => {
        effects.push(factory());
      }
    };
    runningHubAppInteractionExtension()(ctx as never);

    expect(registry.registered).toHaveLength(1);
    const definition = registry.registered[0]!;
    expect(definition.id).toBe(RUNNINGHUB_APP_INTERACTION_ID);
    expect(definition.version).toBe(RUNNINGHUB_APP_INTERACTION_VERSION);
    expect(definition.owner).toBe("runninghub-provider");

    for (const dispose of effects) dispose();
    expect(registry.registered).toHaveLength(0);
  });

  it("前端入口不静态 import Provider/后端实现（浏览器构建边界）", () => {
    for (const name of ["index.ts", "plugin.tsx", "runninghub-app-panel.tsx"]) {
      const file = fileURLToPath(new URL(`../src/frontend/${name}`, import.meta.url));
      const source = readFileSync(file, "utf8");
      expect(source, name).not.toMatch(/@sdppp\/pptask|\.\.\/backend/);
    }
  });
});
