import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('cached build script resolves the current Cargo manifest after a checkout is moved',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'woohaa-build-relocation-'));
 try{
  const source=fs.readFileSync(fileURLToPath(new URL('../desktop/build.rs',import.meta.url)),'utf8');
  const harness=path.join(temporary,'build-test.rs'),binary=path.join(temporary,process.platform==='win32'?'build-test.exe':'build-test');
  fs.writeFileSync(harness,`${source}\nmod tauri_build { pub fn build() {} }\n#[test] fn moved_checkout() { let expected = std::path::PathBuf::from(std::env::var("EXPECTED_CLIENT").unwrap()); assert_eq!(client_root(), expected); }\n`);
  const env={...process.env,PATH:path.join(os.homedir(),'.cargo/bin')+path.delimiter+process.env.PATH};
  execFileSync('rustc',['--edition','2021','--test',harness,'-o',binary],{env:{...env,CARGO_MANIFEST_DIR:path.join(temporary,'old/client/desktop')},stdio:'pipe'});
  const output=execFileSync(binary,[],{env:{...env,CARGO_MANIFEST_DIR:path.join(temporary,'new/client/desktop'),EXPECTED_CLIENT:path.join(temporary,'new/client')},encoding:'utf8'});
  assert.match(output,/1 passed/);
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
