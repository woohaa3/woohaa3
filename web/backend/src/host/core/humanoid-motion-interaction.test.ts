import {it,expect,vi} from 'vitest';
import {runHumanoidInteraction} from './humanoid-motion-interaction.js';
const actor=(instanceId:string,rootMotion:'in-place'|'translate'='in-place')=>({instanceId,expectedVersion:'v1',prompt:instanceId,duration:3,rootMotion});
const input={canvasId:'c',contextId:'ctx',requestId:'run',initiator:actor('a'),responder:actor('b'),initiatorEvent:'handsForward' as const};
function setup(){
 const events:string[]=[];
 const generate=vi.fn(async(args:any)=>{events.push('generate:'+args.instanceId);return {ok:true,generationId:args.instanceId,state:'succeeded'};});
 const get=vi.fn(async(args:any)=>{events.push('inspect:'+args.instanceId);return {ok:true,state:'succeeded',asset:{id:args.instanceId},timing:{signals:{handsForward:{peakTime:1,peakValue:.5,onsetTime:.5},headDisplacement:{onsetTime:1.4},torsoTilt:{onsetTime:null}}},rootTravel:{onsetTime:null,maxHorizontalDistance:0}};});
 const apply=vi.fn(async(args:any)=>{events.push('apply:'+args.instanceId);return {ok:true};});
 const checkPath=vi.fn(async(args:any)=>{events.push('path:'+args.instanceId);});
 const validate=vi.fn(async()=>({ok:true}));
 return {events,generate,get,apply,checkPath,validate};
}
it('requires both timing inspections before applying and reuses generated assets',async()=>{
 const deps=setup();const result=await runHumanoidInteraction(input,deps);
 expect(result).toMatchObject({ok:true,verification:'kinematic-alignment-only'});
 expect(deps.events).toEqual(['generate:a','generate:b','inspect:a','inspect:b','apply:a','apply:b']);
 expect(deps.apply.mock.calls[1]![0]).toMatchObject({generationId:'b',replaceExisting:true,startTime:.88,blendInDuration:.12});
 expect(deps.apply.mock.calls[1]![0].sourceStartTime).toBeCloseTo(1.28);
 expect(deps.get.mock.calls.every(([args])=>args.inspectTiming===true)).toBe(true);
});
it('does not apply unchecked motion and returns recoverable task IDs',async()=>{
 const deps=setup();deps.get.mockResolvedValueOnce({ok:false,code:'invalid-data'} as any);
 expect(await runHumanoidInteraction(input,deps)).toMatchObject({ok:false,phase:'inspect',generationIds:{initiator:'a',responder:'b'},appliedActors:[]});
 expect(deps.apply).not.toHaveBeenCalled();
});
it('refuses to silently discard significant travel in an in-place interaction',async()=>{
 const deps=setup();deps.get.mockImplementation(async(args:any)=>({ok:true,state:'succeeded',timing:{signals:{handsForward:{peakTime:1,peakValue:.5},headDisplacement:{onsetTime:.4},torsoTilt:{onsetTime:null}}},asset:{id:args.instanceId},rootTravel:{maxHorizontalDistance:args.instanceId==='b'?1.3:0,onsetTime:.2}} as any));
 expect(await runHumanoidInteraction(input,deps)).toMatchObject({ok:false,code:'movement-decision-required',phase:'movement',instanceId:'b'});
 expect(deps.apply).not.toHaveBeenCalled();
});
it('checks translation paths and aligns full sources with nonnegative timeline starts',async()=>{
 const deps=setup();const result=await runHumanoidInteraction({...input,responder:actor('b','translate')},deps);
 expect(result.ok).toBe(true);expect(deps.checkPath).toHaveBeenCalledTimes(1);
 expect(deps.events.indexOf('path:b')).toBeLessThan(deps.events.indexOf('apply:a'));
 expect(deps.apply.mock.calls[0]![0].startTime).toBeCloseTo(.4);
 expect(deps.apply.mock.calls[1]![0]).toMatchObject({startTime:0,rootMotion:'translate',sourceStartTime:0,blendInDuration:0});
});
it('reports partial publication and never reports success after a failed second apply',async()=>{
 const deps=setup();deps.apply.mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({ok:false,code:'version-conflict'} as any);
 expect(await runHumanoidInteraction(input,deps)).toMatchObject({ok:false,phase:'apply',appliedActors:['a']});
});
it('rejects duplicate actors and failed target validation before generation',async()=>{
 const deps=setup();expect((await runHumanoidInteraction({...input,responder:actor('a')},deps)).ok).toBe(false);
 expect(deps.generate).not.toHaveBeenCalled();deps.validate.mockResolvedValueOnce({ok:false,code:'version-conflict'} as any);
 expect((await runHumanoidInteraction(input,deps)).ok).toBe(false);expect(deps.generate).not.toHaveBeenCalled();
});
it('reports inspection exceptions with task recovery IDs',async()=>{
 const deps=setup();deps.get.mockRejectedValueOnce(Error('storage unavailable'));
 expect(await runHumanoidInteraction(input,deps)).toMatchObject({ok:false,phase:'inspect',generationIds:{initiator:'a',responder:'b'},appliedActors:[]});
 expect(deps.apply).not.toHaveBeenCalled();
});
it('preserves the scene when a translated path is outside the director area',async()=>{
 const deps=setup();deps.checkPath.mockRejectedValueOnce(Error('outside director bounds'));
 expect(await runHumanoidInteraction({...input,responder:actor('b','translate')},deps)).toMatchObject({ok:false,phase:'movement',instanceId:'b'});
 expect(deps.apply).not.toHaveBeenCalled();
});
it('returns each applied canvas command so a successful interaction can settle as a write',async()=>{
 const deps=setup();
 deps.apply.mockImplementation(async(args:any)=>({ok:true,canvasId:'c',commandId:'cmd-'+args.instanceId,nodeId:'area',revision:args.instanceId==='a'?5:6}));
 const result=await runHumanoidInteraction(input,deps);
 expect(result).toMatchObject({ok:true,canvasId:'c',commandId:'cmd-b',nodeId:'area',revision:6,commandReceipts:[
  {canvasId:'c',commandId:'cmd-a',nodeId:'area',revision:5},
  {canvasId:'c',commandId:'cmd-b',nodeId:'area',revision:6}
 ]});
});
it('keeps the first applied actor in the receipt when the second apply throws',async()=>{
 const deps=setup();deps.apply.mockResolvedValueOnce({ok:true}).mockRejectedValueOnce(Error('write disconnected'));
 expect(await runHumanoidInteraction(input,deps)).toMatchObject({ok:false,phase:'apply',generationIds:{initiator:'a',responder:'b'},appliedActors:['a']});
});
