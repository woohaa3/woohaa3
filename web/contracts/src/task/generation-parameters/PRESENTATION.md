# 参数展示声明

`parameter-schema.ts` 的 `x-pptask-presentation` 是可选的展示建议，不改变 schema 值域、默认值或执行验证。由拥有该字段真实语义的模型卡片 / Provider 声明，不按 key、模型名或厂商猜测。

```ts
{
  type: "number", title: "时长", minimum: 4, maximum: 15, default: 5, unit: "秒",
  "x-pptask-presentation": {
    section: "common", order: 30, summaryOrder: 30,
    semanticId: "video.duration-seconds", control: "slider"
  }
}
```

section 为 common / advanced；order 为稳定排序（同值保持 schema 顺序）；summaryOrder 决定最多三个摘要字段；semanticId 只在跨模型语义、类型、单位一致时允许迁移；control 只能是与类型兼容的 segmented / search-select / slider / number / switch / textarea。非法成员单独忽略，其余建议继续生效。无声明字段仍可高级编辑；已有显式比例、分辨率、质量、背景、音色语义保留公共兼容投影。

`controls.ts` 的 CONTROL_PRESENTATION 只声明它自己拥有的有限语义集合；`compose.ts` 给当前模型卡片最终保留的属性附加元数据。音频 speech / music、视频各模式继续由各自模型卡片决定字段集合。动态旧模型不强制增加声明。必填结构化字段没有合法默认时，generic 提供诊断并拒绝提交，由专用 interaction 负责编辑。
