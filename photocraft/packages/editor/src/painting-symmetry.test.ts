import {expect,it} from "vitest";
import {decodePaintingSymmetry,rotateSymmetry,symmetryDirections} from "./painting-symmetry.js";
it("对称元数据拒绝畸形轴，过滤越界路径段",()=>{
 expect(decodePaintingSymmetry({mode:"vertical",center:[1],rotation:0})).toBeNull();
 expect(decodePaintingSymmetry({mode:"path",source:"work",segments:[[[0,0],[1,1]],[[NaN,0],[1,1]]]})).toEqual({mode:"path",source:"work",segments:[[[0,0],[1,1]]]});
});
it("旋转按15度吸附，双轴始终垂直",()=>{
 const p={mode:"dual" as const,center:[10,20] as [number,number],rotation:0};
 expect(rotateSymmetry(p,20,20,true).rotation).toBe(-90);
 const rotated=rotateSymmetry(p,20,23,true);expect(rotated.rotation).toBe(-75);
 const [a,b]=symmetryDirections(rotated);expect(a[0]*b[0]+a[1]*b[1]).toBeCloseTo(0);
});
