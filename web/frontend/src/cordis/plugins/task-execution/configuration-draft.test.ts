import { expect, it } from "vitest";
import { catalogFixture } from "./test-support/fixtures.js";
import { mediaDraftTarget, mediaDraftPartition, switchMediaParameters, mediaParameterEditingError, visibleMediaParameters } from "./configuration-draft.js";
import { createModelDraftStore, migrateLegacyModelDraft } from "./model-draft.js";
import { nodeDraftStore } from "./drafts.js";
const [a,b] = catalogFixture(['a','b'].map(modelKey=>({ modelKey, inputSchema:{type:'object',required:['seconds'],properties:{seconds:{type:'integer',minimum:1,maximum:10,default:5,unit:'秒','x-pptask-presentation':{semanticId:'duration'}},size:{type:'integer',default:1,'x-pptask-presentation':{semanticId:modelKey}},format:{type:'string',enum:['png','jpeg'],default:'jpeg'},background:{type:'string',enum:[{value:'transparent',label:'透明','x-pptask-requires':{format:'png'}},'opaque'],default:'opaque'}}},defaultInput:{} }))).models;
it('switches only matching semantics, applies linked constraints, restores own draft before migrating, and retains diagnostics',()=>{
 const result=switchMediaParameters(a!,b!,{seconds:7,size:9,background:'transparent'});expect(result.parameters).toMatchObject({seconds:7,size:1,format:'jpeg'});expect(result.resetLabels).toContain('size');
 expect(switchMediaParameters(a!,b!,{seconds:7},{seconds:'',size:2}).parameters).toEqual({seconds:'',size:2});
 expect(switchMediaParameters(a!,b!,{seconds:99}).parameters.seconds).toBe(5);
});
it('blank or fractional integers cannot normalize into defaults, required structural defaults must validate fully, and hidden obsolete fields never submit',()=>{
 expect(mediaParameterEditingError(a!,{seconds:''})).toContain('seconds');expect(mediaParameterEditingError(a!,{seconds:1.5})).toContain('seconds');
 const structural={...a!,inputSchema:{type:'object',required:['config'],properties:{config:{type:'object',required:['id'],properties:{id:{type:'string'}},default:{}}}}};
 expect(mediaParameterEditingError(structural,{})).toContain('专用参数面板');
 expect(visibleMediaParameters(a!,{seconds:5,oldOnly:1,model:'a',serviceConnectionId:'c'})).toEqual({seconds:5,model:'a',serviceConnectionId:'c'});
});
it('isolates target/model/source drafts, claims explicit legacy drafts once and refuses ambiguous identity',()=>{
 nodeDraftStore.clearAll();const store=createModelDraftStore();const target=mediaDraftTarget('space','canvas','node'),partition=mediaDraftPartition('a','');
 nodeDraftStore.patch('node',{prompt:'kept',parameters:{model:'a',seconds:''}},'a');
 expect(migrateLegacyModelDraft(store,{nodeId:'node',modelKey:'a',sourceId:'other',target,partition})).toBe(false);
 expect(migrateLegacyModelDraft(store,{nodeId:'node',modelKey:'a',sourceId:'',target,partition})).toBe(true);
 expect(store.get(target,partition).parameters.seconds).toBe('');
 expect(migrateLegacyModelDraft(store,{nodeId:'node',modelKey:'a',sourceId:'',target:mediaDraftTarget('other','canvas','node'),partition})).toBe(false);
 expect(store.get(target,mediaDraftPartition('a','other')).parameters).toEqual({});
 expect(store.get(mediaDraftTarget('space','other','node'),partition).parameters).toEqual({});nodeDraftStore.clearAll();
});
