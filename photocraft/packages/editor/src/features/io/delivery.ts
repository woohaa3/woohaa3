/**
 * 交付动作（change: 2026-10-22-add-photocraft-raster-interchange，design D3）。
 *
 * 导出/逐层/资产产出的都是内存字节；落盘由宿主负责。独立 dev 里没有本机文件端口，因此这里
 * 提供**浏览器下载**这一条路径，并明确它只表示「下载已发起」，**不**表示已写入磁盘（与
 * `EditorFilePort` 的 `download-started` 同义，不得据此推进保存基线）。
 *
 * DOM 依赖全部经 `DeliveryEnvironment` 注入，纯逻辑可在 node 下测试。
 */
export type DeliveryFile = { fileName: string; contentType: string; bytes: Uint8Array };

export type DeliveryEnvironment = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** 触发下载；`fileName` 由我们给出，宿主/浏览器不得改写内容。 */
  trigger(url: string, fileName: string): void;
};

export type DeliveryOutcome =
  | { ok: true; status: "download-started"; fileName: string; bytes: number }
  | { ok: false; status: "cancelled" | "failed"; message: string };

const defaultEnvironment = (): DeliveryEnvironment | null => {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  return {
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    trigger: (url, fileName) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.rel = "noopener";
      link.click();
    }
  };
};

/**
 * 发起一次下载。
 *
 * - 空文件名或空字节**拒绝**（不产生 0 字节的「交付」）；
 * - 下载发起后立即释放 URL，不把 blob 生命周期绑到组件；
 * - 环境不支持（无 DOM/无 `URL.createObjectURL`）时返回失败原因，而不是静默什么都不做。
 */
export function startDownload(file: DeliveryFile, environment: DeliveryEnvironment | null = defaultEnvironment()): DeliveryOutcome {
  if (!file.fileName.trim()) return { ok: false, status: "failed", message: "缺少交付文件名" };
  if (file.bytes.length === 0) return { ok: false, status: "failed", message: "交付内容为空，未发起下载" };
  if (!environment) return { ok: false, status: "failed", message: "当前环境不支持浏览器下载；请使用宿主的本地文件端口交付" };
  let url: string | null = null;
  try {
    // 复制字节：调用方后续修改不能影响已发起的内容。
    url = environment.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: file.contentType }));
    environment.trigger(url, file.fileName);
  } catch (error) {
    if (url) environment.revokeObjectURL(url);
    return { ok: false, status: "failed", message: error instanceof Error ? error.message : "下载失败" };
  }
  environment.revokeObjectURL(url);
  return { ok: true, status: "download-started", fileName: file.fileName, bytes: file.bytes.length };
}

/** 预览用的对象 URL（调用方负责在替换预览时释放旧的）。 */
export function previewObjectUrl(bytes: Uint8Array, contentType: string, environment: DeliveryEnvironment | null = defaultEnvironment()): string | null {
  if (bytes.length === 0 || !environment) return null;
  return environment.createObjectURL(new Blob([new Uint8Array(bytes)], { type: contentType }));
}
