// Web Push (RFC 8291 aes128gcm payload encryption + RFC 8292 VAPID) using only WebCrypto,
// so it runs on Cloudflare Workers without Node libraries.
const enc = new TextEncoder();
export const b64u = {
  encode(buf) {
    let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  },
};
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// HKDF with a single output block (all lengths here are <= 32 bytes).
async function hkdf(salt, ikm, info, len) { return (await hmac(await hmac(salt, ikm), concat(info, new Uint8Array([1])))).slice(0, len); }

export async function encryptPayload(subscription, payload) {
  const uaPublic = b64u.decode(subscription.keys.p256dh), authSecret = b64u.decode(subscription.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

async function vapidAuth(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body));
  return `vapid t=${head}.${body}.${b64u.encode(sig)}, k=${vapid.publicKey}`;
}

/** Send one notification. Returns the HTTP status (404/410 = subscription is gone). */
export async function sendPush(subscription, payload, vapid, ttl = 900) {
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(subscription.endpoint, vapid),
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: String(ttl), Urgency: "high",
    },
    body: await encryptPayload(subscription, payload),
  });
  return res.status;
}
