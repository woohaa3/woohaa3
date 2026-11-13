import {it,expect} from 'vitest';
import {CANVAS_BUILDER_FLOW} from '../src/backend/prompts.js';
it('routes single-character motion to explicit motion tasks and truthful completion',()=>{
 const flow=CANVAS_BUILDER_FLOW.join('\n');
 expect(flow).toContain('motion');expect(flow).toContain('NPZ');expect(flow).toContain('官方 SOMA 白模');expect(flow).toContain('get_node_output');
});


import {sceneDirectorRole} from '../src/backend/roles/scene-director.js';
it('guides end-user director sessions through capability-gated fallback and simple per-actor choreography',()=>{
 const instructions=sceneDirectorRole.definition.instructions;
 expect(instructions).toContain('fallback.allowed');
 expect(instructions).toContain('taskSubmitted');
 expect(instructions).toContain('joint-animation');
 expect(instructions).toContain('startTime');
 expect(instructions).toContain('generationId');
 expect(instructions).toContain('[0,0,1,0]');
 expect(instructions).toContain('不要擅自省略');
 expect(instructions).toContain('头部');
 expect(instructions).toContain('捂脸');
 const prepared=sceneDirectorRole.prepare({input:{prompt:'让两个人互动',action:'generate'},context:{},target:{canvasId:'canvas',nodeId:'area',mode:'world'},requestId:'test',nativeCapabilities:[]});
 const text=prepared.messages.map(m=>m.content).join('\n');
 expect(text).toContain('仅在直接编写关节动画');
 expect(text).not.toContain('为模型做骨骼/关节动画或行走前');
});

it('distinguishes source events from timeline starts and inspects interaction timing before replacement',()=>{
 const text=sceneDirectorRole.definition.instructions;
 expect(text).toContain('inspectTiming:true');expect(text).toContain('sourceStartTime');expect(text).toContain('blendInDuration');
 expect(text).toContain('片内');expect(text).toContain('不证明接触');expect(text).toContain('负 startTime');
});
