import {it,expect} from 'vitest';
import {extractExecutionResult} from '../../src/history/projection.js';
it('preserves stable NPZ motion as binary execution output',()=>{
 const result=extractExecutionResult({media:{storageKey:'generation-outputs/test.npz',locator:'media://server/object.npz',contentType:'application/x-npz',size:12,checksum:'a'.repeat(64)}});
 expect(result?.outputs[0]).toMatchObject({kind:'motion',mediaType:'application/x-npz',size:12});
});
