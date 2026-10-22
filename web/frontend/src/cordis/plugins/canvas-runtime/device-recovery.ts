/** Runtime-owned context loss: preserve parent editing state; never reload the page. */
export function installDeviceRecovery(canvas: HTMLCanvasElement, fault: (reason: string) => void): () => void {
  const lost = (event: Event) => { event.preventDefault(); fault("WebGL 上下文丢失"); };
  canvas.addEventListener("webglcontextlost", lost, { capture: true });
  return () => canvas.removeEventListener("webglcontextlost", lost, { capture: true });
}
