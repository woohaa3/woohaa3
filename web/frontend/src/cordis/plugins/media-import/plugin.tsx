/**
 * Media Import Plugin（change: adopt-frontend-cordis-plugin-runtime，design D5；
 * change: add-paste-import-workflows，design D1）。
 *
 * 提供 `importService` 能力：本地文件 → Media Remote 上传 → Canvas Session 原子命令。
 * 文件选择、paste 与 drop 都复用同一批量 coordinator；本插件负责文件选择入口与状态叠加层。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { useSyncExternalStore } from "react";
import { MediaImportService } from "./service.js";
import { definePlugin } from "../../plugin.js";
import { Button } from "@woohaa3/ui/primitives";
import type { ImportAnchor, ImportService, ImportState } from "../../contracts.js";

export const MEDIA_IMPORT_PLUGIN_ID = "media-import";

/** 上传中/失败状态叠加层（原来由 App 直接渲染）。 */
function ImportStatusOverlay({ service }: { service: ImportService }) {
  const state = useSyncExternalStore(service.subscribe, service.getState, service.getState);
  const failed = state.items.filter((item) => item.stage === "failed");
  if (!state.uploading && !state.error && failed.length === 0) return null;
  return (
    <>
      {state.uploading ? (
        <div className="persist-status" role="status" style={{ top: 52 }}>
          正在上传…
        </div>
      ) : null}
      {failed.length > 0 ? (
        <ul className="canvas-context-menu__error" role="alert" style={{ top: 52 }}>
          {failed.map((item) => (
            <li key={item.id}>
              {item.name}：{item.error ?? "导入失败"}
              <Button size="sm" onClick={() => void service.retryItem(item.id)}>
                重试
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {state.error && failed.length === 0 ? (
        <p className="canvas-context-menu__error" role="alert">
          {state.error}
        </p>
      ) : null}
    </>
  );
}

export const mediaImportExtension: Plugin.Function<void> = definePlugin(
  (ctx: Context) => {
    const service = new MediaImportService(ctx);
    ctx.provide("importService" as never, service as never);

    const removeOverlay = ctx.slots.register("canvas.overlay", {
      id: "media-import-status",
      owner: MEDIA_IMPORT_PLUGIN_ID,
      priority: 0,
      render: () => <ImportStatusOverlay service={service} />
    });

    return () => {
      removeOverlay();
      service.dispose();
    };
  },
  { name: MEDIA_IMPORT_PLUGIN_ID, inject: ["mediaRemote", "canvasSession", "canvasRuntime", "canvasScope", "slots"] }
);

export type { ImportAnchor, ImportState };
