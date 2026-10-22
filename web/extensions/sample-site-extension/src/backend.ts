/**
 * 样例插件后端入口
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.3 / design D2/D3）。
 *
 * 只依赖 `@woohaa3/contracts` 的宿主纯类型与 shared；不导入宿主内部实现。展示 typed
 * capability、受控 handler 和可 draining 的后台资源；只在测试清单中使用。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationBackendWorkHandle
} from "@woohaa3/contracts";
import { APPLICATION_EXTENSION_LOAD_ACTION } from "@woohaa3/contracts";
import { SAMPLE_SITE_EXTENSION_ID, SAMPLE_SITE_EXTENSION_METADATA } from "./shared.js";

export type SampleExtensionProbe = {
  started: boolean;
  stopped: number;
  lastWork?: ApplicationBackendWorkHandle;
  admitted: number;
};

export function createSampleSiteExtensionDefinition(probe: SampleExtensionProbe): ApplicationBackendExtensionDefinition {
  return {
    extensionId: SAMPLE_SITE_EXTENSION_ID,
    requiredDependencies: ["sample.fixture.runtime"],
    capabilities: SAMPLE_SITE_EXTENSION_METADATA.capabilities,
    activate: (host) => {
      // runtime 由依赖的 owner 提供；插件只注册自己的能力，避免覆盖依赖。
      host.registerCapability({ id: "sample.fixture.action", value: { kind: "sample-action" } });
      host.registerHandler({
        route: "sample/echo",
        auth: "authenticated",
        requiredActions: [APPLICATION_EXTENSION_LOAD_ACTION],
        handle: ({ body }) => ({ status: 200, body: { ok: true, echo: body } })
      });
      // 通过公共 Context 的受限 Task facade 提交自己拥有的非画布工作（design D3）。
      // 插件拿不到服务令牌；身份与能力由宿主裁剪。
      host.registerHandler({
        route: "sample/submit",
        auth: "authenticated",
        requiredActions: [APPLICATION_EXTENSION_LOAD_ACTION],
        handle: async ({ body }) => {
          const input = body as { workerTaskKey?: string; modelType?: string; modelKey?: string; prompt?: string };
          if (!input.workerTaskKey || !input.modelType || !input.modelKey) {
            return { status: 400, body: { ok: false, error: "缺少任务参数" } };
          }
          const result = await host.services.tasks.submit({
            workerTaskKey: input.workerTaskKey,
            modelType: input.modelType,
            modelKey: input.modelKey,
            prompt: input.prompt ?? "",
            parameters: {}
          });
          return { status: result.ok ? 202 : 502, body: result };
        }
      });
      host.registerResource({
        id: "sample.fixture.loop",
        start: () => {
          probe.started = true;
        },
        stop: () => {
          probe.started = false;
          probe.stopped += 1;
        }
      });
      return {
        dispose: () => {
          probe.stopped += 1;
        }
      };
    }
  };
}
