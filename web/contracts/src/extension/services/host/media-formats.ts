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
