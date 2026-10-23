import type { EditorInstance, EditorResult } from "../editor-wasm.js";

/** The shared error/resource boundary; adapters never own another WASM instance. */
export interface FeatureHandleContext {
  readonly instance: EditorInstance;
  call<T>(run: (instance: EditorInstance) => T): EditorResult<T>;
}

/** A draft belongs to one document generation and one attempt. */
export type FeatureOwner = {
  documentId: string;
  generation: number;
  attemptId: string;
};

export type FeatureAvailability =
  | { enabled: true }
  | { enabled: false; reason: string };

/** Payloads are domain types, never an unvalidated shared JSON envelope. */
export interface FeatureDraft<Begin, Update, Output> {
  begin(owner: FeatureOwner, input: Begin): EditorResult<Output>;
  update(owner: FeatureOwner, input: Update): EditorResult<Output>;
  commit(owner: FeatureOwner): EditorResult<Output>;
  cancel(owner: FeatureOwner): void;
}
