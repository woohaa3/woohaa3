import { useEffect, useRef, useState } from 'react';
import type { PreparedSomaMotion } from '@woohaa3/contracts';
import { Button } from '@woohaa3/ui/primitives';
import { loadSomaMotion } from '../../cordis/services/soma-motion.js';
import { createSomaRenderer } from './renderer.js';

export function SomaMotionPlayer({ url, fps, expectedFrameCount }: { url: string; fps: number; expectedFrameCount?: number }) {
  // Key the session so a new result cannot inherit playback or a late load.
  return <MotionSession key={`${url}:${fps}:${expectedFrameCount ?? ""}`} url={url} fps={fps} expectedFrameCount={expectedFrameCount} />;
}
function MotionSession({ url, fps, expectedFrameCount }: { url: string; fps: number; expectedFrameCount?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<ReturnType<typeof createSomaRenderer>>();
  const [motion, setMotion] = useState<PreparedSomaMotion>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [playing, setPlaying] = useState(false);
  const elapsed = useRef(0);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setMotion(undefined); setError(''); setPlaying(false); elapsed.current = 0; setSeconds(0);
    void loadSomaMotion(url, abort.signal, fps, expectedFrameCount).then(value => { if (!abort.signal.aborted) setMotion(value); }, cause => {
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : '动作读取失败');
    });
    return () => abort.abort();
  }, [url, fps, expectedFrameCount, retry]);
  useEffect(() => {
    if (!motion || !canvas.current) return;
    try { renderer.current = createSomaRenderer(canvas.current, motion); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'WebGL 不可用'); }
    return () => { renderer.current?.dispose(); renderer.current = undefined; };
  }, [motion]);
  useEffect(() => {
    if (!playing || !motion || !renderer.current) return;
    let previous: number | undefined;
    let handle = 0;
    const tick = (now: number) => {
      if (previous !== undefined) elapsed.current = Math.min(motion.durationSeconds, elapsed.current + (now - previous) / 1000);
      previous = now;
      renderer.current?.sample(elapsed.current); setSeconds(elapsed.current);
      if (elapsed.current >= motion.durationSeconds) setPlaying(false);
      else handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, motion]);
  const seek = (value: number) => { elapsed.current = value; setSeconds(value); renderer.current?.sample(value); };
  return <div className="soma-motion-player" style={{ width: '100%' }}>
    <canvas ref={canvas} style={{ display: 'block', width: '100%', height: 360, borderRadius: 8, touchAction: 'none' }} />
    {error ? <div><span>{error}</span> <Button size="sm" onClick={() => setRetry(value => value + 1)}>重试</Button></div> : !motion ? <p>正在读取动作…</p> : <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
      <Button size="sm" onClick={() => { if (seconds >= motion.durationSeconds) seek(0); setPlaying(value => !value); }}>{playing ? '暂停' : '播放'}</Button>
      <Button size="sm" onClick={() => { setPlaying(false); seek(0); }}>停止</Button>
      <Button size="sm" onClick={() => { seek(0); setPlaying(true); }}>重播</Button>
      <input type="range" min={0} max={motion.durationSeconds} step={1 / motion.fps} value={seconds} onChange={event => seek(Number(event.target.value))} style={{ flex: 1, minWidth: 50 }} />
      <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{seconds.toFixed(1)} / {motion.durationSeconds.toFixed(1)}s</span>
    </div>}
  </div>;
}
