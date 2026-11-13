import {it,expect} from 'vitest';
import {mediaPayload} from './registration.js';
import {mediaAssetFor} from './assets.js';
it('retains canonical motion sampling and skeleton metadata across history restore',()=>{
 const motion={fps:30,frameCount:90,skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'} as const;
 const payload=mediaPayload({mediaKind:'motion',asset:{metadata:{storageKey:`generation-outputs/${'a'.repeat(64)}.npz`,checksum:'a'.repeat(64),contentType:'application/x-npz',size:100,motion}} as never});
 expect(payload).toMatchObject({kind:'motion',fps:30,motion});
 const restored=mediaAssetFor({canvasId:'c',nodeId:'n',entryId:'e',createdAt:'now',source:{label:'动作生成'}} as never,payload);
 expect(restored.metadata).toMatchObject({contentType:'application/x-npz',fps:30,motion});
});
import {toNodeHistoryListItem} from '@woohaa3/contracts';
it('publishes the canonical sample rate in history preview and refuses missing identity',()=>{
 const motion={fps:60,frameCount:180,skeletonId:'somaskel77',restPoseId:'kimodo-standard-tpose',formatVersion:'kimodo-soma-v1'} as const;
 const entry={kind:'motion',entryId:'e',canvasId:'c',nodeId:'n',createdAt:'now',previewable:true,recoverable:true,source:{label:'动作'},payload:{kind:'motion',fps:30,motion}};
 const item=toNodeHistoryListItem(entry as never,{current:false,previewHref:()=>'/preview'});
 expect(item.preview).toMatchObject({kind:'motion',fps:60,motion});
 expect(toNodeHistoryListItem({...entry,payload:{kind:'motion'}} as never,{current:false,previewHref:()=>'/preview'}).preview.kind).toBe('failure');
});
