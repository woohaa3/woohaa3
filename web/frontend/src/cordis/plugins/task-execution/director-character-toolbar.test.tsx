/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DirectorCharacterToolbar } from "./director-character-toolbar.js";
const mocks = vi.hoisted(() => ({ create: vi.fn<(...args: any[]) => Promise<void>>(async () => {}), remote: {}, edit: {}, session: { isWritable: () => true } }));
vi.mock("./director-character-create.js", () => ({ createDirectorCharacter: mocks.create }));
vi.mock("../../react.js", () => ({ useOptionalService: (key: string) => ({ canvasRemote: mocks.remote, canvasEdit: mocks.edit, canvasSession: mocks.session })[key as "canvasRemote"] }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose = () => {};
afterEach(() => { dispose(); document.body.innerHTML = ""; mocks.create.mockReset(); mocks.create.mockResolvedValue(undefined); });
const button=(text:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text)!;
async function render(writable=true){
 const container=document.createElement('div');document.body.append(container);
 const root=createRoot(container);dispose=()=>act(()=>root.unmount());
 await act(async()=>root.render(<DirectorCharacterToolbar canvasId="c" nodeId="a" areaId="a" writable={writable}/>));
 return root;
}
async function click(text:string){await act(async()=>button(text).click());}
it('requires explicit capsule and body creation, and disables writing read-only',async()=>{
 const root=await render();
 await click('胶囊人');expect(mocks.create).not.toHaveBeenCalled();await click('创建');await click('骨架人');await click('成人');
 expect(mocks.create).toHaveBeenCalledTimes(1);
 expect(document.querySelectorAll('.director-body-picker__row')).toHaveLength(4);
 await click('女');await click('10');await click('胖');
 expect(mocks.create).toHaveBeenCalledTimes(1);
 await click('创建');
 expect(mocks.create.mock.calls[1]![0]).toMatchObject({kind:'humanoid',bodyPreset:'soma-body-v1/female-10-fat'});
 expect(document.querySelector('.director-body-picker')).toBeNull();
 await click('骨架人');
 expect(button('女').className).toContain('primary');expect(button('10').className).toContain('primary');expect(button('胖').className).toContain('primary');
 await act(async()=>root.render(<DirectorCharacterToolbar canvasId="c" nodeId="a" areaId="a" writable={false}/>));
 expect(button('创建').disabled).toBe(true);expect(button('胶囊人').disabled).toBe(true);expect(button('骨架人').disabled).toBe(true);
});
it('freezes a pending selection, prevents duplicates across close/reopen, and preserves an error for retry',async()=>{
 await render();let reject!:(error:Error)=>void;
 mocks.create.mockImplementationOnce(()=>new Promise((_,r)=>{reject=r;}));
 await click('骨架人');await click('成人');await click('男');await click('7');await click('瘦');
 await click('创建');
 expect(button('创建中…').disabled).toBe(true);expect(button('女').disabled).toBe(true);
 await click('骨架人');await click('骨架人');await click('创建中…');
 expect(mocks.create).toHaveBeenCalledTimes(1);
 await act(async()=>reject(new Error('导演区正在使用中')));
 expect(document.querySelector('.director-body-picker')!.textContent).toContain('导演区正在使用中');
 expect(button('7').className).toContain('primary');expect(button('瘦').className).toContain('primary');
 await click('创建');expect(mocks.create).toHaveBeenCalledTimes(2);
 expect(mocks.create.mock.calls[1]![0].bodyPreset).toBe('soma-body-v1/male-7-slim');
});
it('opening, changing and closing without submission has no canvas effect',async()=>{
 await render();await click('骨架人');await click('成人');await click('9');await click('骨架人');expect(mocks.create).not.toHaveBeenCalled();
});

it('creates the five fixed younger shapes and restores adult options',async()=>{
 await render();
 for(const [age,sex,key] of [['婴儿',null,'baby'],['儿童','男','male-child'],['儿童','女','female-child'],['少年','男','male-teen'],['少年','女','female-teen']] as const){
  await click('骨架人');await click(age);
  expect(document.body.textContent).not.toContain('头身比');expect(document.body.textContent).not.toContain('体型');
  if(sex)await click(sex);else expect(document.body.textContent).not.toContain('性别');
  await click('创建');expect(mocks.create.mock.lastCall![0].bodyPreset).toBe(`soma-body-v1/${key}`);
 }
 await click('骨架人');await click('成人');expect(button('10')).toBeTruthy();expect(button('胖')).toBeTruthy();
});
it('creates the short capsule only on submit and freezes it while pending',async()=>{
 await render();await click('胶囊人');await click('2头身');expect(mocks.create).not.toHaveBeenCalled();
 let resolve!:()=>void;mocks.create.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 await click('创建');expect(button('标准').disabled).toBe(true);
 await click('胶囊人');await click('胶囊人');await click('创建中…');
 expect(mocks.create).toHaveBeenCalledTimes(1);expect(mocks.create.mock.lastCall![0]).toMatchObject({kind:'capsule',capsulePreset:'two-heads'});
 await act(async()=>resolve());expect(document.querySelector('.director-body-picker')).toBeNull();
});
