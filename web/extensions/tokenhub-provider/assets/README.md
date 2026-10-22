# tokenhub-provider 品牌图形

`icon.png` 是设置页插件卡片用的第三方品牌图形，随扩展包发布。

来源：腾讯云官网分享图标 <https://cloudcache.tencent-cloud.com/open_proj/proj_qcloud_v2/gateway/shareicons/cloud.png>（300×300 PNG，2026-10-16 取得）。TokenHub 产品页 <https://cloud.tencent.com/product/tokenhub> 与文档站使用同一枚腾讯云标志；`tokenhub.tencentmaas.com` 没有单独的站点图标。

- 用途：TokenHub Provider 在设置页的卡片图标。
- 处理：文件按字节原样复制，像素未做修改。
- 归属：腾讯云与 TokenHub 名称及图形归腾讯云所有。

新增或更换图形时：保持文件名 `icon.png`，更新本文件的来源说明，并在 `extension.json` 的 `icon.asset` 里指向它；宿主目录里的副本由 `pnpm -C web run icons:sync` 生成。
