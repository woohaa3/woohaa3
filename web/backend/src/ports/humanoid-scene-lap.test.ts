import {expect,it} from 'vitest';
import {projectSomaRootTranslation,sampleSomaSceneLapRoute,type AssistantWorldContextView} from '@woohaa3/contracts';
import {createHumanoidSceneLap} from './humanoid-scene-lap.js';
function view():AssistantWorldContextView{return {worldWritable:true,scope:{scope:{kind:'scene-area'}},bounds:{min:{u:-3,v:-3},max:{u:3,v:3}},sceneModels:[{instanceId:'actor',nodeId:'node',title:'actor',transform:{version:'shared-world-v1',position:{u:0,v:0,h:1},rotation:[0,0,0,1],scale:1},localBounds:{min:[-.2,0,-.2],max:[.2,2,.2]},animationRig:{spatial:{groundAnchorLocal:[.1,0,.1],forwardLocal:[0,0,-1],forwardSource:'humanoid-v1',rootToGroundHeightMeters:1,anchorSource:'foot-geometry-bounds'},groups:[],rig:null}}]} as unknown as AssistantWorldContextView;}
it('builds one complete closed rounded lap from the actual stable anchor without changing canonical state',()=>{
 const input=view(),before=JSON.stringify(input),{route,facts}=createHumanoidSceneLap(input,'actor',10);
 expect(facts.closedLoop).toBe(true);expect(facts.fullLap).toBe(true);expect(facts.speed).toBeLessThanOrEqual(3);expect(route.startAnchor).toEqual({u:.1,v:-.1});
 for(const progress of [0,1]){const pose=sampleSomaSceneLapRoute(route,progress),anchor=projectSomaRootTranslation(route.groundAnchorLocal,pose.rotation,route.scale,pose.position);expect(anchor.u).toBeCloseTo(route.startAnchor.u);expect(anchor.v).toBeCloseTo(route.startAnchor.v);}
 expect(JSON.stringify(input)).toBe(before);
});
it('rejects missing scope, unknown geometry, small areas, excessive speed and tilted actors',()=>{
 const input=view();expect(()=>createHumanoidSceneLap({...input,bounds:undefined},'actor',10)).toThrow('导演区');
 expect(()=>createHumanoidSceneLap({...input,bounds:{min:{u:0,v:0},max:{u:.5,v:.5}}},'actor',10)).toThrow();
 expect(()=>createHumanoidSceneLap(input,'actor',1)).toThrow('speed');
 input.sceneModels![0]!.transform.rotation=[.1,0,0,Math.sqrt(.99)];expect(()=>createHumanoidSceneLap(input,'actor',10)).toThrow('直立');
});
it('rejects border obstacles rather than claiming an unchecked lap',()=>{
 const input=view(),actor=input.sceneModels![0]!;
 input.sceneModels!.push({...actor,instanceId:'white-capsule',transform:{...actor.transform,position:{u:-2.5,v:0,h:1}}});
 expect(()=>createHumanoidSceneLap(input,'actor',10)).toThrow('障碍物冲突');
 input.sceneModels![1]!.localBounds=null;expect(()=>createHumanoidSceneLap(input,'actor',10)).toThrow('缺少障碍物包围盒');
});
