import {it,expect} from 'vitest';
import {CANVAS_BUILDER_FLOW} from '../src/backend/prompts.js';
it('routes single-character motion to explicit motion tasks and truthful completion',()=>{
 const flow=CANVAS_BUILDER_FLOW.join('\n');
 expect(flow).toContain('motion');expect(flow).toContain('NPZ');expect(flow).toContain('官方 SOMA 白模');expect(flow).toContain('get_node_output');
});


import {sceneDirectorRole} from '../src/backend/roles/scene-director.js';
it('guides end-user director sessions through capability-gated motion tools',()=>{
 const instructions=sceneDirectorRole.definition.instructions;
 expect(instructions).toContain('animate_humanoid');
 expect(instructions).toContain('动作工具不可用');
 expect(instructions).toContain('edit_scene_animation_script');
 const prepared=sceneDirectorRole.prepare({input:{prompt:'让两个人互动',action:'generate'},context:{},target:{canvasId:'canvas',nodeId:'area',mode:'world'},requestId:'test',nativeCapabilities:[]});
 const text=prepared.messages.map(m=>m.content).join('\n');
 expect(text).toContain('read_world_resource');
 expect(text).not.toContain('为模型做骨骼/关节动画或行走前');
});

it('keeps motion guidance on the canonical resource tools',()=>{
 const text=sceneDirectorRole.definition.instructions;
 expect(text).toContain('motion');expect(text).toContain('world_model_rig');
});

it('keeps motion guidance compatible with resource-only world authoring',()=>{
 const text=sceneDirectorRole.definition.instructions;
 for(const old of ['get_world_model_rig','set_scene_animation_script','move_world_model'])expect(text).not.toContain(old);
 expect(text).toContain('read_world_resource');expect(text).toContain('resourceType=scene_animation_script');
 expect(text).toContain('edit_scene_animation_script');expect(text).toContain('expectedParentVersion');
});

it('routes new interactions through mandatory host timing and movement checks',()=>{
 const text=sceneDirectorRole.definition.instructions;
 expect(text).toContain('必须调用animate_humanoid_interaction');
 expect(text).toContain('禁止用两次animate_humanoid');
 expect(text).toContain('movement-decision-required');
 expect(text).toContain('不以用户没说translate为理由');
 expect(text).toContain('allowInPlaceTravel:true只用于用户明确要求原地');
});
