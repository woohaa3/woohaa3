import { describe, expect, it } from "vitest";
import {
  checkAuthingQr,
  exchangeAuthingUser,
  fetchQrImageDataUrl,
  geneAuthingQr
} from "../src/backend/authing-qr.js";
import { SdpppxHttpError } from "../src/backend/http.js";
import { SDPPPX_ERROR_CODES } from "../src/shared.js";
import { bodyOf, createFetch, headersOf, jsonResponse, pngResponse, textResponse } from "./helpers.js";

const TARGET = { host: "https://core.authing.cn", appId: "app-1", scene: "WXAPP_AUTH" };

describe("Authing 微信二维码接口", () => {
  it("gene 带 x-authing-app-id 与 scene，解析 random/url", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({ code: 0, data: { random: "random-1", url: "https://cdn.authing.cn/qr.png" } })
    );
    const code = await geneAuthingQr(TARGET, { fetchImpl });
    expect(code).toEqual({ random: "random-1", url: "https://cdn.authing.cn/qr.png" });
    const call = calls[0]!;
    expect(call.url).toBe("https://core.authing.cn/api/v2/qrcode/gene");
    expect(call.init.method).toBe("POST");
    expect(headersOf(call)["x-authing-app-id"]).toBe("app-1");
    expect(headersOf(call)["x-authing-request-from"]).toBe("sdk");
    expect(bodyOf(call)).toEqual({ autoMergeQrCode: false, scene: "WXAPP_AUTH" });
  });

  it("gene 缺二维码字段时返回稳定错误", async () => {
    const { fetchImpl } = createFetch(() => jsonResponse({ code: 0, data: { random: "r" } }));
    await expect(geneAuthingQr(TARGET, { fetchImpl })).rejects.toBeInstanceOf(SdpppxHttpError);
  });

  it("check 解析状态与 userInfo 昵称头像", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({
        code: 200,
        data: {
          status: "2",
          ticket: "ticket-1",
          userInfo: { nickname: "微信昵称", photo: "https://cdn.example.com/p.png" }
        }
      })
    );
    const status = await checkAuthingQr(TARGET, "random/1", { fetchImpl });
    expect(status).toEqual({
      status: 2,
      ticket: "ticket-1",
      nickname: "微信昵称",
      avatarUrl: "https://cdn.example.com/p.png"
    });
    expect(calls[0]!.url).toBe("https://core.authing.cn/api/v2/qrcode/check?random=random%2F1");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("check 缺 status 时返回稳定错误，不把未知响应当未扫码", async () => {
    const { fetchImpl } = createFetch(() => jsonResponse({ code: 0, data: { ticket: "t" } }));
    await expect(checkAuthingQr(TARGET, "r", { fetchImpl })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.serviceUnavailable
    });
  });

  it("上游非零 code 映射为 wechat-unavailable，且不透出正文", async () => {
    const { fetchImpl } = createFetch(() =>
      jsonResponse({ code: 2001, message: "未开通微信身份源" })
    );
    await expect(geneAuthingQr(TARGET, { fetchImpl })).rejects.toMatchObject({
      code: SDPPPX_ERROR_CODES.wechatUnavailable,
      message: "Authing 返回错误码"
    });
  });

  it("userinfo 用 ticket 换 token", async () => {
    const { fetchImpl, calls } = createFetch(() =>
      jsonResponse({ code: 0, data: { token: "authing-token", nickname: "昵称" } })
    );
    const user = await exchangeAuthingUser(TARGET, "ticket-1", { fetchImpl });
    expect(user).toEqual({ token: "authing-token", nickname: "昵称" });
    expect(calls[0]!.url).toBe("https://core.authing.cn/api/v2/qrcode/userinfo");
    expect(bodyOf(calls[0]!)).toEqual({ ticket: "ticket-1" });
  });

  it("二维码图片转成 data URL；非图片类型拒绝", async () => {
    const ok = createFetch(() => pngResponse());
    const dataUrl = await fetchQrImageDataUrl("https://cdn.authing.cn/qr.png", { fetchImpl: ok.fetchImpl });
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);

    const html = createFetch(() => textResponse("<html></html>", { headers: { "content-type": "text/html" } }));
    await expect(
      fetchQrImageDataUrl("https://cdn.authing.cn/qr.png", { fetchImpl: html.fetchImpl })
    ).rejects.toBeInstanceOf(SdpppxHttpError);
  });
});
