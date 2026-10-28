import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readSourceIdentity} from './source-identity.mjs';

test('detects tracked edits and untracked source without changing HEAD', t => {
 const root=mkdtempSync(path.join(tmpdir(),'source-identity-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 git('init');writeFileSync(path.join(root,'generator.mjs'),'original');git('add','.');
 git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','fixture');
 const initial=readSourceIdentity(root);assert.equal(initial.dirty,false);
 writeFileSync(path.join(root,'generator.mjs'),'edited');assert.deepEqual(readSourceIdentity(root),{revision:initial.revision,dirty:true});
 git('checkout','--','generator.mjs');writeFileSync(path.join(root,'new-code.mjs'),'new');
 assert.deepEqual(readSourceIdentity(root),{revision:initial.revision,dirty:true});
});
