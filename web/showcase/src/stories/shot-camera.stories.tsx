/**
 * Shot Camera Showcase（真实 Bevy WASM）
 * （change: add-reusable-bevy-shot-camera，任务 6.1–6.3 / design D8）。
 *
 * 独立 story：页面启动真实 Bevy WASM，注册确定性程序化模型 fixture，并经生产 `set_scene`
 * 边界（`modelEditor.shot`）驱动可复用 shot camera rig。主场景、gizmo 与 preview 全部来自真实
 * 渲染，不使用静态图片、mock canvas 或复制 gizmo markup。
 *
 * WASM 产物缺失时显示稳定可诊断错误，而不是空白 canvas。
 */
import type { Story, StoryDefault } from "@ladle/react";
import { useRef } from "react";
import { MODEL_CAMERA_ASPECTS, type ModelCameraAspect } from "@woohaa3/contracts";
import { useShotCameraShowcase } from "../fixtures/shot-camera-fixture.js";
import "../showcase.css";

export default {
	title: "画布组件/Shot Camera",
} satisfies StoryDefault;

function ShotCameraStage() {
	const stageRef = useRef<HTMLDivElement | null>(null);
	const showcase = useShotCameraShowcase(stageRef);

	return (
		<div className="shot-camera" data-testid="shot-camera-stage" data-status={showcase.status}>
			<header className="shot-camera__header">
				<strong>Shot Camera · 真实 Bevy WASM</strong>
				<span className="shot-camera__status" data-testid="shot-status">
					{showcase.status === "ready" ? "已就绪" : showcase.status === "loading" ? "加载中…" : "加载失败"}
				</span>
			</header>

			{showcase.status === "error" ? (
				<div className="shot-camera__error" data-testid="shot-error">
					WASM 运行时加载失败：{showcase.error}
				</div>
			) : null}

			<div className="shot-camera__stage" ref={stageRef}>
				{/* Bevy 在 `start()` 时按 id 绑定窗口；canvas 由 fixture 的单例管理器挂入。 */}
				{/* 诊断面板叠加在场景之上。 */}
				<dl className="shot-camera__diagnostics" data-testid="shot-diagnostics">
					<div><dt>rigs</dt><dd data-testid="diag-rigs">{showcase.diagnostics.rigs}</dd></div>
					<div><dt>previewImages</dt><dd data-testid="diag-preview-images">{showcase.diagnostics.previewImages}</dd></div>
					<div><dt>gizmoEntities</dt><dd data-testid="diag-gizmo-entities">{showcase.diagnostics.gizmoEntities}</dd></div>
					<div><dt>capturesInFlight</dt><dd data-testid="diag-captures">{showcase.diagnostics.capturesInFlight}</dd></div>
				</dl>
			</div>

			<section className="shot-camera__controls" aria-label="镜头控制">
				<div className="shot-camera__camera-list" data-testid="shot-camera-list">
					{showcase.cameras.map((camera) => (
						<button
							key={camera.id}
							type="button"
							data-testid={`camera-item-${camera.id}`}
							data-selected={camera.id === showcase.selectedId}
							className={camera.id === showcase.selectedId ? "is-selected" : ""}
							onClick={() => showcase.select(camera.id)}
						>
							{camera.name}
							{showcase.cameras.length > 1 ? (
								<span
									role="button"
									tabIndex={0}
									data-testid={`camera-remove-${camera.id}`}
									onClick={(event) => {
										event.stopPropagation();
										showcase.removeCamera(camera.id);
									}}
								>
									×
								</span>
							) : null}
						</button>
					))}
					<button type="button" data-testid="camera-add" onClick={showcase.addCamera}>
						+ 新建镜头
					</button>
				</div>

				{showcase.selected ? (
					<>
						<label>
							azimuth
							<input
								type="range"
								data-testid="field-azimuth"
								min={-Math.PI}
								max={Math.PI}
								step={0.01}
								value={showcase.selected.azimuth}
								onChange={(event) => showcase.setAzimuth(showcase.selected!.id, Number(event.target.value))}
							/>
							<output data-testid="value-azimuth">{showcase.selected.azimuth.toFixed(3)}</output>
						</label>
						<label>
							distance
							<input
								type="range"
								data-testid="field-distance"
								min={showcase.distanceBounds.min}
								max={showcase.distanceBounds.max}
								step={(showcase.distanceBounds.max - showcase.distanceBounds.min) / 200}
								value={showcase.selected.distance}
								onChange={(event) => showcase.setDistance(showcase.selected!.id, Number(event.target.value))}
							/>
							<output data-testid="value-distance">{showcase.selected.distance.toFixed(1)}</output>
						</label>
						<label>
							focus Y
							<input
								type="range"
								data-testid="field-focus-y"
								min={-4}
								max={4}
								step={0.05}
								value={showcase.selected.focusOffset.y}
								onChange={(event) => showcase.setFocusY(showcase.selected!.id, Number(event.target.value))}
							/>
							<output data-testid="value-focus-y">{showcase.selected.focusOffset.y.toFixed(2)}</output>
						</label>
						<label>
							视图缩放
							<input
								type="range"
								data-testid="field-view-zoom"
								min={0.4}
								max={3}
								step={0.05}
								value={showcase.viewZoom}
								onChange={(event) => showcase.setViewZoom(Number(event.target.value))}
							/>
							<output data-testid="value-view-zoom">{showcase.viewZoom.toFixed(2)}×</output>
						</label>
						<label>
							画幅
							<select
								data-testid="field-aspect"
								value={showcase.selected.aspect}
								onChange={(event) => showcase.setAspect(showcase.selected!.id, event.target.value as ModelCameraAspect)}
							>
								{MODEL_CAMERA_ASPECTS.map((aspect) => (
									<option key={aspect} value={aspect}>{aspect}</option>
								))}
							</select>
						</label>
						<button type="button" data-testid="camera-reset" onClick={() => showcase.reset(showcase.selected!.id)}>
							Reset
						</button>
						<button type="button" data-testid="camera-capture" onClick={() => void showcase.capture()}>
							Capture
						</button>
					</>
				) : null}

				<dl className="shot-camera__pose" data-testid="shot-pose">
					<div><dt>cameraId</dt><dd data-testid="pose-camera-id">{showcase.selected?.id ?? "—"}</dd></div>
					<div><dt>azimuth</dt><dd data-testid="pose-azimuth">{showcase.shot?.azimuth.toFixed(4) ?? "—"}</dd></div>
					<div><dt>distance</dt><dd data-testid="pose-distance">{showcase.shot?.distance.toFixed(4) ?? "—"}</dd></div>
					<div><dt>fov</dt><dd data-testid="pose-fov">{showcase.shot?.fov.toFixed(4) ?? "—"}</dd></div>
					<div><dt>capture</dt><dd data-testid="pose-capture">{showcase.capturePhase}</dd></div>
					<div><dt>captureSize</dt><dd data-testid="pose-capture-size">{showcase.captureResult ? `${showcase.captureResult.width}×${showcase.captureResult.height}` : "—"}</dd></div>
					<div><dt>previewBytes</dt><dd data-testid="pose-capture-bytes">{showcase.captureResult?.bytes ?? "—"}</dd></div>
				</dl>
			</section>
		</div>
	);
}

/** 交互实验台：真实场景 + gizmo + 镜头列表/字段/画幅/reset/capture + 诊断。 */
export const Lab: Story = () => <ShotCameraStage />;
Lab.storyName = "交互实验台";

/** 多镜头切换：创建第二个镜头并在两者间切换，各自 pose 与 preview identity 独立。 */
export const MultipleCameras: Story = () => <ShotCameraStage />;
MultipleCameras.storyName = "多镜头切换";

/** 窄屏与画幅：390px 下切换生图并集画幅，控件与 preview 不重叠、不横向溢出。 */
export const NarrowAspect: Story = () => <ShotCameraStage />;
NarrowAspect.storyName = "窄屏与画幅";
