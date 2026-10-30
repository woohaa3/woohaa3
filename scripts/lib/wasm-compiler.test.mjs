import test from 'node:test';
import assert from 'node:assert/strict';
import { wasmCompilerEnvironment } from './wasm-compiler.mjs';
const probe = command => ({ status: 0, stdout: command.includes('llvm') ? ' wasm32 - WebAssembly 32-bit\n wasm64 - WebAssembly 64-bit' : ' aarch64 - ARM64' });
test('macOS skips Apple clang and selects Homebrew LLVM with WASM support', () => {
 const result = wasmCompilerEnvironment({env:{}, platform:'darwin', probe});
 assert.equal(result.CC_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/clang');
 assert.equal(result.CXX_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/clang++');
 assert.equal(result.AR_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/llvm-ar');
 assert.equal(result.RANLIB_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/llvm-ranlib');
});
test('explicit target compilers are honored and validated', () => {
 const env={CC_wasm32_unknown_unknown:'/custom/llvm/clang',CXX_wasm32_unknown_unknown:'/custom/llvm/clang++'};
 const result=wasmCompilerEnvironment({env,probe});
 assert.equal(result.CC_wasm32_unknown_unknown, env.CC_wasm32_unknown_unknown);
 assert.equal(result.CXX_wasm32_unknown_unknown, env.CXX_wasm32_unknown_unknown);
 assert.equal(result.AR_wasm32_unknown_unknown, '/custom/llvm/llvm-ar');
 assert.equal(result.RANLIB_wasm32_unknown_unknown, '/custom/llvm/llvm-ranlib');
 assert.throws(()=>wasmCompilerEnvironment({env:{CC_wasm32_unknown_unknown:'apple-clang'},probe}),/LLVM.*WebAssembly/);
});
test('Windows discovers LLVM under Program Files and missing LLVM explains installation', () => {
 const result=wasmCompilerEnvironment({env:{ProgramFiles:'C:\\Program Files'},platform:'win32',probe: command=>({status:0,stdout:command.includes('LLVM')?'wasm32 - WebAssembly':''})});
 assert.equal(result.CXX_wasm32_unknown_unknown,'C:\\Program Files\\LLVM\\bin\\clang++.exe');
 assert.equal(result.AR_wasm32_unknown_unknown,'C:\\Program Files\\LLVM\\bin\\llvm-ar.exe');
 assert.throws(()=>wasmCompilerEnvironment({env:{},platform:'linux',probe:()=>({status:1})}),/Install LLVM/);
});

test('prefers the complete LLVM toolchain when Apple clang also advertises WASM', () => {
 const result = wasmCompilerEnvironment({env:{}, platform:'darwin', probe:()=>({status:0,stdout:' wasm32 - WebAssembly 32-bit'})});
 assert.equal(result.CC_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/clang');
 assert.equal(result.AR_wasm32_unknown_unknown, '/opt/homebrew/opt/llvm/bin/llvm-ar');
});
