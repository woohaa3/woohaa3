/**
 * 版本缩略图旁的「当时的输入」卡片：只读展示这个版本生成时的提示词、模型、参考图，
 * 「重新编辑」把它们载回底部对话框（提示词、参数、模型、当时的主图），不动卡片当前显示的结果图。
 *
 * 数据来自历史条目的 `source.inputSnapshot`（生成时由后端写入）。更早的版本没有这份记录，
 * 只显示一句说明，不编造内容。
 */
import type { RunInputSnapshot } from "@woohaa3/contracts";
import type { CSSProperties } from "react";

export const INPUT_CARD_WIDTH = 272;

type Props = {
  snapshot: RunInputSnapshot | undefined;
  /** 资产 id → 可显示的缩略图地址；资产已被删除时返回 null。 */
  assetUrl: (assetId: string) => string | null;
  /** 模型显示名；认不出时回退到原始 modelKey。 */
  modelLabel: (modelKey: string) => string;
  onReedit: (snapshot: RunInputSnapshot) => void;
  onClose: () => void;
  style: CSSProperties;
};

export function HistoryInputCard({ snapshot, assetUrl, modelLabel, onReedit, onClose, style }: Props) {
  return (
    <div className="history-input-card" style={style} role="dialog" aria-label="这个版本的输入">
      <button type="button" className="history-input-card__close" onClick={onClose}>关闭</button>
      {snapshot ? (
        <>
          {snapshot.modelKey ? (
            <div className="history-input-card__row">
              <span className="history-input-card__key">模型</span>
              <span className="history-input-card__value">{modelLabel(snapshot.modelKey)}</span>
            </div>
          ) : null}
          {snapshot.references.length > 0 ? (
            <div className="history-input-card__row">
              <span className="history-input-card__key">参考图</span>
              <span className="history-input-card__refs">
                {snapshot.references.map((reference, index) => {
                  const url = assetUrl(reference.assetId);
                  return url ? (
                    <img key={`${reference.assetId}-${index}`} className="history-input-card__ref" src={url} alt="" draggable={false} />
                  ) : (
                    <span key={`${reference.assetId}-${index}`} className="history-input-card__ref history-input-card__ref--gone" title="该参考图已被删除">已删除</span>
                  );
                })}
              </span>
            </div>
          ) : null}
          <div className="history-input-card__prompt" aria-label="提示词">
            {snapshot.prompt.trim() === "" ? <span className="history-input-card__empty">（没有提示词）</span> : snapshot.prompt}
          </div>
          <div className="history-input-card__actions">
            <button type="button" className="history-input-card__button" onClick={() => void navigator.clipboard?.writeText(snapshot.prompt)}>复制提示词</button>
            <button type="button" className="history-input-card__button history-input-card__button--primary" onClick={() => onReedit(snapshot)}>重新编辑</button>
          </div>
        </>
      ) : (
        <p className="history-input-card__empty">这个版本没有保存当时的输入。只有更新之后生成的版本才会记录。</p>
      )}
    </div>
  );
}
