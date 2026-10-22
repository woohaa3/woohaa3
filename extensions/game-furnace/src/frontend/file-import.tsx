import { furnaceUploadFile } from "./upload-file.js";
/**
 * 游戏炼丹炉工作区文件导入（extension 自有）
 * （change: 2026-10-10-add-game-furnace-extension，任务 4.7/4.9）。
 *
 * 把操作系统文件经**宿主注入**的 `MediaRemoteService.upload` 上传为稳定资产，再把
 * `asset.upsert` + `resources.add` 一次原子交给工作区（经受保护会话提交）。本组件：
 * - 上传进行态（进度）、失败原因与逐项重试**可见**；失败不写假成功素材；
 * - 只在上传成功且拿到稳定引用后才关联项目，`File`/Blob/临时 URL 不进入规范项目；
 * - 不 import 宿主 store/后端实现，只消费公开 extension-api 类型。
 */
import { useRef, useState } from "react";
import type { MediaRemoteService } from "@woohaa3/frontend/extension-api";
import { Button } from "@woohaa3/frontend/extension-api";
import { createHighEntropyId, type Woohaa3CanvasJsonObject } from "@woohaa3/contracts";
import {
  planUploadedResourceCollection,
  uploadStatusLabel,
  type GameFurnaceUploadItem,
  type UploadedFileMedia
} from "../collection.js";

/** 不过滤文件选择；无 decoder 的 MIME 通过惰性 binary 上传保留原件。 */
export const FURNACE_UPLOAD_ACCEPT = "";

/** 单次上传结果：由工作区完成真实的项目关联（收集 + 关联写回）。 */
export type GameFurnaceCollectResult = { ok: true } | { ok: false; message: string };

export type GameFurnaceFileImportProps = {
  writable: boolean;
  mediaRemote: MediaRemoteService;
  /** 上传成功后，把原子操作交给工作区收集；失败返回安全可读原因。 */
  onCollect: (operations: readonly Woohaa3CanvasJsonObject[]) => Promise<GameFurnaceCollectResult>;
};

export function GameFurnaceFileImport(props: GameFurnaceFileImportProps) {
  const { writable, mediaRemote, onCollect } = props;
  const [items, setItems] = useState<GameFurnaceUploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  /** 页面存活期内的 File 句柄，供失败项重试（不持久化，不进入规范项目）。 */
  const handles = useRef(new Map<string, File>());
  const counter = useRef(0);

  const update = (id: string, patch: Partial<GameFurnaceUploadItem>) => {
    setItems((previous) => previous.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const importFile = async (id: string, file: File): Promise<void> => {
    update(id, { stage: "uploading", progress: 0, error: undefined });
    const uploaded = await mediaRemote.upload({
      file: furnaceUploadFile(file),
      onProgress: (percent) => update(id, { progress: percent })
    });
    if (!uploaded.ok) {
      update(id, { stage: "failed", progress: undefined, error: uploaded.error });
      return;
    }
    const media: UploadedFileMedia = {
      storageKey: uploaded.media.storageKey,
      checksum: uploaded.media.checksum,
      contentType: uploaded.media.contentType,
      size: uploaded.media.size,
      ...(uploaded.media.url ? { url: uploaded.media.url } : {})
    };
    const plan = planUploadedResourceCollection({
      resourceId: createHighEntropyId("res-upload"),
      assetId: `asset-upload-${uploaded.media.checksum}`,
      file: { name: file.name, type: file.type, size: file.size },
      media
    });
    if (!plan) {
      update(id, { stage: "failed", progress: undefined, error: "上传结果不完整，未关联素材" });
      return;
    }
    const collected = await onCollect(plan.operations);
    if (!collected.ok) {
      update(id, { stage: "failed", progress: undefined, error: collected.message });
      return;
    }
    handles.current.delete(id);
    update(id, { stage: "done", progress: undefined, error: undefined });
  };

  const importFiles = async (files: File[]): Promise<void> => {
    if (!writable || files.length === 0) return;
    const created = files.map((file) => {
      const id = `upload-${Date.now().toString(36)}-${(counter.current += 1)}`;
      handles.current.set(id, file);
      return { id, name: file.name || "(未命名文件)", stage: "pending" as const };
    });
    setItems((previous) => [...previous, ...created]);
    setBusy(true);
    try {
      for (let index = 0; index < files.length; index += 1) {
        await importFile(created[index]!.id, files[index]!);
      }
    } finally {
      setBusy(false);
    }
  };

  const retry = async (item: GameFurnaceUploadItem): Promise<void> => {
    const file = handles.current.get(item.id);
    if (!file) {
      update(item.id, { error: "文件已不可用，请重新选择" });
      return;
    }
    setBusy(true);
    try {
      await importFile(item.id, file);
    } finally {
      setBusy(false);
    }
  };

  const failed = items.filter((item) => item.stage === "failed");

  return (
    <div className="game-furnace-workspace__file-import" aria-label="添加文件素材"
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = writable && !busy ? "copy" : "none"; } }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); if (writable && !busy) void importFiles([...event.dataTransfer.files]); } }}>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={FURNACE_UPLOAD_ACCEPT}
        data-game-furnace-file-input="true"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void importFiles(files);
        }}
      />
      <div className="game-furnace-workspace__actions">
        <Button size="sm" disabled={!writable || busy} onClick={() => input.current?.click()}>
          添加文件
        </Button>
        {busy ? <span role="status">正在上传文件…</span> : null}
      </div>
      {items.length > 0 ? (
        <ul className="game-furnace-workspace__uploads">
          {items.map((item) => (
            <li key={item.id} data-upload-stage={item.stage}>
              <span role={item.stage === "failed" ? "alert" : "status"}>{uploadStatusLabel(item)}</span>
              {item.stage === "uploading" && typeof item.progress === "number" ? (
                <progress max={100} value={item.progress} aria-label={`${item.name} 上传进度`} />
              ) : null}
              {item.stage === "failed" ? (
                <Button size="sm" disabled={busy} onClick={() => void retry(item)}>重试</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {failed.length > 0 ? <p role="status">有 {failed.length} 个文件未添加；可重试或重新选择文件。</p> : null}
    </div>
  );
}
