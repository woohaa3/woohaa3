// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { PreparedSomaMotion } from '@woohaa3/contracts';
import { SomaMotionPlayer } from './player.js';
const mocks = vi.hoisted(() => ({ load: vi.fn(), sample: vi.fn(), dispose: vi.fn() }));
vi.mock('../../cordis/services/soma-motion.js', () => ({ loadSomaMotion: mocks.load }));
vi.mock('./renderer.js', () => ({ createSomaRenderer: () => ({ sample: mocks.sample, dispose: mocks.dispose }) }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const motion = { durationSeconds: 2, fps: 30 } as PreparedSomaMotion;
let root: Root;
const el = document.createElement('div');
afterEach(async () => { if(root) await act(async () => root.unmount()); el.innerHTML = ''; vi.clearAllMocks(); });
function button(text: string) { return [...el.querySelectorAll('button')].find(b => b.textContent === text)!; }
it('源切换取消旧读取并拒绝迟到资源覆盖', async () => {
  let finish!: (value: PreparedSomaMotion) => void;
  mocks.load.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(motion);
  root = createRoot(el);
  await act(async () => root.render(<SomaMotionPlayer url="/media/old" fps={30} />));
  const oldSignal = mocks.load.mock.calls[0][1] as AbortSignal;
  await act(async () => root.render(<SomaMotionPlayer url="/media/new" fps={30} />));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => finish({ ...motion, durationSeconds: 99 }));
  expect(el.textContent).toContain('0.0 / 2.0s');
});
it('播放停止与重播控制当前动作，加载失败可重试', async () => {
  mocks.load.mockRejectedValueOnce(new Error('资源失效')).mockResolvedValueOnce(motion);
  root = createRoot(el);
  await act(async () => root.render(<SomaMotionPlayer url="/media/motion" fps={30} />));
  expect(el.textContent).toContain('资源失效');
  await act(async () => button('重试').click());
  await act(async () => button('播放').click());
  expect(button('暂停')).toBeTruthy();
  await act(async () => button('停止').click());
  expect(button('播放')).toBeTruthy();
  expect(mocks.sample).toHaveBeenLastCalledWith(0);
  await act(async () => button('重播').click());
  expect(button('暂停')).toBeTruthy();
});
