import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { canonicalFilmSetFields, createFilmSetSnapshot, createMotionSnapshot, filmSetAnimationsOf } from '@woohaa3/contracts';
import { installPageHelpers, resetCanvasStorage, sendCommands, uploadMedia, waitForCanvasSession } from './helpers.js';
async function colors(page: Page) {
  const png=await page.locator('#bevy-canvas').screenshot();
  return page.evaluate(async data=>{
    const bitmap=await createImageBitmap(new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'image/png'}));
    const ctx=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d')!;ctx.drawImage(bitmap,0,0);
    const p=ctx.getImageData(0,0,bitmap.width,bitmap.height).data;let red=0,blue=0;
    for(let i=0;i<p.length;i+=16){if(p[i]>100&&p[i]>p[i+2]*1.5)red++;if(p[i+2]>100&&p[i+2]>p[i]*1.5)blue++;}
    return {red,blue};
  },png.toString('base64'));
}
test('real video frame follows selected clip binding and rapid seek without stale overwrite',async({page},info)=>{
  test.setTimeout(150000);await page.setViewportSize({width:1440,height:900});
  await installPageHelpers(page);await resetCanvasStorage(page);await waitForCanvasSession(page);
  const bytes=readFileSync(new URL('./fixtures/video-live-preview-fixture.webm',import.meta.url));
  const upload=await uploadMedia(page,[...bytes],'video/webm');expect(upload.status).toBe(201);
  const storageKey=String(upload.body.storageKey);
  const snapshot=createFilmSetSnapshot({title:'片段视频时间',model:{modelScript:'',modelScriptVersion:'woohaa-model-js-v2'},motionScript:'',timeline:{duration:2,loop:false},initialCamera:{azimuth:0,elevation:0,distance:450,aspect:'16:9',focusOffset:{x:0,y:0,z:0}},filmSetContent:{schemaVersion:3,items:[{id:'video',kind:'video',name:'蓝红视频',assetId:'video-asset',aspectRatio:16/9,durationSeconds:2,localTransform:{offset:{x:0,y:0,z:0},scale:1,yaw:0}}]}});
  const collection=filmSetAnimationsOf(snapshot);const first={id:'normal',name:'正常速度',kind:'dynamic' as const,timeline:{duration:2,loop:false},initialCamera:snapshot.sceneCamera,cameraMotion:createMotionSnapshot({motionScript:'',basedOnModelVersion:{revision:1,contentHash:'camera'}}),bindings:[{itemId:'video',playback:{startTime:0,duration:2,timeScale:1,loop:false}}]};collection.clips.push(first);
  const second=JSON.parse(JSON.stringify(first));second.id='fast';second.name='两倍速度';second.bindings[0].playback.timeScale=2;
  collection.clips.push(second);collection.defaultClipId=first.id;
  expect((await sendCommands(page,[{type:'asset.upsert',asset:{id:'video-asset',title:'视频',mediaKind:'video',source:'uploaded',status:'ready',createdAt:new Date().toISOString(),url:`/api/media/${storageKey}`,metadata:{storageKey,checksum:storageKey.replace('sha256-',''),contentType:'video/webm',size:bytes.length,durationSeconds:2}}},{type:'node.add',node:{id:'film',type:'composite-asset',position:{x:200,y:180},width:400,height:300},nodeData:canonicalFilmSetFields({...snapshot,filmSetAnimations:collection}) as never}])).ok).toBe(true);
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime?.lastScene()?.nodes.find((n:any)=>n.id==='film')?.compositeAsset?.media?.[0]?.hasTexture)).toBe(true);
  await page.mouse.dblclick(400,330);await page.getByRole('tab',{name:'动画',exact:true}).click();await page.getByRole('button',{name:'动画预览',exact:true}).click();
  await page.getByRole('slider',{name:'动画进度'}).fill('0.8');
  await expect.poll(async()=>{const p=await colors(page);return p.blue>200&&p.blue>p.red*3;}).toBe(true);
  await page.screenshot({path:info.outputPath('video-normal-blue.png')});
  await page.getByLabel('拍摄镜头').selectOption('fast');await page.getByRole('slider',{name:'动画进度'}).fill('0.8');
  await expect.poll(async()=>{const p=await colors(page);return p.red>200&&p.red>p.blue*3;}).toBe(true);
  await page.screenshot({path:info.outputPath('video-fast-red.png')});
  await page.getByLabel('拍摄镜头').selectOption('normal');
  for(const t of ['1.5','0.2','1.7','0.8'])await page.getByRole('slider',{name:'动画进度'}).fill(t);
  await expect.poll(async()=>{const p=await colors(page);return p.blue>200&&p.blue>p.red*3;}).toBe(true);
  await page.keyboard.press('Escape');await page.keyboard.press('Escape');
});
