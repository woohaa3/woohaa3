import { actor, base, clip } from "./fixtures/film-set-animation-clips.js";
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { createFilmSetSnapshot, createModelSnapshot, createMotionSnapshot, canonicalFilmSetFields, filmSetItemAdapterHash, filmSetClipPrecondition, type FilmSetItem, type FilmSetAnimationClip } from "@woohaa3/contracts";
import { installPageHelpers, resetCanvasStorage, waitForCanvasSession, sendCommands, readStoredCanvas, waitForCommandsSettled } from "./helpers.js";
async function scene(page: Page): Promise<any> { return page.evaluate(() => (window as any).__bevyRuntime?.lastScene?.()); }
async function cameraFrame(page: Page, path: string) {
  await page.waitForTimeout(250);
  const rendered=await scene(page); const rect=rendered.surface.contentRect;
  const aspect=16/9; const width=Math.min(rect.width,rect.height*aspect); const height=width/aspect;
  await page.screenshot({path,clip:{x:rect.x+(rect.width-width)/2,y:rect.y+(rect.height-height)/2,width,height}});
}
async function pixels(page: Page) {
  const png = await page.locator('#bevy-canvas').screenshot();
  return page.evaluate(async data => { const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: 'image/png' })); const c = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!; c.drawImage(bitmap,0,0); const p = c.getImageData(0,0,bitmap.width,bitmap.height).data; let colored=0; for(let i=0;i<p.length;i+=16) if(Math.max(p[i],p[i+1],p[i+2])-Math.min(p[i],p[i+1],p[i+2])>45) colored++; return colored; }, png.toString('base64'));
}
test('shared actor clips: real camera playback, seek, copy, capture, responsive and exit', async ({ page }, info) => {
  test.setTimeout(180000); const errors: string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1440,height:900}); await installPageHelpers(page); await resetCanvasStorage(page); await waitForCanvasSession(page); console.log("clip-e2e: session ready");
  const fields=canonicalFilmSetFields({...base,filmSetAnimations:{schemaVersion:3,defaultClipId:'parkour',clips:[clip('parkour','16:9',true),clip('portrait','9:16',false)]}});
  expect((await sendCommands(page,[{type:'node.add',node:{id:'film',type:'composite-asset',position:{x:200,y:180},width:400,height:300},nodeData:fields as never}])).ok).toBe(true);
  await expect.poll(async()=> (await scene(page))?.nodes.find((n:any)=>n.id==='film')?.model?.resourceKey).toBeTruthy();
  const point=await page.evaluate(()=>{const s=(window as any).__bevyRuntime.lastScene(); const n=s.nodes.find((n:any)=>n.id==='film'); const v=s.viewport; const r=document.querySelector('#bevy-canvas')!.getBoundingClientRect(); return {x:r.left+(n.x+n.width/2)*v.zoom+v.x,y:r.top+(n.y+n.height/2)*v.zoom+v.y};});
  console.log("clip-e2e: geometry ready", point);
  await page.mouse.dblclick(point.x,point.y); await page.getByRole('tab',{name:'动画',exact:true}).click(); await expect(page.locator('[aria-label="片场动画"]')).toBeVisible();
  console.log("clip-e2e: focus ready"); const before=await readStoredCanvas(page); await page.getByRole('button',{name:'动画预览',exact:true}).click();
  await expect.poll(async()=> (await scene(page))?.animationPlayback?.viewMode).toBe('focus-preview');
  console.log("clip-e2e: preview ready"); expect((await scene(page)).animationPlayback.time).toBe(0); expect(await pixels(page)).toBeGreaterThan(150); await page.screenshot({path:info.outputPath('parkour-first.png')}); await cameraFrame(page,info.outputPath('browser-0.png'));
  await page.getByRole('slider',{name:'动画进度'}).fill('3'); await expect.poll(async()=> (await scene(page))?.animationPlayback?.time).toBe(3); await page.screenshot({path:info.outputPath('parkour-jump.png')}); await cameraFrame(page,info.outputPath('browser-3.png'));
  await page.getByRole('slider',{name:'动画进度'}).fill('8'); await page.screenshot({path:info.outputPath('parkour-street.png')}); await cameraFrame(page,info.outputPath('browser-8.png'));
  await page.getByRole('button',{name:'播放',exact:true}).click(); await expect.poll(async()=> (await scene(page))?.animationPlayback?.time).toBeLessThan(3);
  await page.keyboard.press('Space'); await expect.poll(async()=> (await scene(page))?.animationPlayback?.playing).toBe(false);
  const resource=(await scene(page)).nodes.find((n:any)=>n.id==='film').model.resourceKey;
  await page.getByLabel('拍摄镜头').selectOption('portrait'); await expect.poll(async()=> (await scene(page))?.animationPlayback?.clipId).toBe('portrait');
  expect((await scene(page)).animationPlayback.time).toBe(0); expect((await scene(page)).animationPlayback.initialCamera.aspect).toBe('9:16'); expect((await scene(page)).nodes.find((n:any)=>n.id==='film').model.resourceKey).toBe(resource); await page.screenshot({path:info.outputPath('portrait.png')});
  await page.getByRole('button',{name:'保存当前帧'}).click(); await expect.poll(async()=> (await readStoredCanvas(page))?.document.nodes.filter(n=>n.type==='image').length).toBe(1);
  const image=(await readStoredCanvas(page))!.document.nodes.find(n=>n.type==='image')!; expect((await readStoredCanvas(page))!.nodeData[image.id]).toMatchObject({filmSetShotOrigin:{clipId:'portrait',timeSeconds:0}});
  await page.setViewportSize({width:600,height:900}); await page.screenshot({path:info.outputPath('narrow.png')}); expect(await pixels(page)).toBeGreaterThan(50);
  await page.keyboard.press('Escape'); await expect(page.getByRole('button',{name:'动画预览',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.setViewportSize({width:1440,height:900}); await page.getByRole('button',{name:'复制',exact:true}).click(); await waitForCommandsSettled(page);
  const after=await readStoredCanvas(page); expect((after!.nodeData.film as any).filmSetAnimations.clips.length).toBe(3); expect((after!.nodeData.film as any).filmSetContent).toEqual((before!.nodeData.film as any).filmSetContent);
  // Sustained playback and seeking must reuse geometry and precompiled tracks.
  const animations=(after!.nodeData.film as any).filmSetAnimations;
  const op={kind:'timeline' as const,timeline:{duration:40,loop:true}};
  expect((await sendCommands(page,[{type:'filmSet.clipPatch',nodeId:'film',clipId:'parkour',op,expectedHash:filmSetClipPrecondition(animations,'parkour',op)}])).ok).toBe(true);
  await page.getByLabel('拍摄镜头').selectOption('parkour');
  await page.getByRole('button',{name:'动画预览',exact:true}).click();
  const counters=()=>page.evaluate(()=>({compile:(window as any).__animationPlayback.compilations(),...(window as any).__canvasSceneDiagnostics.snapshot()}));
  const baseline=await counters();
  await page.getByRole('button',{name:'播放',exact:true}).click();
  await page.waitForTimeout(30000);
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  expect((await scene(page)).animationPlayback.time).toBeGreaterThan(20);
  const played=await counters(); expect(played.compile).toBe(baseline.compile); expect(played.modelRegistrations).toBe(baseline.modelRegistrations);
  for(let i=0;i<100;i++) await page.evaluate(t=>(window as any).__animationPlayback.seek(t),i%40);
  const sought=await counters(); expect(sought.compile).toBe(baseline.compile); expect(sought.modelRegistrations).toBe(baseline.modelRegistrations);
  for(let i=0;i<20;i++) { const id=i%2?'parkour':'portrait'; await page.getByLabel('拍摄镜头').selectOption(id); await expect.poll(async()=>(await scene(page))?.animationPlayback?.clipId).toBe(id); }
  const switched=await counters(); expect(switched.modelRegistrations).toBe(baseline.modelRegistrations);
  expect((await scene(page)).nodes.find((n:any)=>n.id==='film').model.resourceKey).toBe(resource);
  await page.waitForTimeout(500); const paused=await counters(); await page.waitForTimeout(1000); expect((await counters()).sceneSubmits).toBe(paused.sceneSubmits);
  const performance = JSON.stringify({baseline,played,sought,switched,paused},null,2);
  writeFileSync(info.outputPath('performance.json'), performance);
  await info.attach('performance.json',{body:performance,contentType:'application/json'});
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); await expect.poll(async()=>page.evaluate(()=> (window as any).__canvasModelFocus.focused())).toBe(false);
  // A saved invalid action must show its reason without disabling canvas input.
  const broken=JSON.parse(JSON.stringify(fields)); broken.title='错误片段测试';
  broken.filmSetAnimations.clips[0].bindings[0].motion=createMotionSnapshot({motionScript:"motion.model.rotate('missing',{speed:1});",basedOnModelVersion:actor.model.contentVersion});
  expect((await sendCommands(page,[{type:'node.add',node:{id:'bad-film',type:'composite-asset',position:{x:800,y:180},width:400,height:300},nodeData:broken}])).ok).toBe(true);
  await expect(page.getByRole('alert',{name:'模型或动作错误'})).toContainText('错误片段测试');
  await page.getByRole('slider',{name:'缩放',exact:true}).fill('120');
  await expect.poll(async()=>(await scene(page))?.viewport?.zoom).toBeCloseTo(1.2);
  const panBefore=(await scene(page)).viewport;
  await page.mouse.move(650,700); await page.mouse.down({button:'middle'}); await page.mouse.move(720,760,{steps:6}); await page.mouse.up({button:'middle'});
  await expect.poll(async()=>(await scene(page))?.viewport?.x).not.toBe(panBefore.x);
  const viewport=(await scene(page)).viewport; const node=(await scene(page)).nodes.find((n:any)=>n.id==='bad-film');
  await page.mouse.dblclick((node.x+node.width/2)*viewport.zoom+viewport.x,(node.y+node.height/2)*viewport.zoom+viewport.y);
  await expect(page.getByRole('tab',{name:'动画',exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'动画',exact:true}).click();
  await expect(page.getByRole('button',{name:'动画预览',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'动画预览',exact:true}).click();
  await expect(page.locator('.film-set-animation-player')).toContainText('无法播放');
  await page.getByRole('button',{name:'返回编辑',exact:true}).click();
  await page.keyboard.press('Escape');
  expect((await sendCommands(page,[{type:'node.remove',nodeIds:['bad-film']}])).ok).toBe(true);
  await expect(page.getByRole('alert',{name:'模型或动作错误'})).toBeHidden();
 expect(errors).toEqual([]);
});
