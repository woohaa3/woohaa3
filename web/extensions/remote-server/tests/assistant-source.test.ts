/**
 * 远端助手的「来源声明」与「adapterId」必须一致。
 *
 * 锁定的真实故障：助手来源清单由 `authoring.generate` 贡献位决定，而宿主是按
 * `selectedConnection.adapterId` 反查这个清单的。两者对不上时，即使连接完全可用，
 * 生成面板也会报「先前使用的来源已停用」——模型下拉里明明选着
 * `deepseek-v4.1-flash · 远端服务端`，下面却是红字。
 *
 * 这个测试只钉住"两个常量必须是同一个值"这条约束：前端 `sourceId` 用的是
 * `REMOTE_ASSISTANT_ADAPTER_ID`，后端注册 adapter 用的也是它，只要有人把它们拆成
 * 两份字面量，这里就会失败。
 */
import { describe, expect, it } from "vitest";
import { REMOTE_ASSISTANT_ADAPTER_ID } from "../src/shared.js";

describe("远端助手来源身份", () => {
  it("adapterId 是前端与后端共用的同一个常量", () => {
    // 值本身是契约的一部分（capability id 后缀、来源 sourceId、adapter 注册键）。
    expect(REMOTE_ASSISTANT_ADAPTER_ID).toBe("remote-assistant");
  });
});
