import { getRuntimeComponentManager, type RuntimeComponentManager } from "@woohaa3/runtime-components";
import { createRendererClient, type RendererClient, type RendererClientOptions } from "./client.js";

/** Resolves each operation lazily so installation and source changes need no host restart. */
export function createManagedRendererClient(options: {
  getManager?: () => RuntimeComponentManager | undefined;
  createClient?: (options: RendererClientOptions) => RendererClient;
} = {}): RendererClient {
  const getManager = options.getManager ?? getRuntimeComponentManager;
  const createClient = options.createClient ?? createRendererClient;
  const active = new Set<RendererClient>();
  let closed = false;
  return {
    // This synchronous capability reports whether lazy resolution is supported. Missing
    // components are reported by render(), without networking during health checks.
    available: () => !closed && Boolean(getManager()),
    async render(request) {
      if (closed) return { ok: false, code: "renderer-unavailable", message: "模型渲染器已关闭" };
      const manager = getManager();
      if (!manager) return { ok: false, code: "renderer-unavailable", message: "当前环境未配置模型渲染器" };
      let handle;
      try { handle = await manager.resolve("model-renderer"); }
      catch (error) { return { ok: false, code: "renderer-unavailable", message: `请在设置 → 运行时组件中下载模型渲染组件。${error instanceof Error ? error.message : ""}` }; }
      if (closed) { handle.release(); return { ok: false, code: "renderer-unavailable", message: "模型渲染器已关闭" }; }
      let client: RendererClient | undefined;
      try {
        client = createClient({ command: handle.entry });
        active.add(client);
        return await client.render(request);
      } finally {
        try { if (client) await client.close(); }
        finally { if (client) active.delete(client); handle.release(); }
      }
    },
    async close() {
      closed = true;
      await Promise.all([...active].map((client) => client.close()));
    }
  };
}
