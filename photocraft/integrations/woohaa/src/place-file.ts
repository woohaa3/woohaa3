/**
 * 宿主文件选择适配：置入图片 / 导入 PSD / 导出 PSD
 * （change: 2026-10-22-complete-photocraft-webui-editing，任务 4.4/4.5/5.3/5.4 / design D5/D6）。
 *
 * 三条边界：
 *
 * 1. **只做字节与选择**：不解析图像、不改文档；字节交给公共控制器入口（`placeholder`）。
 * 2. **打开文件 ≠ 置入**：`openFile` 建新文档，`placeImage` 只往**当前**文档加层。
 * 3. **PSD 交付不推进工程基线**：导出经文件端口下载；只有可信写入才允许宿主清除未保存状态，
 *    而这里只报告 `download-started`。
 */
import type { EditorFilePort } from "@woohaa3/photocraft-editor";
import { OPEN_RASTER_ACCEPT } from "@woohaa3/photocraft-protocol";

/** 置入/导入的文件选择结果。 */
export type PickedFile = { name: string; type: string; bytes: Uint8Array };

/** 打开浏览器文件选择器；取消返回 null。 */
export async function pickFile(accept: string): Promise<PickedFile | null> {
  if (typeof document === "undefined") return null;
  return new Promise<PickedFile | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;
    const finish = (value: PickedFile | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      if (!file) {
        finish(null);
        return;
      }
      void file.arrayBuffer().then(
        (buffer) => finish({ name: file.name, type: file.type, bytes: new Uint8Array(buffer) }),
        () => finish(null)
      );
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * 置入支持的类型。
 *
 * 与「打开文件」同源：`place_asset` 走内核同一套 codecs 解码（不信扩展名/MIME），因此能打开
 * 的栅格都应该能选来置入。此前这里硬编码 `image/png,image/jpeg,image/webp`，导致本 change
 * 新开放的 TIFF/GIF/BMP/TGA… 在「置入图片…」里选不中——同一个域在两处给出不同的能力清单。
 *
 * PSD 若要作为嵌入对象置入仍走「导入 PSD…」的独立入口，不混进栅格 accept。
 */
export const PLACE_IMAGE_ACCEPT = OPEN_RASTER_ACCEPT;
/** PSD 导入只接受 `.psd`（PSB 由内核在预检阶段拒绝并说明）。 */
export const PSD_IMPORT_ACCEPT = ".psd,image/vnd.adobe.photoshop";

export type PlaceOutcome =
  | { ok: true; name: string; mode: "pixel" | "smartObject" }
  | { ok: false; reason: string };

/**
 * 把选中的图片置入活动文档。
 *
 * `mode` 由调用方显式决定：默认像素层；嵌入智能对象依赖 P4 能力，失败原因原样返回。
 */
export async function placeImageFile(
  controller: {
    inspectPlace(bytes: Uint8Array): { ok: boolean; value?: unknown; message?: string };
    placeAsset(input: { name: string; bytes: Uint8Array; assetId?: string; mode?: "pixel" | "smartObject" }): { ok: boolean; message?: string };
    currentView(): { document: { width: number; height: number } | null };
  },
  file: PickedFile,
  mode: "pixel" | "smartObject" = "pixel"
): Promise<PlaceOutcome> {
  const preview = controller.inspectPlace(file.bytes);
  if (!preview.ok) return { ok: false, reason: preview.message ?? "无法读取该图片" };
  const value = preview.value as { width?: unknown; height?: unknown } | undefined;
  if (!value || typeof value.width !== "number" || typeof value.height !== "number" || value.width < 1 || value.height < 1) {
    return { ok: false, reason: "图片尺寸无效" };
  }
  const result = controller.placeAsset({
    name: file.name,
    bytes: file.bytes,
    assetId: `place-${file.name}-${file.bytes.length}`,
    mode
  });
  if (!result.ok) return { ok: false, reason: result.message ?? "置入失败" };
  return { ok: true, name: file.name, mode };
}

export type PsdImportRequest =
  | { ok: true; file: PickedFile }
  | { ok: false; reason: string };

/** 选择 PSD 并做**扩展名**预检（真实容器/版本/色彩仍由内核预检）。 */
export async function pickPsd(): Promise<PsdImportRequest> {
  const file = await pickFile(PSD_IMPORT_ACCEPT);
  if (!file) return { ok: false, reason: "已取消" };
  if (!file.name.toLowerCase().endsWith(".psd")) {
    return { ok: false, reason: "请选择 .psd 文件（PSB 不在本次范围）" };
  }
  return { ok: true, file };
}

/** PSD 导出：经文件端口交付；只报告下载已发起。 */
export async function deliverPsd(
  delivery: EditorFilePort | undefined,
  input: { bytes: Uint8Array; fileName: string }
): Promise<{ ok: boolean; status: "download-started" | "written" | "cancelled" | "failed"; message?: string }> {
  if (!delivery) return { ok: false, status: "failed", message: "当前宿主不支持文件交付" };
  const result = await delivery({ fileName: input.fileName, contentType: "image/vnd.adobe.photoshop", bytes: input.bytes });
  return result.ok ? { ok: true, status: result.status } : { ok: false, status: result.status, message: result.message };
}
