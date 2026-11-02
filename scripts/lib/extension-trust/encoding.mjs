import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export class TrustError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "TrustError";
    this.code = "MARKETPLACE_SIGNATURE_INVALID";
    this.reason = reason;
  }
}

export function requireTrust(condition, reason, message = reason) {
  if (!condition) throw new TrustError(reason, message);
}

// Security control documents deliberately support only safe integer JSON numbers.
// Duplicate keys (including escaped aliases) must be rejected before JSON.parse loses them.
export function parseTrustJson(text, { maxBytes = 1024 * 1024, maxDepth = 24 } = {}) {
  requireTrust(typeof text === "string" && Buffer.byteLength(text) <= maxBytes, "invalid-json");
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(text[i] ?? "x")) i++; };
  function string() {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") { i += 2; continue; }
      if (text[i++] === '"') {
        const value = JSON.parse(text.slice(start, i));
        requireTrust(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), "invalid-unicode");
        return value;
      }
    }
    throw new TrustError("invalid-json", "Unterminated JSON string");
  }
  function value(depth) {
    requireTrust(depth <= maxDepth, "json-depth");
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{" || text[i] === "[") {
      const object = text[i++] === "{";
      const end = object ? "}" : "]";
      const out = object ? Object.create(null) : [];
      const seen = new Set();
      ws();
      if (text[i] === end) { i++; return out; }
      while (i < text.length) {
        let key;
        if (object) {
          requireTrust(text[i] === '"', "invalid-json");
          key = string();
          requireTrust(!seen.has(key), "duplicate-key");
          seen.add(key);
          ws();
          requireTrust(text[i++] === ":", "invalid-json");
        }
        const item = value(depth + 1);
        if (object) out[key] = item; else out.push(item);
        ws();
        if (text[i] === end) { i++; return out; }
        requireTrust(text[i++] === ",", "invalid-json");
        ws();
      }
      throw new TrustError("invalid-json", "Unterminated JSON container");
    }
    const token = /^(true|false|null|-?(?:0|[1-9][0-9]*))/.exec(text.slice(i));
    requireTrust(token, "invalid-json");
    i += token[0].length;
    const out = JSON.parse(token[0]);
    requireTrust(typeof out !== "number" || (Number.isSafeInteger(out) && !Object.is(out, -0)), "invalid-number");
    return out;
  }
  try {
    const out = value(0);
    ws();
    requireTrust(i === text.length, "invalid-json");
    return out;
  } catch (error) {
    if (error instanceof TrustError) throw error;
    throw new TrustError("invalid-json", "Invalid trust JSON");
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  requireTrust(value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value), "invalid-json-value");
  return JSON.stringify(value);
}

export const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

export function publicKey(value) {
  requireTrust(typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value), "invalid-key");
  const bytes = Buffer.from(value, "base64");
  requireTrust(bytes.toString("base64") === value, "invalid-key");
  let key;
  try { key = createPublicKey({ key: bytes, format: "der", type: "spki" }); }
  catch { throw new TrustError("invalid-key", "Invalid SPKI key"); }
  requireTrust(key.asymmetricKeyType === "ed25519" && key.export({ type: "spki", format: "der" }).equals(bytes), "invalid-key");
  return key;
}

export function fingerprint(value) {
  return createHash("sha256").update(publicKey(value).export({ type: "spki", format: "der" })).digest("hex");
}

export const signingBytes = signed => Buffer.from(`woohaa.extension-trust.v2\0${canonical(signed)}`, "utf8");

export function signEnvelope(signed, privateKeys) {
  const normalized = parseTrustJson(canonical(signed));
  return {
    signed: normalized,
    signatures: privateKeys.map(value => {
      const key = typeof value === "string" ? createPrivateKey(value) : value;
      requireTrust(key.asymmetricKeyType === "ed25519", "invalid-key");
      const pub = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
      return { keyId: fingerprint(pub), sig: sign(null, signingBytes(normalized), key).toString("base64") };
    })
  };
}

export function exact(value, fields) {
  requireTrust(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...fields].sort().join(","), "invalid-shape");
}

export function verifyEnvelope(envelope, keys, threshold) {
  exact(envelope, ["signed", "signatures"]);
  requireTrust(Number.isSafeInteger(threshold) && threshold > 0 && threshold <= Object.keys(keys).length, "invalid-threshold");
  requireTrust(Array.isArray(envelope.signatures) && envelope.signatures.length > 0 && envelope.signatures.length <= 32, "invalid-signatures");
  const seen = new Set();
  let count = 0;
  for (const signature of envelope.signatures) {
    exact(signature, ["keyId", "sig"]);
    requireTrust(typeof signature.keyId === "string" && !seen.has(signature.keyId), "duplicate-signature");
    seen.add(signature.keyId);
    requireTrust(typeof signature.sig === "string" && /^[A-Za-z0-9+/]{86}==$/.test(signature.sig), "invalid-signature");
    const bytes = Buffer.from(signature.sig, "base64");
    requireTrust(bytes.toString("base64") === signature.sig, "invalid-signature");
    if (!Object.hasOwn(keys, signature.keyId)) continue;
    requireTrust(fingerprint(keys[signature.keyId]) === signature.keyId, "key-id-mismatch");
    if (verify(null, signingBytes(envelope.signed), publicKey(keys[signature.keyId]), bytes)) count++;
  }
  requireTrust(count >= threshold, "signature-threshold");
  return envelope.signed;
}
