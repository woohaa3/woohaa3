import {it,expect,vi} from "vitest";
import {withStickyModifiers,NO_STICKY_MODIFIERS} from "./modifier-keys.js";
it("锁存并入实体键且按平台使用Cmd/Ctrl，事件方法仍修改原React事件，不篡改物理键",()=>{
 const event={shiftKey:false,altKey:true,ctrlKey:false,metaKey:false,preventDefault:vi.fn(),stopPropagation:vi.fn()};
 expect(withStickyModifiers(event,NO_STICKY_MODIFIERS,false)).toBe(event);
 const effective=withStickyModifiers(event,{shift:true,command:true,alt:false},false);expect(effective.shiftKey&&effective.altKey&&effective.ctrlKey).toBe(true);expect(effective.metaKey).toBe(false);expect(event.shiftKey).toBe(false);
 effective.preventDefault();effective.stopPropagation();expect(event.preventDefault).toHaveBeenCalledOnce();expect(event.stopPropagation).toHaveBeenCalledOnce();
 const mac=withStickyModifiers(event,{shift:false,command:true,alt:false},true);expect(mac.metaKey).toBe(true);expect(mac.ctrlKey).toBe(false);
});
