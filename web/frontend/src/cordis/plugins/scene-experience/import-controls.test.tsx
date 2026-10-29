// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ScenePackageImport } from './import-controls.js';

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
it('reports unsupported hosts and keeps file import disabled', async () => {
  const host=document.createElement('div'); const root=createRoot(host);
  await act(async()=>{root.render(<ScenePackageImport openCanvas={()=>{}} client={{available:async()=>{throw Error('当前宿主不支持场景包');}} as never}/>);});
  expect(host.textContent).toContain('当前宿主不支持场景包');
  expect(host.querySelector('input')?.disabled).toBe(true);
  await act(async()=>root.unmount());
});

it('keeps observing a committing import when cancellation is too late', async()=>{
  const {vi}=await import('vitest');vi.useFakeTimers();
  const host=document.createElement('div'),root=createRoot(host),opened:string[]=[];
  const staging={operationId:'o',canvasId:'c',phase:'staging-media',completedMedia:0,totalMedia:1};
  const client={available:async()=>({available:true}),importFile:async()=>({job:staging}),cancel:async()=>({job:{...staging,phase:'committing'}}),job:async()=>({job:{...staging,phase:'ready'}})};
  await act(async()=>root.render(<ScenePackageImport openCanvas={id=>opened.push(id)} client={client as never}/>));
  const input=host.querySelector('input')!;Object.defineProperty(input,'files',{value:[new File(['x'],'test.woohaa-scene')]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='取消导入')!.click());
  expect(host.textContent).not.toContain('已取消导入');expect(input.disabled).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(500));expect(opened).toEqual(['c']);
  await act(async()=>root.unmount());vi.useRealTimers();
});

it('opens the actual ready result when cancellation races with commit',async()=>{
  const {vi}=await import('vitest');vi.useFakeTimers();
  const host=document.createElement('div'),root=createRoot(host),opened:string[]=[];
  const staging={operationId:'o',canvasId:'c',phase:'staging-media',completedMedia:0,totalMedia:1};
  const client={available:async()=>({available:true}),importFile:async()=>({job:staging}),cancel:async()=>({job:{...staging,phase:'ready'}}),job:async()=>({job:{...staging,phase:'ready'}})};
  await act(async()=>root.render(<ScenePackageImport openCanvas={id=>opened.push(id)} client={client as never}/>));
  const input=host.querySelector('input')!;Object.defineProperty(input,'files',{value:[new File(['x'],'test.woohaa-scene')]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
  await act(async()=>Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='取消导入')!.click());
  expect(host.textContent).not.toContain('已取消导入');expect(opened).toEqual(['c']);
  await act(async()=>vi.advanceTimersByTimeAsync(500));expect(opened).toEqual(['c']);
  await act(async()=>root.unmount());vi.useRealTimers();
});
