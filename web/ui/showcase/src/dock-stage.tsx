import type { ReactNode } from "react";
import { useObservableLog, ObservableLog } from "./dialog-fixtures.js";

/**
 * Dock 舞台（change: align-showcase-reference-ux，任务 2.3）。
 *
 * 提供桌面与 390×844 两个宿主视口，并把宿主级 action 的观察日志暴露给 story。
 * 容器只负责「宿主视口 + 事件记录」，不复制生产 Dock markup。
 */
export function ObservableViewport({
	children,
	caption,
	narrow = false,
	height,
	logLabel = "host action",
}: {
	children: (log: { entries: unknown[]; push: (entry: unknown) => void }) => ReactNode;
	caption: string;
	narrow?: boolean;
	height?: number;
	logLabel?: string;
}) {
	const log = useObservableLog<unknown>();
	return (
		<div className="showcase__stage">
			<div className="showcase__caption">{caption}</div>
			<div
				className={narrow ? "showcase__dock-box showcase__dock-box--narrow" : "showcase__dock-box"}
				data-testid="dock-viewport"
				style={height !== undefined ? { height } : undefined}
			>
				{children(log)}
			</div>
			<ObservableLog label={logLabel} entries={log.entries} />
		</div>
	);
}
