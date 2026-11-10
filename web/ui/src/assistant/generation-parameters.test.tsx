/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { GenerationParameters, type GenerationParameterField } from "./generation-parameters.js";
import { UiProvider } from "../primitives/UiProvider.js";
let root: Root;let host: HTMLDivElement;
afterEach(()=>{act(()=>root?.unmount());host?.remove();});
function mount(fields:GenerationParameterField[], initial:Record<string,unknown>){host=document.createElement('div');document.body.append(host);root=createRoot(host);function Fixture(){const [values,set]=useState(initial);return <UiProvider><GenerationParameters fields={fields} parameters={values} open onOpenChange={()=>{}} onChange={patch=>set(v=>({...v,...patch}))}/><output>{JSON.stringify(values)}</output></UiProvider>};act(()=>root.render(<Fixture/>));}
const click=(text:string)=>act(()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!.click());
it('continuously edits, locks linked PNG, promotes blank integer errors and resets only current parameters',()=>{
 mount([{key:'background',label:'背景',type:'select',options:[{value:'opaque',label:'不透明'},{value:'transparent',label:'透明'}],requiresByValue:{transparent:{format:'png'}},defaultValue:'opaque',presentation:{section:'common'}},{key:'format',label:'格式',type:'select',options:[{value:'png',label:'PNG'},{value:'jpeg',label:'JPEG'}],defaultValue:'jpeg',presentation:{section:'common'}},{key:'seed',label:'Seed',type:'number',integer:true,required:true,defaultValue:1}],{background:'opaque',format:'jpeg',seed:'',prompt:'非空提示词',references:['retained']});
 expect(document.body.textContent).toContain('请填写Seed');click('透明');expect(document.querySelector('[data-parameter="format"]')?.textContent).toContain('由「背景」决定');expect(document.querySelector<HTMLButtonElement>('[data-parameter="format"] button')?.disabled).toBe(true);
 expect(document.querySelector('.generation-parameters')).not.toBeNull();click('恢复默认');expect(document.querySelector('output')?.textContent).toContain('非空提示词');expect(document.querySelector('output')?.textContent).toContain('retained');expect(document.querySelector('output')?.textContent).toContain('"seed":1');
});
it('searches long voice catalogs and precise numbers stay direct inputs',()=>{
 mount([{key:'voice',label:'音色',type:'select',options:Array.from({length:40},(_,i)=>({value:`voice-${i}`,label:`长名称角色音色 ${i}`})),presentation:{section:'common'}},{key:'seed',label:'Seed',type:'number',minimum:0,maximum:100,integer:true,presentation:{section:'common'}}],{voice:'voice-0',seed:1});
 const input=document.querySelector<HTMLInputElement>('input[placeholder="搜索音色"]')!;act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'39');input.dispatchEvent(new Event('input',{bubbles:true}));});
 const select=document.querySelector<HTMLSelectElement>('select')!;expect(select.options).toHaveLength(2);act(()=>{select.value='voice-39';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(document.querySelector('output')?.textContent).toContain('voice-39');expect(document.querySelector('input[type="range"]')).toBeNull();
});
