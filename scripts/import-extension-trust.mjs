#!/usr/bin/env node
import path from "node:path";
import { runtimeTrust } from "./lib/extension-trust/runtime.mjs";
import { readTrustDocument } from "./lib/extension-trust/store.mjs";

// Require the exact host data directory: importing into an accidental cwd is unsafe.
const [managedRoot, trustDomain, file, ...extra] = process.argv.slice(2);
if (!managedRoot || !trustDomain || !file || extra.length) {
  console.error("Usage: WOOHAA3_EXTENSION_TRUST_CONFIG=<pinned-config.json> node scripts/import-extension-trust.mjs <managed-root> <trust-domain> <signed-material.json>");
  process.exitCode = 1;
} else {
  try {
    const runtime = runtimeTrust({ managedRoot: path.resolve(managedRoot) });
    runtime.importMaterial(trustDomain, readTrustDocument(path.resolve(file)));
    console.log(`Imported verified metadata for ${trustDomain}`);
  } catch (error) {
    console.error(`Trust import rejected: ${error.reason ?? error.message}`);
    process.exitCode = 1;
  }
}
