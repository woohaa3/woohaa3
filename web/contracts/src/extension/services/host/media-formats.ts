/** A custom editable-media format is owned and verified by its installed extension. */
export type MediaFormatValidator = {
  contentType: string;
  maxBytes: number;
  validate(bytes: Uint8Array, options: { maxBytes: number }): Promise<void>;
};
export type MediaFormatRegistry = {
  register(format: MediaFormatValidator): () => void;
  get(contentType: string): MediaFormatValidator | undefined;
};

/**
 * 扩展可用的媒体格式注册面（`ctx.mediaFormats`）。
 *
 * 与 `MediaFormatRegistry` 的区别：这是**按 extensionId 记账**的窄端口；宿主在插件停用/回滚时
 * 自动注销注册，扩展不需要自己找 registry，也不能注销别的扩展的格式。
 */
export type HostMediaFormatService = {
  register(format: MediaFormatValidator): () => void;
};
