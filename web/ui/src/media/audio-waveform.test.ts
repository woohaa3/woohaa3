import { expect, it } from "vitest";
import { audioPeaks } from "./audio-waveform.js";
it("keeps stereo transients and the final sample", () => {
  const channels = [new Float32Array(7), new Float32Array([0,-1,0,.5,0,0,.8])];
  expect(audioPeaks({length:7,numberOfChannels:2,getChannelData:i=>channels[i]!},3)).toEqual([1,.5,expect.closeTo(.8)]);
});
it("keeps silence silent and bounds tiny clips", () => {
  expect(audioPeaks({length:2,numberOfChannels:1,getChannelData:()=>new Float32Array(2)},128)).toEqual([0,0]);
});
