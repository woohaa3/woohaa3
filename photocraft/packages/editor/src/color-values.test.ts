import {expect,it} from "vitest";
import {hexRgb,rgbHex,rgbHsv,hsvRgb,rgbLab,labRgb,colorNumbers,numbersRgb,nearestWebColor,normalizeHex,validColorNumbers} from "./color-values.js";
it("sRGB/HSB/CMYK round trips and neutral hue memory use actual values",()=>{
 for(const hex of ["#000000","#ffffff","#ff0000","#00ff00","#0000ff","#1a72c3"]){const rgb=hexRgb(hex);expect(rgbHex(hsvRgb(rgbHsv(rgb)))).toBe(hex);for(const space of ["RGB","HSB","CMYK"] as const)expect(rgbHex(numbersRgb(space,colorNumbers(space,hex)))).toBe(hex);}
 expect(rgbHsv([.5,.5,.5],210)).toEqual([210,0,.5]);expect(colorNumbers("CMYK","#000000")).toEqual([0,0,0,100]);
});
it("D65 Lab uses standard primaries and round trips; out of gamut stays detectable before clamping",()=>{
 const red=rgbLab([1,0,0]);expect(red[0]).toBeCloseTo(53.24,2);expect(red[1]).toBeCloseTo(80.09,2);expect(red[2]).toBeCloseTo(67.20,2);
 for(const hex of ["#000000","#ffffff","#ff0000","#00ff00","#0000ff","#1a72c3"])expect(rgbHex(labRgb(rgbLab(hexRgb(hex))))).toBe(hex);
 expect(labRgb([50,127,-128]).some(channel=>channel<0||channel>1)).toBe(true);
});
it("hex candidates, bounded numeric channels and nearest 216 Web colors reject invalid input",()=>{
 expect(normalizeHex("f0a")).toBe("#ff00aa");expect(normalizeHex("#AbC123")).toBe("#abc123");for(const value of ["","#12","hello","#1234567"])expect(normalizeHex(value)).toBeNull();
 expect(nearestWebColor("#123456")).toBe("#003366");expect(nearestWebColor("#003366")).toBe("#003366");expect(validColorNumbers("RGB",["0","255","20"])).toBe(true);for(const values of [["","0","0"],["256","0","0"],["Infinity","0","0"],["1","2"]])expect(validColorNumbers("RGB",values)).toBe(false);
});
