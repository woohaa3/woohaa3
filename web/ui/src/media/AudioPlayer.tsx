import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../primitives/Button.js";
import { PlayIcon, PauseIcon, VolumeIcon, MuteIcon } from "../icons/index.js";
import { acquireAudioWaveform } from "./audio-waveform.js";

/** Native media playback, shared with result views; no tasks or document writes. */
export function AudioPlayer({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [waveError, setWaveError] = useState(false);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    setPeaks(null); setWaveError(false);
    if (typeof AudioContext === "undefined") { setWaveError(true); return; }
    let active = true;
    const waveform = acquireAudioWaveform(url);
    waveform.promise.then(value => { if (active) setPeaks(value); }, () => { if (active) setWaveError(true); });
    return () => { active = false; waveform.release(); };
  }, [url, attempt]);
  useEffect(() => {
    const element = audio.current;
    let active = true;
    setError(null); setReady(false); setPlaying(false); setTime(0); setDuration(0); setMuted(false);
    if (element) element.muted = false;
    const metadata = () => { if (active && element) { setReady(true); setDuration(Number.isFinite(element.duration) ? element.duration : 0); } };
    const tick = () => { if (active && element) setTime(element.currentTime); };
    const play = () => { if (active) setPlaying(true); };
    const pause = () => { if (active) setPlaying(false); };
    const fail = () => { if (active) { setError("音频无法读取或解码，请重试；若仍失败，请检查素材和读取权限"); setReady(false); } };
    const listeners = { loadedmetadata: metadata, durationchange: metadata, timeupdate: tick, play, pause, ended: pause, error: fail };
    for (const [type, listener] of Object.entries(listeners)) element?.addEventListener(type, listener);
    // Effect replay reuses the DOM node after cleanup removed its source.
    element?.setAttribute("src", url);
    element?.load();
    return () => {
      active = false;
      for (const [type, listener] of Object.entries(listeners)) element?.removeEventListener(type, listener);
      element?.pause();
      element?.removeAttribute("src");
      element?.load();
    };
  }, [url, attempt]);
  const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  const progress = duration > 0 ? Math.min(1, time / duration) : 0;
  return <div className="ui-audio-player">
    <audio key={`${url}:${attempt}`} ref={audio} src={url} preload="metadata" />
    <div className="ui-audio-player__wave" title={ready ? "点击波形定位" : "正在加载音频"}
      onClick={event => {
        if (!ready || !audio.current || duration <= 0) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (!rect.width) return;
        const next = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration;
        audio.current.currentTime = next; setTime(next);
      }}>
      {peaks ? <svg viewBox="0 0 512 80" preserveAspectRatio="none">
        {peaks.map((peak, index) => <rect key={index} x={index * 512 / peaks.length} y={40 - Math.max(1, peak * 36)}
          width={Math.max(1, 512 / peaks.length - 1.8)} height={Math.max(2, peak * 72)} rx="1.3"
          className={index / peaks.length < progress ? "is-played" : undefined} />)}
      </svg> : <div className="ui-audio-player__wave-status">{waveError ? "波形暂不可用" : "正在读取波形…"}</div>}
    </div>
    <div className="ui-audio-player__controls">
    <button type="button" className="ui-audio-player__play" disabled={!ready} title={playing ? "暂停" : "播放"} onClick={async () => {
      const element = audio.current;
      if (!element) return;
      if (!element.paused) { element.pause(); return; }
      setError(null);
      try { await element.play(); }
      catch { if (audio.current === element && element.isConnected) setError("播放未能开始，请再次点击播放或检查浏览器的声音权限"); }
    }}>{playing ? <PauseIcon size={16} /> : <PlayIcon size={16} fill="currentColor" />}</button>
    <span className="ui-audio-player__time ui-audio-player__elapsed">{clock(time)}</span>
    <input className="ui-audio-player__seek" type="range" title="播放进度" min="0" max={duration || 0} step="0.01" value={time}
      disabled={!ready || duration <= 0} style={{ "--audio-progress": `${progress * 100}%` } as CSSProperties}
      onInput={event => {
        const element = audio.current;
        if (!element || !ready || duration <= 0) return;
        const next = Math.max(0, Math.min(duration, Number(event.currentTarget.value)));
        element.currentTime = next; setTime(next);
      }} />
    <span className="ui-audio-player__time ui-audio-player__duration">{clock(duration)}</span>
    <button type="button" className="ui-audio-player__volume" title={muted ? "取消静音" : "静音"} onClick={() => {
      if (audio.current) { audio.current.muted = !muted; setMuted(!muted); }
    }}>{muted ? <MuteIcon size={16} /> : <VolumeIcon size={16} />}</button>
    </div>
    {!ready && !error ? <p className="ui-audio-player__loading">正在加载音频…</p> : null}
    {error ? <p className="ui-audio-player__error" role="alert">{error} <Button onClick={() => setAttempt(value => value + 1)}>重试</Button></p> : null}
  </div>;
}
