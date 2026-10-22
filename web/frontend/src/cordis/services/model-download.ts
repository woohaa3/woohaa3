import {
  executeModelScriptVersioned,
  type SceneV2Op, type SceneV2ShapeOp, type SceneV2MaterialOp, type SceneV2SolidOp
} from "@woohaa3/contracts";
import {
  Scene, Group, Mesh, BufferGeometry, Float32BufferAttribute, BoxGeometry,
  SphereGeometry, CylinderGeometry, CapsuleGeometry, MeshStandardMaterial,
  Object3D, Vector3, Color, DoubleSide, FrontSide
} from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";

function material(color: string, definition?: SceneV2MaterialOp): MeshStandardMaterial {
  // Scene IR hex colors may contain alpha; Three accepts the RGB portion only.
  const rgba = color.length === 5
    ? `#${[...color.slice(1)].map(c => c + c).join("")}` : color;
  const alpha = rgba.length === 9 ? parseInt(rgba.slice(7), 16) / 255 : 1;
  return new MeshStandardMaterial({
    color: new Color(rgba.slice(0, 7)), opacity: alpha,
    transparent: definition ? definition.alphaMode === "blend" : alpha < 1,
    roughness: definition?.roughness ?? 0.85, metalness: definition?.metallic ?? 0,
    emissive: new Color(definition?.emissive ?? "#000000"),
    emissiveIntensity: definition?.emissiveStrength ?? 0,
    side: !definition || definition.doubleSided ? DoubleSide : FrontSide
  });
}

function geometry(op: SceneV2SolidOp): BufferGeometry {
  switch (op.t) {
    case "box": return new BoxGeometry(...op.size);
    case "sphere": return new SphereGeometry(op.radius, 24, 12);
    case "cylinder": return new CylinderGeometry(op.radius, op.radius, op.height, 24);
    case "capsule": return new CapsuleGeometry(op.radius, Math.max(0, op.height - 2 * op.radius), 6, 24);
    case "segment": {
      const length = new Vector3(...op.from).distanceTo(new Vector3(...op.to)) + 2 * op.overlap;
      return op.shape === "box" ? new BoxGeometry(op.width, length, op.depth)
        : new CapsuleGeometry(op.width / 2, Math.max(0, length - op.width), 6, 24);
    }
    case "mesh": {
      const mesh = new BufferGeometry();
      mesh.setAttribute("position", new Float32BufferAttribute(op.vertices.flat(), 3));
      mesh.setIndex(op.faces.flat());
      mesh.computeVertexNormals();
      return mesh;
    }
  }
}

/** Preserve the authored local hierarchy; canvas layout/preview camera are not model geometry. */
export function buildDownloadScene(ops: readonly SceneV2Op[]): Scene {
  const scene = new Scene();
  const objects = new Map<string, Object3D>();
  const definitions = new Map(ops.filter((op): op is SceneV2MaterialOp => op.t === "material").map(op => [op.id, op]));
  const materials = new Map<string, MeshStandardMaterial>();
  const shapes = ops.filter((op): op is SceneV2ShapeOp => "parent" in op);
  for (const op of shapes) {
    let object: Object3D;
    if (op.t === "group") object = new Group();
    else {
      const key = op.material ? `material:${op.material}` : `color:${op.color ?? "#ffffff"}`;
      let mat = materials.get(key);
      if (!mat) {
        const definition = op.material ? definitions.get(op.material) : undefined;
        mat = material(definition?.baseColor ?? op.color ?? "#ffffff", definition);
        materials.set(key, mat);
      }
      object = new Mesh(geometry(op), mat);
    }
    object.name = op.id;
    object.position.set(...op.position);
    object.rotation.set(...op.rotation.map(value => value * Math.PI / 180) as [number, number, number], "YXZ");
    object.scale.set(...op.scale);
    if (op.t === "segment") {
      const from = new Vector3(...op.from), to = new Vector3(...op.to);
      object.position.copy(from.clone().add(to).multiplyScalar(0.5));
      const direction = to.sub(from).normalize();
      if (direction.y < 0 || (direction.y === 0 && (direction.x < 0 || (direction.x === 0 && direction.z < 0)))) direction.negate();
      object.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction);
    }
    objects.set(op.id, object);
  }
  for (const op of shapes) (op.parent ? objects.get(op.parent)! : scene).add(objects.get(op.id)!);
  scene.updateMatrixWorld(true);
  return scene;
}

export function disposeDownloadScene(scene: Scene): void {
  const materials = new Set<MeshStandardMaterial>();
  scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const list = Array.isArray(object.material) ? object.material : [object.material];
    list.forEach(mat => materials.add(mat as MeshStandardMaterial));
  });
  materials.forEach(mat => mat.dispose());
  scene.clear();
}

/** Export the clicked model definition as an interoperable static GLB. */
export async function downloadModelBlob(source: string, version: unknown, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const result = executeModelScriptVersioned(source, version);
  if (!result.ok) throw new Error(`模型无法导出：${result.message}`);
  if (!result.scene.ops.some(op => "parent" in op && op.t !== "group")) throw new Error("模型尚无可下载的几何内容");
  const scene = buildDownloadScene(result.scene.ops as SceneV2Op[]);
  try {
    const data = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
    signal.throwIfAborted();
    if (!(data instanceof ArrayBuffer)) throw new Error("模型导出未生成 GLB 文件");
    return new Blob([data], { type: "model/gltf-binary" });
  } finally { disposeDownloadScene(scene); }
}
