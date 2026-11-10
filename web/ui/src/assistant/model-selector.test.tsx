/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationModelDirectory } from "./generation-directory.js";
import { ReasoningParameters } from "./generation-parameters.js";
import { UiProvider } from "../primitives/UiProvider.js";
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); host?.remove(); });
function mount(node: React.ReactNode) { host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root.render(<UiProvider>{node}</UiProvider>)); }
function input(field: HTMLInputElement, value: string) { act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value); field.dispatchEvent(new Event("input", { bubbles: true })); }); }
const sources = Array.from({ length: 30 }, (_, i) => ({ identity: `s${i}`, label: `来源 ${i}`, status: "ready" as const }));
const entries = sources.flatMap(s => Array.from({ length: 500 }, (_, i) => ({ identity: `${s.identity}/${i}`, sourceIdentity: s.identity, modelIdentity: String(i), modelId: `upstream/model-${i}`, label: `模型 ${i}`, sourceLabel: s.label })));
it("bounds 30×500 models, browses sources without committing, searches real IDs and selects atomically", () => {
 const select = vi.fn(), close = vi.fn(); mount(<GenerationModelDirectory sources={sources} entries={entries} selected="s0/0" open onOpenChange={close} onSelect={select} />);
 expect(document.querySelectorAll('.generation-directory__model').length).toBeLessThanOrEqual(16);
 act(() => [...document.querySelectorAll<HTMLButtonElement>('.generation-directory__source-list button')].find(b => b.textContent === '来源 29')!.click());
 expect(select).not.toHaveBeenCalled();
 input(document.querySelector('input[placeholder="搜索模型名称、ID 或来源"]')!, 'model-499');
 const model = document.querySelector<HTMLButtonElement>('.generation-directory__model')!;
 expect(model.textContent).toContain('来源 29'); act(() => model.click());
 expect(select).toHaveBeenCalledWith(expect.objectContaining({ identity: 's29/499', modelId: 'upstream/model-499' })); expect(close).toHaveBeenCalledWith(false);
});
it("keeps failed sources incomplete and zero-result recovery does not select anything", () => {
 const select = vi.fn(), retry = vi.fn();mount(<GenerationModelDirectory sources={[{ identity:'off',label:'失败来源',status:'failed',error:'offline' }]} entries={[]} selected="old" open onOpenChange={vi.fn()} onSelect={select} onRetry={retry} />);
 expect(document.body.textContent).toContain('已读取的来源中无匹配');
 act(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '重试')!.click());expect(retry).toHaveBeenCalledWith('off');expect(select).not.toHaveBeenCalled();
});
it("edits every real effort continuously and default remains the omitted empty value", () => {
 const change=vi.fn();function Fixture(){ const [value,set]=useState('ultra');return <ReasoningParameters value={value} options={['none','minimal','low','medium','high','xhigh','max','ultra']} open onOpenChange={vi.fn()} onChange={v=>{change(v);set(v);}} />; }mount(<Fixture />);
 const select=document.querySelector<HTMLSelectElement>('select')!;
 expect(select.options).toHaveLength(9);act(()=>{select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));});expect(change).toHaveBeenCalledWith('');expect(document.querySelector('.generation-parameters')).not.toBeNull();
});
