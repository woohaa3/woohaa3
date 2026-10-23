import test from 'node:test';
import assert from 'node:assert/strict';
import {systemTarExec} from './lib/desktop-platform-commands.mjs';

const tar='C:\\msys64\\usr\\bin\\tar.exe';
const gzip='C:\\msys64\\usr\\bin\\gzip.exe';
const existing=file=>[tar,gzip].includes(file);
test('Windows MSYS tar uses its own gzip ahead of Git tools and preserves caller environment',()=>{
 const env={Path:'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32',SystemRoot:'C:\\Windows',COPYFILE_DISABLE:'1'};
 const before={...env},calls=[];
 const run=(command,args,options)=>{calls.push({command,args,options});return args[0]==='--version'?'tar (GNU tar) 1.35':Buffer.from('done');};
 const args=['--format=ustar','-czf','E:\\build artifacts\\out.tar.gz','-C','E:\\source files','.'];
 assert.equal(systemTarExec(args,{env,windowsHide:true},'win32',run,existing).toString(),'done');
 const call=calls.at(-1);
 assert.equal(call.command,tar);
 assert.deepEqual(call.args,['--force-local',...args]);
 assert.equal(call.options.env.PATH.split(';')[0],'C:\\msys64\\usr\\bin');
 assert.equal(call.options.env.Path,undefined);
 assert.equal(call.options.env.COPYFILE_DISABLE,'1');
 assert.equal(call.options.env.SystemRoot,'C:\\Windows');
 assert.deepEqual(env,before);
});
test('GNU tar refuses compressed operations without a matching gzip installation',()=>{
 let archived=false;
 const run=(_command,args)=>{if(args[0]==='--version')return 'tar (GNU tar) 1.35';archived=true;};
 assert.throws(()=>systemTarExec(['-xzf','E:\\archive.tar.gz'],{env:{PATH:'C:\\GitOnly',SystemRoot:'C:\\Windows'}},'win32',run,file=>file===tar),/gzip.*same directory/i);
 assert.equal(archived,false);
});
test('native Windows bsdtar needs no external gzip and non-Windows calls remain unchanged',()=>{
 const native='D:\\Windows\\System32\\tar.exe',calls=[];
 const run=(command,args,options)=>{calls.push({command,args,options});return args[0]==='--version'?'bsdtar 3.8.1':Buffer.from('ok');};
 systemTarExec(['-czf','E:\\archive.tar.gz'],{env:{SystemRoot:'D:\\Windows',PATH:'C:\\GitOnly'}},'win32',run,file=>file===native);
 assert.equal(calls.at(-1).command,native);assert.deepEqual(calls.at(-1).args,['-czf','E:\\archive.tar.gz']);
 const options={encoding:'utf8'};
 systemTarExec(['--version'],options,'darwin',run);
 assert.equal(calls.at(-1).command,'/usr/bin/tar');assert.equal(calls.at(-1).options,options);
});
