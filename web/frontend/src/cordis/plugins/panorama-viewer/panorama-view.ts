/**
 * 等距柱状（equirectangular）全景的球面查看器。
 *
 * 相机在球心，贴图贴在球的内壁：拖动改 yaw/pitch，滚轮改视场角。
 * 纯 three 封装，不依赖 React / 宿主服务，便于单独验证与释放。
 *
 * 手感数值对齐 miora：初始视场 75°，范围 30°–110°，滚轮每格 0.05°/deltaY，
 * 键盘 Q/E 每帧 ∓1.2° 视场、W/A/S/D 每帧 0.012rad 转动。
 */
import {
  BackSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  SphereGeometry,
  Texture,
  TextureLoader,
  WebGLRenderer
} from "three";

export const PANORAMA_FOV_MIN = 30;
export const PANORAMA_FOV_MAX = 110;
export const PANORAMA_FOV_DEFAULT = 75;
/** 俯仰上下限（度）：到 ±90 会让相机"翻过头顶"。 */
export const PANORAMA_PITCH_LIMIT = 85;
/** 滚轮：每单位 deltaY 改变的视场角（度）。 */
export const PANORAMA_WHEEL_FOV_PER_DELTA = 0.05;

export type PanoramaViewHandle = {
  /** 按弧度转动：dYaw 正为向右看，dPitch 正为向上看。 */
  rotateBy(dYawRad: number, dPitchRad: number): void;
  /** 改变视场角（度）：负为推进（放大），正为拉远。 */
  zoomBy(dFov: number): void;
  /** 回到初始朝向与视场角。 */
  resetView(): void;
  /** 以当前视角截一张图，长边为 `longEdge` 像素；渲染失败返回 null。 */
  capture(longEdge: number): Promise<Blob | null>;
  dispose(): void;
};

export type PanoramaViewOptions = {
  container: HTMLElement;
  url: string;
  /** 贴图解码完成；给出原图尺寸，调用方据此判断是不是 2:1。 */
  onLoaded?: (size: { width: number; height: number }) => void;
  onError?: () => void;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DEG = Math.PI / 180;

export function createPanoramaView(options: PanoramaViewOptions): PanoramaViewHandle {
  const { container, url } = options;
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  const canvas = renderer.domElement;
  canvas.style.cssText = "display:block;width:100%;height:100%;touch-action:none;cursor:grab;";
  container.appendChild(canvas);

  const scene = new Scene();
  const camera = new PerspectiveCamera(PANORAMA_FOV_DEFAULT, 1, 0.1, 1100);
  // 球半径 500：远小于 far，且相机在球心不会穿面。
  const geometry = new SphereGeometry(500, 64, 40);
  const material = new MeshBasicMaterial({ side: BackSide });
  const mesh = new Mesh(geometry, material);
  // BackSide 看内壁时左右是镜像的，翻一次 x 才是正的。
  mesh.scale.x = -1;
  scene.add(mesh);

  let yaw = 0;
  let pitch = 0;
  let disposed = false;
  let frame = 0;
  let texture: Texture | null = null;

  const aim = (): void => {
    const yawRad = yaw * DEG;
    const pitchRad = pitch * DEG;
    camera.lookAt(
      Math.sin(yawRad) * Math.cos(pitchRad),
      Math.sin(pitchRad),
      -Math.cos(yawRad) * Math.cos(pitchRad)
    );
  };
  const render = (): void => {
    frame = 0;
    if (disposed) return;
    aim();
    renderer.render(scene, camera);
  };
  const requestRender = (): void => {
    if (disposed || frame) return;
    frame = requestAnimationFrame(render);
  };

  const resize = (): void => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    requestRender();
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  observer?.observe(container);
  resize();

  const setFov = (fov: number): void => {
    camera.fov = clamp(fov, PANORAMA_FOV_MIN, PANORAMA_FOV_MAX);
    camera.updateProjectionMatrix();
    requestRender();
  };

  // 拖动：像素 → 角度，按当前视场角缩放，放大时拖得更慢、更跟手。
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture?.(event.pointerId);
    canvas.style.cursor = "grabbing";
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const perPixel = camera.fov / Math.max(1, container.clientHeight);
    yaw -= (event.clientX - lastX) * perPixel;
    pitch = clamp(pitch + (event.clientY - lastY) * perPixel, -PANORAMA_PITCH_LIMIT, PANORAMA_PITCH_LIMIT);
    lastX = event.clientX;
    lastY = event.clientY;
    requestRender();
  };
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    canvas.releasePointerCapture?.(event.pointerId);
    canvas.style.cursor = "grab";
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    setFov(camera.fov + event.deltaY * PANORAMA_WHEEL_FOV_PER_DELTA);
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  new TextureLoader().load(
    url,
    (loaded) => {
      if (disposed) {
        loaded.dispose();
        return;
      }
      loaded.colorSpace = SRGBColorSpace;
      loaded.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture = loaded;
      material.map = loaded;
      material.needsUpdate = true;
      const image = loaded.image as { width?: number; height?: number } | undefined;
      options.onLoaded?.({ width: image?.width ?? 0, height: image?.height ?? 0 });
      requestRender();
    },
    undefined,
    () => {
      if (!disposed) options.onError?.();
    }
  );

  return {
    rotateBy(dYawRad, dPitchRad): void {
      yaw += dYawRad / DEG;
      pitch = clamp(pitch + dPitchRad / DEG, -PANORAMA_PITCH_LIMIT, PANORAMA_PITCH_LIMIT);
      requestRender();
    },
    zoomBy(dFov): void {
      setFov(camera.fov + dFov);
    },
    resetView(): void {
      yaw = 0;
      pitch = 0;
      setFov(PANORAMA_FOV_DEFAULT);
    },
    capture(longEdge): Promise<Blob | null> {
      if (disposed || !texture) return Promise.resolve(null);
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      const wide = width >= height;
      const outW = wide ? longEdge : Math.round((longEdge * width) / height);
      const outH = wide ? Math.round((longEdge * height) / width) : longEdge;
      const ratio = renderer.getPixelRatio();
      try {
        // 先放大渲染一帧、拷到 2D canvas，再还原：显示用的画布尺寸不受影响。
        renderer.setPixelRatio(1);
        renderer.setSize(outW, outH, false);
        aim();
        renderer.render(scene, camera);
        const copy = document.createElement("canvas");
        copy.width = outW;
        copy.height = outH;
        copy.getContext("2d")?.drawImage(canvas, 0, 0);
        return new Promise((resolve) => copy.toBlob((blob) => resolve(blob), "image/png"));
      } catch {
        return Promise.resolve(null);
      } finally {
        renderer.setPixelRatio(ratio);
        renderer.setSize(width, height, false);
        requestRender();
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      texture?.dispose();
      material.dispose();
      geometry.dispose();
      renderer.dispose();
      canvas.remove();
    }
  };
}
