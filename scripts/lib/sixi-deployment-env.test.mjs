import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readInventoryIds,sixiDeploymentEnv,INVENTORY_FILE,SDK_HOSTS_PLACEHOLDER} from './sixi-deployment-env.mjs';

// 这份清单守的是「发行版只装四喜必需的那几个扩展」。上游 51ed5d16 删掉了旧清单文件后，
// 白名单静默退化成「不过滤」，六个第三方 provider 全回到了设置页，所以这里必须有单测。
test('清单读得到，且只含四喜发行版的四个扩展', () => {
  const ids = readInventoryIds();
  assert.ok(ids.length > 0, `清单为空或读不到：${INVENTORY_FILE}`);
  assert.deepEqual([...ids].sort(), ['local-storage', 'ppserver-provider', 'prompt-skills', 'sixi-spike']);
});

test('白名单不依赖仓库根：不传 repoRoot 也照常注入', () => {
  const env = sixiDeploymentEnv({inherited: {}});
  assert.equal(env.WOOHAA3_EXTENSION_ALLOWLIST, 'ppserver-provider,sixi-spike,local-storage,prompt-skills');
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
