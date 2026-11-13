import {it,expect} from 'vitest';
import {inspectSomaMotionTiming} from './timing.js';
it('reports source-time candidates without mistaking a single-frame spike for onset',()=>{
 const frames=90,fps=30,posed=new Float64Array(frames*77*3);
 for(let f=0;f<frames;f++){
  posed[(f*77+3)*3+1]=1;
  posed[(f*77+6)*3+1]=1.5;
  if(f===5)posed[(f*77+74)*3+2]=.5;
  if(f>=30)posed[(f*77+74)*3+2]=Math.min(.5,(f-29)*.05);
 }
 const result=inspectSomaMotionTiming(posed,fps,frames);
 expect(result.verification).toBe('kinematic-candidates-only');
 expect(result.signals.rightFootForward.onsetTime).toBe(1);
 expect(result.signals.rightFootForward.peakTime).toBeCloseTo(5/30);
 expect(result.signals.torsoTilt.onsetTime).toBeNull();
 expect(result.profile.length).toBeLessThanOrEqual(32);
 expect(()=>inspectSomaMotionTiming(posed,0,frames)).toThrow();
 expect(()=>inspectSomaMotionTiming(posed,30,frames-1)).toThrow();
 posed[4]=NaN;expect(()=>inspectSomaMotionTiming(posed,30,frames)).toThrow();
});
