/** MIME, rather than a node title or a storage URL, determines the actual extension. */
export function downloadFilename(title: string, contentType: string): string {
  const extensions: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "model/gltf-binary": "glb"
  };
  const extension = extensions[contentType.split(";")[0].trim().toLowerCase()];
  if (!extension) throw new Error("无法识别资源文件格式，请检查资源后重试");
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\.(png|jpe?g|webp|gif|avif|svg|bmp|mp4|webm|mov|glb)$/i, "")
    .trim().replace(/[. ]+$/, "").slice(0, 120) || "作品";
  return `${base}.${extension}`;
}

/** The browser owns the save prompt; temporary bytes never enter canonical canvas state. */
export function saveDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Allow the browser to begin reading the object before revoking it.
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}
