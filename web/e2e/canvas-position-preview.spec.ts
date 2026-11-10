import { expect, test } from "./review-browser.js";
import { modelNodeData, resetCanvasStorage, waitForCanvasSession, sendCommands } from "./helpers.js";

test("real pointer drag uses incremental frames and release/cancel restores canonical state", async ({ page }, info) => {
  test.setTimeout(120000);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  expect((await sendCommands(page, Array.from({length:33},(_,i)=>({
    type:"node.add",node:{id:`drag-${i}`,type:"text",position:{x:i===0?80:1200+i*270,y:100}}
  })))).ok).toBe(true);
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime.lastScene()?.nodes.length)).toBe(33);
  // 共享世界模型：画布点投影成世界实例（模型没有卡片，change: 2026-11-10）。
  expect((await sendCommands(page,["model-a","model-b"].map((id,i)=>({
    type:"node.add",node:{id,type:"model3d"},
    nodeData:modelNodeData({x:12000+i*500,y:100})
  })))).ok).toBe(true);
  for (const id of ["model-a","model-b"]) {
    const response=await page.request.post("/api/model-mcp/scripts",{data:{
      canvasId:"woohaa3-default-canvas",nodeId:id,requestId:`position-${id}`,
      version:"woohaa-model-js-v2",source:"scene.sphere({id:'body',radius:1,color:'#ef5129'});"
    }});
    expect(response.ok(),await response.text()).toBe(true);
  }
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime.lastScene().nodes.filter((n:any)=>n.model).length)).toBe(2);
  const box=(await page.locator("#bevy-canvas").boundingBox())!;
  const pointer={x:box.x+140,y:box.y+150};
  await page.mouse.move(pointer.x,pointer.y);
  await page.mouse.down();
  await page.mouse.move(pointer.x+10,pointer.y+10);
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime.lastScene().nodes[0].x)).toBe(90);
  await page.waitForTimeout(100);
  const before=await page.evaluate(()=>({work:(window as any).__bevyRuntime.getWorkDiagnostics(),
    counters:(window as any).__canvasSceneDiagnostics.snapshot()}));
  expect(before.counters.modelRegistrations).toBeGreaterThan(0);
  await page.mouse.move(pointer.x+200,pointer.y+30,{steps:40});
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime.lastScene().nodes[0].x)).toBe(280);
  const after=await page.evaluate(()=>({work:(window as any).__bevyRuntime.getWorkDiagnostics(),
    counters:(window as any).__canvasSceneDiagnostics.snapshot()}));
  expect(after.counters.positionSubmits).toBeGreaterThan(before.counters.positionSubmits);
  expect(after.counters.sceneBuilds).toBe(before.counters.sceneBuilds);
  expect(after.counters.sceneSubmits).toBe(before.counters.sceneSubmits);
  expect(after.counters.fingerprintBuilds).toBe(before.counters.fingerprintBuilds);
  expect(after.work.snapshotBuilds).toBe(before.work.snapshotBuilds);
  expect(after.work.pickCandidateBuilds).toBe(before.work.pickCandidateBuilds);
  expect(after.counters.modelRegistrations).toBe(before.counters.modelRegistrations);
  expect(await page.evaluate(()=>(window as any).__bevyRuntime.queryPoint({x:300,y:170,zoom:1}))).toMatchObject({ok:true,value:{nodeId:"drag-0"}});
  await page.screenshot({path:info.outputPath("drag-preview.png")});
  await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>(window as any).__canvasCanonical.document.nodes.find((n:any)=>n.id==="drag-0").position.x)).toBe(280);
  const current=await page.evaluate(()=>(window as any).__bevyRuntime.lastScene().nodes[0]);
  await page.mouse.move(box.x+current.x+60,box.y+current.y+50);
  await page.mouse.down();
  await page.mouse.move(box.x+current.x+100,box.y+current.y+90);
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime.lastScene().nodes[0].x)).toBe(320);
  await page.dispatchEvent("#bevy-canvas","pointercancel",{pointerId:1});
  await page.mouse.up();
  await expect.poll(()=>page.evaluate(()=>(window as any).__bevyRuntime.lastScene().nodes[0].x)).toBe(280);
  expect(await page.evaluate(()=>(window as any).__canvasCanonical.document.nodes.find((n:any)=>n.id==="drag-0").position.x)).toBe(280);
  await info.attach("increment-counters",{body:JSON.stringify({before,after},null,2),contentType:"application/json"});
});

test("position ABI keeps render blocks and queries coherent without full submission", async ({ page }, info) => {
  test.setTimeout(120000);
  await resetCanvasStorage(page);
  await waitForCanvasSession(page);
  expect((await sendCommands(page, Array.from({ length: 33 }, (_, i) => ({
    type: "node.add", node: { id: `position-${i}`, type: "text", position: {
      x: i === 0 ? 80 : 900 + i * 270, y: 100
    } }
  })))).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.lastScene()?.nodes.length)).toBe(33);
  await page.mouse.move(4,4);
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({
    work: (window as any).__bevyRuntime.getWorkDiagnostics(),
    counters: (window as any).__canvasSceneDiagnostics.snapshot(),
    base: (window as any).__bevyRuntime.baseSceneGeneration()
  }));
  await page.screenshot({ path: info.outputPath("before.png") });
  const accepted = await page.evaluate(base => {
    const runtime = (window as any).__bevyRuntime;
    const generation = runtime.setPositions({ baseSceneGeneration: base,
      positions: [{ id: "position-0", x: 420, y: 360 }] });
    return { generation,
      hit: runtime.queryPoint({ x: 440, y: 400, zoom: 1 }),
      old: runtime.queryPoint({ x: 100, y: 140, zoom: 1 }) };
  }, before.base);
  expect(accepted.hit).toMatchObject({ ok: true, value: { kind: "node", nodeId: "position-0" } });
  expect(accepted.old).toMatchObject({ ok: true, value: null });
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.getWorkDiagnostics().cardBlockBuilds)).toBe(before.work.cardBlockBuilds + 1);
  await page.screenshot({ path: info.outputPath("moved.png") });
  const after = await page.evaluate(() => ({
    work: (window as any).__bevyRuntime.getWorkDiagnostics(),
    counters: (window as any).__canvasSceneDiagnostics.snapshot(),
    base: (window as any).__bevyRuntime.baseSceneGeneration()
  }));
  expect(after.base).toBe(before.base);
  expect(after.work.snapshotBuilds).toBe(before.work.snapshotBuilds);
  expect(after.work.pickCandidateBuilds).toBe(before.work.pickCandidateBuilds);
  expect(after.counters.sceneSubmits).toBe(before.counters.sceneSubmits);
  expect(after.counters.modelRegistrations).toBe(before.counters.modelRegistrations);
  expect(after.counters.positionSubmits).toBe(before.counters.positionSubmits + 1);
  const rejected = await page.evaluate(base => {
    const runtime = (window as any).__bevyRuntime;
    let error = "";
    try { runtime.setPositions({ baseSceneGeneration: base, positions: [
      { id: "position-0", x: 700, y: 600 }, { id: "missing", x: 0, y: 0 }
    ] }); } catch (e) { error = String(e); }
    return { error, node: runtime.lastScene().nodes[0], hit: runtime.queryPoint({ x: 440, y: 400, zoom: 1 }) };
  }, before.base);
  expect(rejected.error).toContain("Unknown position node");
  expect(rejected.node).toMatchObject({ x: 420, y: 360 });
  expect(rejected.hit).toMatchObject({ ok: true, value: { nodeId: "position-0" } });
  // Position-only preserves an accepted viewport; combined updates remain one ABI call.
  await page.evaluate(base => {
    const runtime = (window as any).__bevyRuntime;
    runtime.setViewport({ baseSceneGeneration: base, viewport: { x: 30, y: 40, zoom: 1 } });
    runtime.setPositions({ baseSceneGeneration: base, positions: [{ id: "position-0", x: 80, y: 100 }] });
  }, before.base);
  expect(await page.evaluate(() => (window as any).__bevyRuntime.lastScene().viewport)).toEqual({ x: 30, y: 40, zoom: 1 });
  expect((await sendCommands(page, [{ type: "node.update", nodeId: "position-0", position: { x: 90, y: 110 } }])).ok).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__bevyRuntime.baseSceneGeneration())).not.toBe(before.base);
  const stale = await page.evaluate(base => {
    try { (window as any).__bevyRuntime.setPositions({ baseSceneGeneration: base, positions: [{ id: "position-0", x: 0, y: 0 }] }); }
    catch (e) { return String(e); }
    return "accepted";
  }, before.base);
  expect(stale).toContain("stale-base");
});
