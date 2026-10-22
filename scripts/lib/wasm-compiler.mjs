import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** cc-rs target-specific configuration, checked against actual compiler target support. */
export function wasmCompilerEnvironment({env=process.env,platform=process.platform,probe=(command)=>spawnSync(command,['--print-targets'],{env,encoding:'utf8',windowsHide:true})}={}) {
 const join=platform==='win32'?path.win32.join:path.join;
 const roots=platform==='darwin'?['/opt/homebrew/opt/llvm/bin','/usr/local/opt/llvm/bin']:platform==='win32'?[join(env.ProgramFiles??'C:\\Program Files','LLVM','bin')]:['/usr/lib/llvm-20/bin','/usr/lib/llvm-19/bin','/usr/lib/llvm-18/bin'];
 const selected={};
 for(const [key,name] of [['CC','clang'],['CXX','clang++']]) {
  const targetKey=`${key}_wasm32_unknown_unknown`;
  const explicit=env[targetKey]??env[`${key}_wasm32-unknown-unknown`];
  const executable=platform==='win32'?`${name}.exe`:name;
  const candidates=explicit?[explicit]:[env[key],executable,...roots.map(root=>join(root,executable))].filter(Boolean);
  const command=candidates.find(candidate=>{
   const result=probe(candidate);
   return result.status===0&&/^\s*wasm32\s+-/m.test(String(result.stdout??''));
  });
  if(!command)throw new Error(`Install LLVM with WebAssembly target support and set ${targetKey} to its ${executable}. ${explicit?`Configured compiler ${explicit} does not support WebAssembly.`:'No WASM-capable compiler was found on PATH or in standard LLVM locations.'}`);
  selected[targetKey]=command;
 }
 return selected;
}
