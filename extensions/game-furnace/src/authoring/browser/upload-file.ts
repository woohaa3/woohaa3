import { isAllowedMediaType } from "@woohaa3/contracts";

/** Unsupported decoders retain original bytes as inert binary media. */
export function furnaceUploadFile(file: File): File {
  return isAllowedMediaType(file.type) ? file : new File([file], file.name, { type: "application/octet-stream", lastModified: file.lastModified });
}
