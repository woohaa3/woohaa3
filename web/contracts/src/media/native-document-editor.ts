/** Optional local desktop editor protocol. No native capability is implied by installation. */
export type NativeEditorErrorCode = "unavailable" | "incompatible" | "unsupported" | "busy"
  | "stale-generation" | "stale-revision" | "budget-exceeded" | "device-lost" | "cancelled" | "internal-error";
export type NativeEditorError = { code: NativeEditorErrorCode; message: string; diagnostic_id?: string | null };
export type NativeEditorProvider = {
  provider_id: string; api_major: number; api_minor: number; project_protocol: number; browser_protocol: number;
  formats: string[]; capabilities: string[]; build_identity: string;
};
export type NativeEditorCapabilities = { providers: NativeEditorProvider[]; gpu_ready: boolean; workspace_open: boolean };
export type NativeEditorCreate = {
  provider_id: string; session_id: string; generation: number; project_protocol: number; browser_protocol: number;
  capabilities: string[]; physical_size: [number, number]; scale_factor: number;
};
export type NativeEditorModifiers = { alt: boolean; control: boolean; shift: boolean; meta: boolean };
export type NativeEditorPointerSample = { position_css: [number, number]; pressure: number; time_seconds: number };
export type NativeEditorInputEvent =
  | { kind: "pointer"; phase: "down" | "move" | "up" | "cancel"; pointer_id: number; pointer_type?: "mouse" | "pen" | "touch"; position_css: [number, number]; pressure: number; button: number; buttons: number; modifiers: NativeEditorModifiers; samples: NativeEditorPointerSample[] }
  | { kind: "zoom"; position_css: [number, number]; factor: number }
  | { kind: "wheel"; position_css: [number, number]; delta_css: [number, number]; modifiers: NativeEditorModifiers }
  | { kind: "key"; key: string; code: string; pressed: boolean; repeat: boolean; modifiers: NativeEditorModifiers }
  | { kind: "ime-preedit"; text: string; selection: [number, number] | null }
  | { kind: "ime-commit"; text: string }
  | { kind: "blur" };
export type NativeEditorInput = { sequence: number; layout_generation: number; time_seconds: number; event: NativeEditorInputEvent };
export type NativeEditorLayout = { physical_size: [number, number]; scale_factor: number; layout_generation: number; viewport_origin_css: [number, number] };
export type NativeEditorOperation =
  | { kind: "input"; input: NativeEditorInput }
  | { kind: "layout"; layout: NativeEditorLayout }
  | ({ kind: "open"; source_id: string; node_binding: string | null; format: string } & ({ bytes: number[]; bytes_blob_id?: never } | { bytes_blob_id: string; bytes?: never }))
  | { kind: "activate"; document_id: string }
  | { kind: "show" | "hide" }
  | { kind: "close"; document_id: string; expected_revision: number; discard: boolean }
  | { kind: "command"; document_id: string; expected_revision: number; command: string; parameters: number[] }
  | { kind: "export"; document_id: string; expected_revision: number; format: string }
  | { kind: "cancel-job"; job_id: number }
  | { kind: "mark-saved"; document_id: string; expected_revision: number };
export type NativeEditorRequest = { session_id: string; request_id: number; generation: number; operation: NativeEditorOperation };
export type NativeEditorResult =
  | { kind: "opened"; document_id: string; revision: number; source_size: [number, number] }
  | { kind: "changed"; revision: number }
  | { kind: "exported"; bytes?: number[]; bytes_blob_id?: string; revision: number }
  | { kind: "needs-settlement"; document_id: string }
  | { kind: "done" };
export type NativeEditorReceipt = {
  request_id: number; generation: number;
  result: { Ok: NativeEditorResult } | { Err: NativeEditorError };
};
export type NativeEditorDocument = {
  document_id: string; source_id: string; node_binding: string | null; revision: number; saved_revision: number; source_size: [number, number];
};
export type NativeEditorState = {
  key: string; generation: number; document_id: string | null; revision: number | null; progress: number | null;
};
export type NativeEditorSnapshot = {
  frame?: unknown; receipts: NativeEditorReceipt[]; state: NativeEditorState[]; documents: Record<string, NativeEditorDocument>; visible: boolean;
};
