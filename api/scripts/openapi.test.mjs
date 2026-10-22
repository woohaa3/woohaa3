import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { enrich, renderHTML } from './openapi-model.mjs';

const spec = JSON.parse(await readFile(new URL('../openapi/openapi.json', import.meta.url), 'utf8'));

test('new, removed, or additional-transport RPCs require explicit documentation review', () => {
  const added = structuredClone(spec);
  added.paths['/woohaa.future.v1.Service/Unsafe'] = { post: {} };
  assert.throws(() => enrich(added), /coverage has drifted/);
  const removed = structuredClone(spec);
  delete removed.paths['/woohaa.rbac.v1alpha1.RBACService/RevokeBinding'];
  assert.throws(() => enrich(removed), /coverage has drifted/);
  const changed = structuredClone(spec);
  changed.paths['/woohaa.rbac.v1alpha1.RBACService/GetSelf'].get = {};
  assert.throws(() => enrich(changed), /Unexpected transport/);
});

test('public, scoped, and administrative requirements remain distinguishable', () => {
  const operation = path => spec.paths[path].post;
  assert.deepEqual(operation('/woohaa.ops.v1.OpsService/GetServerInfo').security, []);
  const scoped = operation('/woohaa.canvas.v1.CanvasService/GetCanvasStats');
  assert.equal(scoped['x-woohaa-auth'].scope, 'canvasId');
  assert.equal(scoped['x-woohaa-auth'].permission, 'canvas.read');
  const admin = operation('/woohaa.telemetry.v1alpha1.TelemetryAdminService/ListEvents');
  assert.deepEqual(admin.security, [{ bearerAuth: [] }]);
  assert.equal(admin['x-woohaa-auth'].permission, 'rbac.manage');
  assert.equal(admin['x-woohaa-auth'].scope, '*');
  assert.equal(admin['x-connect-get-supported'], true);
  const report = operation('/woohaa.telemetry.v1alpha1.TelemetryService/ReportEvents');
  assert.equal(report['x-woohaa-auth'].mode, 'authenticated');
  assert.equal(report['x-connect-get-supported'], false);
  assert(report.responses['429']);
});

test('ProtoJSON numeric and symbolic enums match runtime accepted values', () => {
  const action = spec.components.schemas['woohaa.telemetry.v1alpha1.Action'];
  assert.deepEqual(action.type, ['string', 'integer']);
  assert(action.enum.includes(6));
  assert(action.enum.includes('ACTION_LOCAL_VALIDATION'));
  assert(!action.enum.includes(0));
  assert(!action.enum.includes('ACTION_UNSPECIFIED'));
  const request = spec.components.schemas['woohaa.telemetry.v1alpha1.ReportEventsRequest'];
  assert.equal(request.properties.events.maxItems, 100);
});

test('HTML embeds the contract safely without enabling API calls or remote validation', () => {
  const malicious = structuredClone(spec);
  malicious.info.description = '</script><script>alert(1)</script>';
  const html = renderHTML(malicious);
  assert(!html.includes(malicious.info.description));
  assert(html.includes('supportedSubmitMethods:[]'));
  assert(html.includes('validatorUrl:null'));
  assert(html.includes('spec:{'));
});
