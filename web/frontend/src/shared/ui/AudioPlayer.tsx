import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.js";

/** Native media playback, shared with result views; no tasks or document writes. */
export function AudioPlayer({ url }: { url: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    const element = audio.current;
    let active = true;
    setError(null); setReady(false); setPlaying(false); setTime(0); setDuration(0);
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
  return <div className="ui-audio-player">
    <audio key={`${url}:${attempt}`} ref={audio} src={url} preload="metadata" />
    <p>音频 · {clock(time)} / {clock(duration)}</p>
    {!ready && !error ? <p>正在加载音频…</p> : null}
    <Button disabled={!ready} onClick={async () => {
      const element = audio.current;
      if (!element) return;
      if (!element.paused) { element.pause(); return; }
      setError(null);
      try { await element.play(); }
      catch { if (audio.current === element && element.isConnected) setError("播放未能开始，请再次点击播放或检查浏览器的声音权限"); }
    }}>{playing ? "暂停" : "播放"}</Button>
    {error ? <p className="dlg__error" role="alert">{error} <Button onClick={() => setAttempt(value => value + 1)}>重试</Button></p> : null}
  </div>;
}
