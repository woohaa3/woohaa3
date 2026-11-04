import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readInventoryIds,sixiDeploymentEnv,INVENTORY_FILE,SDK_HOSTS_PLACEHOLDER} from './sixi-deployment-env.mjs';

// 这份清单守的是「发行版只装四喜必需的那几个扩展」。上游 51ed5d16 删掉了旧清单文件后，
// 白名单静默退化成「不过滤」，六个第三方 provider 全回到了设置页，所以这里必须有单测。
//
// `sqlite-storage` 不能漏：槽位声明只认 `extension.json` 的 `bootstrap`，而它的是**唯一**
// 声明 `storage` 槽位的扩展（`local-storage` 只有 `hostPlugin`，是对象存储后端，顶不上）。
// 漏掉它宿主启动时 fail-fast：`EXTENSION_SLOT_MISSING 缺少必需槽位 storage`。
test('清单读得到，且只含四喜发行版的这批扩展', () => {
  const ids = readInventoryIds();
  assert.ok(ids.length > 0, `清单为空或读不到：${INVENTORY_FILE}`);
  assert.deepEqual([...ids].sort(), [
    'alignment-guides', 'film-set', 'local-storage', 'ppserver-provider',
    'prompt-skills', 'sixi-spike', 'sqlite-storage'
  ]);
});

/**
 * `film-set` 不能漏：它是画布核心功能（创建片场、镜头、动画），`extension.json` 标了
 * `required: true`。白名单对内置/受管/开发者三种来源一视同仁，漏掉它不会报错，只是
 * 扩展不装配 —— 表现为「创建片场」横条按钮与右键菜单项全部消失，图片和 3D 卡片上都没有。
 */
test('film-set 在清单里（画布核心功能，漏了会静默消失）', () => {
  assert.ok(readInventoryIds().includes('film-set'));
});

test('白名单不依赖仓库根：不传 repoRoot 也照常注入', () => {
  const env = sixiDeploymentEnv({inherited: {}});
  assert.equal(
    env.WOOHAA3_EXTENSION_ALLOWLIST,
    'ppserver-provider,sixi-spike,local-storage,sqlite-storage,prompt-skills,film-set,alignment-guides'
  );
});

test('显式环境变量优先，写成 * 时不注入清单而是显式放开', () => {
  assert.equal(sixiDeploymentEnv({inherited: {WOOHAA3_EXTENSION_ALLOWLIST: '*'}}).WOOHAA3_EXTENSION_ALLOWLIST, '*');
  assert.equal(
    sixiDeploymentEnv({inherited: {WOOHAA3_EXTENSION_ALLOWLIST: 'a, b '}}).WOOHAA3_EXTENSION_ALLOWLIST,
    'a, b'
  );
});

test('sdk-agent 的 host 收口仍在', () => {
  const env = sixiDeploymentEnv({inherited: {}});
  assert.equal(env.WOOHAA3_SDK_AGENT_ALLOWED_HOSTS, SDK_HOSTS_PLACEHOLDER);
  assert.equal(env.WOOHAA3_SDK_AGENT_BUILTIN_HOSTS, '0');
  assert.equal(sixiDeploymentEnv({inherited: {WOOHAA3_SDK_AGENT_BUILTIN_HOSTS: '1'}}).WOOHAA3_SDK_AGENT_BUILTIN_HOSTS, '1');
});
