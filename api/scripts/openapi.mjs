import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { enrich, renderHTML } from './openapi-model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--write';
assert(['--write', '--check'].includes(mode), 'Use --write or --check');
const temporary = await mkdtemp(join(tmpdir(), 'woohaa-openapi-'));
const temporaryReal = await realpath(temporary);
try {
  // The recording control plane is a local-only contract: it has no Connect RPC
  // service and must never appear in the public HTTP contract.
  execFileSync(join(root, 'node_modules/.bin/buf'), ['generate', '--template', 'buf.gen.openapi.yaml', '--exclude-path', 'proto/woohaa/recording', '--output', temporary], { cwd: root, stdio: 'inherit' });
  const spec = enrich(JSON.parse(await readFile(join(temporary, 'openapi/openapi.json'), 'utf8')));
  const validator = new Validator();
  const result = await validator.validate(spec);
  assert(result.valid, JSON.stringify(result.errors, null, 2));
  // Validate every local reference as well as the OpenAPI document shape.
  function references(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert(value.$ref.startsWith('#/'), 'Only local references are allowed');
      let target = spec;
      for (const part of value.$ref.slice(2).split('/')) target = target?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
      assert(target, `Unresolved reference: ${value.$ref}`);
    }
    for (const child of Object.values(value)) references(child);
  }
  references(spec);
  const artifacts = { 'openapi.json': JSON.stringify(spec, null, 2) + '\n', 'index.html': renderHTML(spec) };
  for (const [name, content] of Object.entries(artifacts)) {
    const destination = join(root, 'openapi', name);
    if (mode === '--check') {
      let current;
      try { current = await readFile(destination, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.equal(current, content, `${name} is missing or stale; run pnpm -C api run docs:gen`);
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
  console.log(`OpenAPI 3.1 validated: ${Object.keys(spec.paths).length} RPCs; ${mode === '--check' ? 'documents match generated output' : 'JSON and HTML generated'}.`);
} finally {
  // Only remove the exact, newly-created temporary directory, never an output path.
  assert.equal(await realpath(temporary), temporaryReal);
  assert(temporaryReal.startsWith(await realpath(tmpdir()) + '/woohaa-openapi-'));
  await rm(temporaryReal, { recursive: true });
}
