import test from 'node:test';
import assert from 'node:assert/strict';
import { packageManagerInvocation } from '../web/scripts/package-manager.mjs';
test('Windows pnpm JS entry runs under Node without shell quoting or cmd shim',()=>{
 const args=['-r','--filter','@woohaa3/a','--config.x=a b&c','run','build'];
 const result=packageManagerInvocation(args,{platform:'win32',execPath:'C:\\Program Files\\node.exe',env:{npm_execpath:'C:\\Users\\a b\\pnpm.cjs'}});
 assert.deepEqual(result,{command:'C:\\Program Files\\node.exe',args:['C:\\Users\\a b\\pnpm.cjs',...args]});
 assert.deepEqual(packageManagerInvocation(args,{platform:'win32',env:{npm_execpath:'C:\\pnpm.exe'}}),{command:'C:\\pnpm.exe',args});
 assert.throws(()=>packageManagerInvocation(args,{platform:'win32',env:{npm_execpath:'C:\\pnpm.cmd'}}),/pnpm/);
 assert.throws(()=>packageManagerInvocation(args,{platform:'win32',env:{}}),/pnpm/);
 assert.deepEqual(packageManagerInvocation(args,{platform:'darwin',env:{}}),{command:'pnpm',args});
});
