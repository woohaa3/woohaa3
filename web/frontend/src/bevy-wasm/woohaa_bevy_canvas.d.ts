// wasm-bindgen 生成的 Bevy 运行时 glue 的稳定类型面
// （由 scripts/build-bevy-wasm.mjs 生成 `woohaa_bevy_canvas.js` / `_bg.wasm`）。
//
// 本 `.d.ts` **手工维护**，保证未运行 wasm 构建时 `tsc` 仍可解析模块。导出签名必须与
// Rust `bevy/src/lib.rs` 的 `#[wasm_bindgen]` 导出保持一致。

export function seed_runtime_generation(previous: number): void;
export function runtime_health(): string;
export function benchmark_frames(enabled?: boolean): string;
export function benchmark_media(enabled?: boolean): string;
export function is_ready(): boolean;
export function rendered_revision(): number;
export function set_scene(json: string): number;
export function set_texture(id: string, width: number, height: number, rgba: Uint8Array, content: string): void;
export function set_image_focus_details(manifest:string,pixels:Uint8Array):void;
export function set_model_media_texture(id: string, width: number, height: number, rgba: Uint8Array): void;
export function request_shot_capture(json: string): void;
export function poll_shot_capture(requestId: number, generation: number): Uint8Array;
export function request_history_thumbnail(json: string): void;
export function poll_history_thumbnail(requestId: number, generation: number): Uint8Array;
export function shot_diagnostics(): string;
export function start(): void;
export function query_point_hit(json: string): string;
export function query_marquee(json: string): string;
export function query_probe(json: string): string;
export function query_drop_target(json: string): string;
export function query_composite_asset_scopes(json: string): string;
export function query_model_pick(json: string): string;
export function query_composite_asset_item_pick(json: string): string;
export function query_composite_asset_item_bounds(json: string): string;
export function query_gizmo_hit(json: string): string;
export function prepare_and_register_model_resource(json: string): string;
export function declare_model_resource(json: string): string;
export function set_model_payload_leases(json: string): string;
export function model_asset_diagnostics(): string;
export function set_viewport(json: string): number;
export function set_observer(json: string): number;
export function observer_capability(): string;
export function set_positions(json: string): number;
export function position_capability(): string;
export function base_scene_generation(): number;
export function viewport_capability(): string;
export function scene_capability(): string;
export function canvas_work_diagnostics(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;
export type SyncInitInput = BufferSource | WebAssembly.Module;

export function initSync(module: { module: SyncInitInput } | SyncInitInput): unknown;

export default function init(
  module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>
): Promise<unknown>;
