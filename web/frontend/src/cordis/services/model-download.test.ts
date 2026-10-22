import { describe, expect, it } from "vitest";
import { executeModelScriptVersioned } from "@woohaa3/contracts";
import { Vector3, Mesh, DoubleSide } from "three";
import { buildDownloadScene, disposeDownloadScene, downloadModelBlob } from "./model-download.js";

const sceneFor = (source: string) => {
  const result = executeModelScriptVersioned(source, "woohaa-model-js-v2");
  if (!result.ok) throw new Error(result.message);
  return buildDownloadScene(result.scene.ops as never);
};

describe("GLB model geometry", () => {
  it("preserves parent transforms, local geometry and material sharing", () => {
    const scene = sceneFor(`scene.group({id:'root',position:[3,2,1],rotation:[0,90,0]});
      scene.box({id:'body',parent:'root',position:[2,0,0],size:[1,2,3],color:'#ff000080'});
      scene.sphere({id:'head',parent:'root',radius:.5,color:'#ff000080'});`);
    const body = scene.getObjectByName("body") as Mesh, head = scene.getObjectByName("head") as Mesh;
    expect(body.parent?.name).toBe("root");
    const position = body.getWorldPosition(new Vector3());
    expect(position.x).toBeCloseTo(3); expect(position.y).toBeCloseTo(2); expect(position.z).toBeCloseTo(-1);
    expect(body.material).toBe(head.material);
    expect(body.material).toMatchObject({ side: DoubleSide, roughness: .85, opacity: 128 / 255 });
    disposeDownloadScene(scene);
  });

  it("keeps segment orientation identical when its endpoints are reversed", () => {
    const scene = sceneFor(`scene.segment({id:'a',from:[1,2,3],to:[4,-2,1],width:.2,depth:.3,shape:'box',overlap:.1});
      scene.segment({id:'b',from:[4,-2,1],to:[1,2,3],width:.2,depth:.3,shape:'box',overlap:.1});`);
    expect(scene.getObjectByName("a")!.matrix.elements).toEqual(scene.getObjectByName("b")!.matrix.elements);
    disposeDownloadScene(scene);
  });

  it("reports invalid or empty authored models instead of saving empty files", async () => {
    const signal = new AbortController().signal;
    await expect(downloadModelBlob("scene.invalid();", "woohaa-model-js-v2", signal)).rejects.toThrow("模型无法导出");
    await expect(downloadModelBlob("", "woohaa-model-js-v2", signal)).rejects.toThrow("几何内容");
  });
});
