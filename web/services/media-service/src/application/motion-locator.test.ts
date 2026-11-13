import {it,expect,vi} from 'vitest';
import {createMediaApplicationService} from './internal-service.js';
import type {MediaStorage} from '@woohaa3/contracts';
it('adopts remote NPZ locator into scoped stable npz object',async()=>{
 const bytes=new Uint8Array([80,75,3,4]);const put=vi.fn();
 const storage={readLocator:async()=>({bytes,contentType:'application/x-npz'}),put,exists:async()=>false} as unknown as MediaStorage;
 const service=createMediaApplicationService({storage});
 const result=await service.importFromLocator({locator:'media://server/canvas-1/media/result.npz',canvasId:'canvas-1',expected:{size:4,contentType:'application/x-npz'}});
 expect(result.storageKey).toMatch(/^generation-outputs\/[a-f0-9]{64}\.npz$/);expect(result.mediaKind).toBe('other');expect(put).toHaveBeenCalledOnce();
});
