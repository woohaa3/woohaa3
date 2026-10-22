import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_PROJECT_CONTENT_TYPE } from "@woohaa3/contracts";
import { setAppBasePathForTesting } from "./app-base-path.js";
import { createMediaRemote } from "./media-remote.js";

afterEach(() => { vi.unstubAllGlobals(); setAppBasePathForTesting("/"); });
const file = new File(["webm"], "movie.webm", { type: "video/webm" });

describe("media upload cancellation", () => {
  it("aborts an in-flight browser XHR and removes its abort listener", async () => {
    class Xhr {
      upload = {};
      onabort?: () => void;
      open = vi.fn();
      setRequestHeader = vi.fn();
      send = vi.fn();
      abort = vi.fn(() => this.onabort?.());
    }
    const xhr = new Xhr();
    vi.stubGlobal("XMLHttpRequest", vi.fn(function () { return xhr; }));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const result = createMediaRemote().upload({ file, signal: controller.signal });
    expect(xhr.send).toHaveBeenCalledWith(file);
    controller.abort();
    expect(await result).toEqual({ ok: false, error: "上传已取消" });
    expect(xhr.abort).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("skips transport if canceled before upload", async () => {
    const uploadImpl = vi.fn();
    const controller = new AbortController(); controller.abort();
    expect(await createMediaRemote({ uploadImpl }).upload({ file, signal: controller.signal }))
      .toEqual({ ok: false, error: "上传已取消" });
    expect(uploadImpl).not.toHaveBeenCalled();
  });

  it("forwards cancellation to the fetch fallback", async () => {
    vi.stubGlobal("XMLHttpRequest", undefined);
    const fetchImpl = vi.fn((_url: unknown, input?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      input?.signal?.addEventListener("abort", () => reject(new Error("abort")), { once: true });
    }));
    const controller = new AbortController();
    const result = createMediaRemote({ fetchImpl: fetchImpl as typeof fetch }).upload({ file, signal: controller.signal });
    controller.abort();
    expect(await result).toEqual({ ok: false, error: "上传已取消" });
    expect(fetchImpl.mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});

it.each(["/", "/dev/editor/"])("工程与 PNG 分别走核验和普通入口，正确映射挂载前缀 %s", async (base) => {
  setAppBasePathForTesting(base);
  const uploadImpl = vi.fn(async (input: { url: string; file: File }) => ({
    ok: true, status: 201, body: { storageKey: "key", checksum: "hash", contentType: input.file.type, size: input.file.size }
  }));
  const remote = createMediaRemote({ uploadImpl });
  const project = new File(["project"], "project.pcraft", { type: IMAGE_PROJECT_CONTENT_TYPE });
  const png = new File(["png"], "output.png", { type: "image/png" });
  expect((await remote.upload({ file: project })).ok).toBe(true);
  expect((await remote.upload({ file: png })).ok).toBe(true);
  const prefix = base === "/" ? "" : base.slice(0, -1);
  expect(uploadImpl.mock.calls.map(([input]) => input.url)).toEqual([`${prefix}/api/media-projects`, `${prefix}/api/media`]);
  expect(uploadImpl.mock.calls[0][0].file).toBe(project);
});
