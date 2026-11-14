import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { sampleSomaMotion, type PreparedSomaMotion } from '@woohaa3/contracts';

/** GPU mesh presentation; the contract sampler applies all eight skin weights. */
export function createSomaRenderer(canvas: HTMLCanvasElement, motion: PreparedSomaMotion) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x20242b);
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  const positions = new THREE.BufferAttribute(new Float32Array(motion.bindVertices.length), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positions);
  geometry.setIndex(new THREE.BufferAttribute(motion.faces, 1));
  const material = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.8, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x677588, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.5);
  light.position.set(3, 5, 4); scene.add(light);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = false;
  controls.minDistance = 0.2;
  let disposed = false;
  const render = () => {
    if (disposed) return;
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  let previousRoot: THREE.Vector3 | undefined;
  const sample = (seconds: number) => {
    const sampled = sampleSomaMotion(motion, seconds);
    const root = new THREE.Vector3(sampled.jointPositions[0], 0, sampled.jointPositions[2]);
    if (previousRoot) {
      const delta = root.clone().sub(previousRoot);
      camera.position.add(delta);
      controls.target.add(delta);
      controls.update();
    }
    previousRoot = root;
    positions.copyArray(sampled.positions);
    positions.needsUpdate = true;
    geometry.computeVertexNormals();
    render();
  };
  sample(0);
  geometry.computeBoundingBox();
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const extent = Math.max(0.5, box.getSize(new THREE.Vector3()).length());
  camera.position.copy(center).add(new THREE.Vector3(extent * 0.9, extent * 0.45, extent * 1.25));
  camera.near = extent / 1000; camera.far = extent * 100;
  controls.target.copy(center); controls.maxDistance = extent * 8; controls.update();
  controls.addEventListener('change', render);
  const resize = new ResizeObserver(render); resize.observe(canvas);
  render();
  return { sample, dispose() { disposed = true; resize.disconnect(); controls.dispose(); geometry.dispose(); material.dispose(); renderer.dispose(); } };
}
