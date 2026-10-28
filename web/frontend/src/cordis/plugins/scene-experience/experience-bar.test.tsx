// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({services:{} as Record<string,unknown>}));
vi.mock('../../react.js',()=>({useService:(name:string)=>mocks.services[name]}));
import { SceneExperienceBar } from './experience-bar.js';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
afterEach(()=>{vi.unstubAllGlobals();});
function services(){mocks.services={canvasRuntime:{runtime:()=>null,resourceResidencyDiagnostics:()=>null},canvasLocate:{locateNodes:vi.fn(()=>({ok:true}))},appRouter:{navigate:vi.fn()},canvasCatalog:{invalidate:vi.fn()},canvasSelection:{setRecentCanvasId:vi.fn()}};}
const receipt={canvasId:'c',operationId:'o',packageHash:'abc',manifest:{format:'woohaa-scene',version:1,datasetId:'test',contentHash:'abc',recipeVersion:1,kind:'text',title:'Test',views:{overview200:['a'],overview300:['a','b'],distant:['z']}}};
it('normal canvases fetch one receipt and never start a frame collector', async()=>{
  services();const fetcher=vi.fn(async()=>new Response('',{status:404}));vi.stubGlobal('fetch',fetcher);
  const raf=vi.fn();vi.stubGlobal('requestAnimationFrame',raf);
  const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLElement>();
  await act(async()=>root.render(<SceneExperienceBar canvasId="normal" surfaceRef={ref} ready={false}/>));
  await act(async()=>root.render(<SceneExperienceBar canvasId="normal" surfaceRef={ref} ready={true}/>));
  expect(host.textContent).toBe('');expect(fetcher).toHaveBeenCalledTimes(1);expect(raf).not.toHaveBeenCalled();
  await act(async()=>root.unmount());
});
it('receipt canvas collects only while mounted, keeps collector when focus hides toolbar, and confirms reset', async()=>{
  services();const fetcher=vi.fn(async()=>new Response(JSON.stringify({receipt})));vi.stubGlobal('fetch',fetcher);
  const raf=vi.fn(()=>42),cancel=vi.fn();vi.stubGlobal('requestAnimationFrame',raf);vi.stubGlobal('cancelAnimationFrame',cancel);
  const host=document.createElement('div'),root=createRoot(host),ref=createRef<HTMLElement>();
  await act(async()=>root.render(<SceneExperienceBar canvasId="c" surfaceRef={ref} ready={false}/>));
  expect(host.textContent).toContain('完整看 200 个');expect(raf).toHaveBeenCalledTimes(1);
  await act(async()=>{Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='恢复初始场景')!.click();});
  expect(host.textContent).toContain('当前画布和修改都会保留');expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async()=>root.render(<SceneExperienceBar canvasId="c" surfaceRef={ref} ready={false} hidden/>));
  expect(fetcher).toHaveBeenCalledTimes(1);expect(raf).toHaveBeenCalledTimes(1);
  await act(async()=>root.unmount());expect(cancel).toHaveBeenCalledWith(42);
});
