/*
 * RowSkan encryption + merge library. Runs unchanged in browsers, the phone/Windows wrappers and Node 18+.
 * A product of LIT America (www.litamerica.net).
 *
 *  - Every device holds the same random 256-bit "account key". The relay only ever sees data encrypted with it
 *    (AES-GCM, fresh random IV each time, so any tampering is detected).
 *  - A new device receives the key through a one-time hand-off: it shows a QR containing its own throw-away public key,
 *    the signed-in device encrypts the key to it (ECDH P-256 -> HKDF -> AES-GCM). Only the new device can open it.
 *  - Vehicle records merge deterministically: the most recent edit of each field wins, photos are added together,
 *    deletions are remembered so old copies cannot bring a vehicle back.
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.RowSkanSync = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const C = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : require('crypto').webcrypto;
  const S = C.subtle, enc = new TextEncoder(), dec = new TextDecoder();

  /* ---- base64url helpers ---- */
  function b64u(buf) { const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function unb64u(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const s = atob(str), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
  const rand = (n) => C.getRandomValues(new Uint8Array(n));
  const randomId = (n) => b64u(rand(n || 12));

  /* ---- account key + symmetric encryption ---- */
  const newAccountKey = () => b64u(rand(32));
  const importKey = (keyB64) => S.importKey('raw', unb64u(keyB64), 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function encryptBytes(keyB64, bytes) {
    const iv = rand(12), ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv }, await importKey(keyB64), bytes));
    const out = new Uint8Array(12 + ct.length); out.set(iv, 0); out.set(ct, 12); return out; // iv || ciphertext+tag
  }
  async function decryptBytes(keyB64, bytes) {
    if (!bytes || bytes.length < 29) throw new Error('Corrupt data');
    return new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, await importKey(keyB64), bytes.subarray(12)));
  }
  const encryptJson = async (keyB64, obj) => b64u(await encryptBytes(keyB64, enc.encode(JSON.stringify(obj))));
  const decryptJson = async (keyB64, str) => JSON.parse(dec.decode(await decryptBytes(keyB64, unb64u(str))));

  /* ---- one-time hand-off to a new device (QR link) ---- */
  async function newLinkKeys() { // the NEW device makes this and shows the public part in the QR
    const kp = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    return { pub: b64u(await S.exportKey('raw', kp.publicKey)), priv: kp.privateKey, linkId: randomId(16) };
  }
  async function handoffKey(priv, otherPubB64) {
    const other = await S.importKey('raw', unb64u(otherPubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await S.deriveBits({ name: 'ECDH', public: other }, priv, 256);
    const hk = await S.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
    return b64u(new Uint8Array(await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('rowskan-link-v1'), info: enc.encode('handoff') }, hk, 256)));
  }
  async function sealHandoff(newPubB64, payload) { // the SIGNED-IN device encrypts {key, refreshToken, email, uid, ...}
    const eph = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const k = await handoffKey(eph.privateKey, newPubB64);
    return JSON.stringify({ v: 1, ep: b64u(await S.exportKey('raw', eph.publicKey)), ct: await encryptJson(k, payload) });
  }
  async function openHandoff(priv, text) {
    const j = JSON.parse(text); if (j.v !== 1) throw new Error('Unsupported link version');
    return decryptJson(await handoffKey(priv, j.ep), j.ct);
  }

  /* ---- vehicle records: deterministic merge ----
   * record = { vin, u, deleted?, decoded?, notes?, lotLocation?, capturedAt?, photos:[{id,takenAt}], removed:[photoId], f:{field:timestamp} }
   * f holds the time each editable field was last changed, so edits to DIFFERENT fields on two devices both survive. */
  const FIELDS = ['decoded', 'notes', 'lotLocation', 'capturedAt'];
  const later = (a, b) => (a || '') === (b || '') ? 0 : ((a || '') > (b || '') ? 1 : -1);
  function stamp(rec, fields, at) { rec.f = rec.f || {}; for (const k of fields) rec.f[k] = at; rec.u = at; return rec; }
  function mergeRecords(a, b) {
    if (!a) return clone(b); if (!b) return clone(a);
    const out = { vin: a.vin || b.vin, f: {}, photos: [], removed: [] };
    for (const k of FIELDS) {
      const fa = (a.f || {})[k], fb = (b.f || {})[k], c = later(fa, fb);
      const pick = c > 0 ? a : c < 0 ? b : (JSON.stringify(a[k] === undefined ? null : a[k]) >= JSON.stringify(b[k] === undefined ? null : b[k]) ? a : b);
      if (pick[k] !== undefined) out[k] = clone(pick[k]);
      const t = c >= 0 ? fa : fb; if (t) out.f[k] = t;
    }
    const gone = new Set([].concat(a.removed || [], b.removed || [])); out.removed = Array.from(gone).sort();
    // the latest deletion time is always remembered (even when a later edit brought the vehicle back), so photos taken
    // before it stay gone no matter which order the messages arrive in
    const dt = later(a.deletedAt, b.deletedAt) >= 0 ? (a.deletedAt || '') : (b.deletedAt || '');
    const seen = new Map();
    for (const p of [].concat(a.photos || [], b.photos || [])) { if (!gone.has(p.id) && !seen.has(p.id) && !(dt && (p.takenAt || '') <= dt)) seen.set(p.id, { id: p.id, takenAt: p.takenAt }); }
    out.photos = Array.from(seen.values()).sort((x, y) => (x.takenAt || '').localeCompare(y.takenAt || '') || x.id.localeCompare(y.id));
    out.u = later(a.u, b.u) >= 0 ? a.u : b.u;
    // deletion: whichever of "delete" and "latest edit" is newer wins
    const lastEdit = Object.keys(out.f).reduce((m, k) => later(out.f[k], m) > 0 ? out.f[k] : m, '');
    if (dt) { out.deletedAt = dt; if (later(dt, lastEdit) >= 0) out.deleted = true; }
    return out;
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const sameRecord = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  function canon(o) { if (Array.isArray(o)) return o.map(canon); if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o).sort()) r[k] = canon(o[k]); return r; } return o; }

  /* ---- wire messages (what gets encrypted and sent) ---- */
  // {t:'rec', rec} = one vehicle record; {t:'hello'} / {t:'need-history'} are control messages
  const encodeMessage = (keyB64, msg) => encryptJson(keyB64, msg);
  const decodeMessage = (keyB64, text) => decryptJson(keyB64, text);

  return { b64u, unb64u, randomId, newAccountKey, encryptBytes, decryptBytes, encryptJson, decryptJson,
    newLinkKeys, sealHandoff, openHandoff, FIELDS, stamp, mergeRecords, sameRecord, encodeMessage, decodeMessage };
});
