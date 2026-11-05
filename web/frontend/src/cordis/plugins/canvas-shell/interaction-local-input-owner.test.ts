import { expect, it } from "vitest";
import { domFire, installSharedSession } from "./test-support/controller-harness.js";
import { focusHarness, modelCenter } from "./test-support/model-focus-harness.js";
installSharedSession();
it("leaves wheel and Safari gestures on a local DOM input owner to that owner",()=>{
 const h=focusHarness();const point=modelCenter(h.target);
 domFire(h.dom,"dblclick",{clientX:point.x,clientY:point.y});
 expect(h.controller.isModelFocused()).toBe(true);
 const before=h.controller.focusProjection();let prevented=0;
 const event={target:{closest:(selector:string)=>selector==='[data-canvas-input-owner="local"]'?{}:null},clientX:point.x,clientY:point.y,deltaY:-100,ctrlKey:true,scale:1.5,preventDefault:()=>{prevented++;}};
 for(const type of ["gesturestart","gesturechange","gestureend"])domFire(h.dom,type,event);
 expect(h.controller.focusProjection()).toEqual(before);expect(prevented).toBe(0);
 // The harness shares canvas/document listeners; the one canvas handler still prevents wheel.
 domFire(h.dom,"wheel",event);expect(h.controller.focusProjection()).toEqual(before);expect(prevented).toBe(1);
 h.controller.dispose();
});
