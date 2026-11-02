#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const threaded = process.argv.includes('--threaded');
const output = `${root}web/frontend/${threaded?'public/assets/media-image-threaded':'src/media-image-wasm'}`;
mkdirSync(output, {recursive:true});
const target = threaded ? 'media-image/target-threaded' : 'media-image/target';
const rustflags = `-C link-arg=--max-memory=1073741824${threaded?' -C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base':''}`;
function run(cmd,args) { const p = spawnSync(cmd,args,{cwd:root,stdio:'inherit',env:{...process.env,CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS:rustflags}}); if(p.error) throw p.error; if(p.status) process.exit(p.status); }
run('cargo',[...(threaded?['+nightly-2026-10-30']:[]),'build',...(threaded?['-Z','build-std=std,panic_abort','--features','threads']:[]),'--manifest-path','media-image/Cargo.toml','--locked','--release','--target-dir',target,'--target','wasm32-unknown-unknown']);
run('wasm-bindgen',[`${target}/wasm32-unknown-unknown/release/woohaa_media_image.wasm`,'--target','web','--out-dir',output,'--out-name','media_image']);
if (!threaded && process.env.VITE_WOOHAA_IMAGE_THREADS === '1') {
  run(process.execPath, [fileURLToPath(import.meta.url), '--threaded']);
}
