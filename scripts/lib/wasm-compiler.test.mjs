import test from 'node:test';
import assert from 'node:assert/strict';
import { wasmCompilerEnvironment } from './wasm-compiler.mjs';
const probe = command => ({ status: 0, stdout: command.includes('llvm') ? ' wasm32 - WebAssembly 32-bit\n wasm64 - WebAssembly 64-bit' : ' aarch64 - ARM64' });
test('macOS skips Apple clang and selects Homebrew LLVM with WASM support', () => {
 const result = wasmCompilerEnvironment({env:{}, platform:'darwin', probe});
 assert.equal(result.CC_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/clang');
 assert.equal(result.CXX_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/clang++');
});
test('explicit target compilers are honored and validated', () => {
 const env={CC_wasm32_unknown_unknown:'/custom/llvm/clang',CXX_wasm32_unknown_unknown:'/custom/llvm/clang++'};
 assert.deepEqual(wasmCompilerEnvironment({env,probe}),env);
 assert.throws(()=>wasmCompilerEnvironment({env:{CC_wasm32_unknown_unknown:'apple-clang'},probe}),/LLVM.*WebAssembly/);
});
test('Windows discovers LLVM under Program Files and missing LLVM explains installation', () => {
 const result=wasmCompilerEnvironment({env:{ProgramFiles:'C:\\Program Files'},platform:'win32',probe: command=>({status:0,stdout:command.includes('LLVM')?'wasm32 - WebAssembly':''})});
 assert.equal(result.CXX_wasm32_unknown_unknown,'C:\\Program Files\\LLVM\\bin\\clang++.exe');
 assert.throws(()=>wasmCompilerEnvironment({env:{},platform:'linux',probe:()=>({status:1})}),/Install LLVM/);
});
