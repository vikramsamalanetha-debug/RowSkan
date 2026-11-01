'use strict';
/*
 * RowSkan relay - a "mailbox" between one account's devices. A product of LIT America (www.litamerica.net).
 *
 *  - Every request carries a Firebase ID token (Authorization: Bearer ...). The relay verifies it itself
 *    (RS256, Google's public certificates) and only ever touches data under that account's uid.
 *  - It stores ONLY ciphertext it cannot read (devices encrypt on the device).
 *  - A change sits in each recipient device's mailbox until that device acknowledges it, then it is deleted.
 *    Anything not delivered within RELAY_TTL_DAYS (default 30) is deleted.
 *  - DELETE /v1/account wipes everything held for the account.
 *
 * Zero dependencies (Node >= 18). Storage sits behind a small adapter; this file ships the file-system one.
 * Settings (environment): RELAY_PROJECT_ID (Firebase project id, required), RELAY_DATA, RELAY_PORT,
 *   RELAY_TTL_DAYS, RELAY_QUOTA_BYTES, RELAY_CERTS_URL (tests only).
 */
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const CFG = {
  project: process.env.RELAY_PROJECT_ID || '',
  data: process.env.RELAY_DATA || path.join(__dirname, 'relay-data'),
  port: +(process.env.RELAY_PORT || 8787),
  ttlMs: +(process.env.RELAY_TTL_DAYS || 30) * 86400000,
  quota: +(process.env.RELAY_QUOTA_BYTES || 500 * 1024 * 1024),
  certsUrl: process.env.RELAY_CERTS_URL || 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
  maxMsg: 256 * 1024, maxBlob: 12 * 1024 * 1024, maxDevices: 10, orphanMs: 3600000,
};
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

/* ---------------------------------------------------------------- Firebase ID token verification */
let certCache = { at: 0, keys: {} };
function getJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), lib = u.protocol === 'https:' ? https : http;
    lib.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: 10000 }, (r) => {
      const ch = []; r.on('data', (c) => ch.push(c));
      r.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString())); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
async function certs() {
  if (now() - certCache.at < 3600000 && Object.keys(certCache.keys).length) return certCache.keys;
  const j = await getJson(CFG.certsUrl);
  const keys = {}; for (const kid of Object.keys(j)) { try { keys[kid] = new crypto.X509Certificate(j[kid]).publicKey; } catch (e) { /* skip */ } }
  certCache = { at: now(), keys }; return keys;
}
const b64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function verifyToken(header) {
  const m = /^Bearer\s+(\S+)$/.exec(header || ''); if (!m) return null;
  const parts = m[1].split('.'); if (parts.length !== 3) return null;
  let h, p; try { h = JSON.parse(b64u(parts[0]).toString()); p = JSON.parse(b64u(parts[1]).toString()); } catch (e) { return null; }
  if (h.alg !== 'RS256' || !h.kid) return null;
  let keys; try { keys = await certs(); } catch (e) { return null; }
  const key = keys[h.kid]; if (!key) return null;
  const v = crypto.createVerify('RSA-SHA256'); v.update(parts[0] + '.' + parts[1]);
  if (!v.verify(key, b64u(parts[2]))) return null;
  const t = Math.floor(now() / 1000);
  if (!CFG.project || p.aud !== CFG.project || p.iss !== 'https://securetoken.google.com/' + CFG.project) return null;
  if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 128 || !(p.exp > t) || p.iat > t + 300) return null;
  return p.sub;
}

/* ---------------------------------------------------------------- storage (file-system adapter) */
const locks = new Map(); // per-account queue so concurrent requests never interleave
function withLock(uid, fn) {
  const prev = locks.get(uid) || Promise.resolve();
  const run = prev.then(fn, fn), tail = run.catch(() => {});
  locks.set(uid, tail); tail.then(() => { if (locks.get(uid) === tail) locks.delete(uid); });
  return run;
}
const dirOf = (uid) => path.join(CFG.data, sha(uid).slice(0, 40));
function load(uid) {
  try { return JSON.parse(fs.readFileSync(path.join(dirOf(uid), 'state.json'), 'utf8')); }
  catch (e) { return { devices: {}, seq: {}, msgs: {}, blobs: {}, bytes: 0 }; }
}
function save(uid, st) {
  const d = dirOf(uid); fs.mkdirSync(path.join(d, 'blobs'), { recursive: true });
  const tmp = path.join(d, 'state.json.tmp'); fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, path.join(d, 'state.json'));
}
const blobFile = (uid, id) => path.join(dirOf(uid), 'blobs', id);
function dropBlob(uid, st, id) { const b = st.blobs[id]; if (!b) return; st.bytes -= b.size; delete st.blobs[id]; try { fs.unlinkSync(blobFile(uid, id)); } catch (e) { /* gone */ } }
function sweep(uid, st) { // expire undelivered mail and orphan blobs
  const t = now(); let changed = false;
  for (const dev of Object.keys(st.msgs)) {
    const keep = [];
    for (const m of st.msgs[dev]) { if (t - m.ts > CFG.ttlMs) { st.bytes -= m.size; releaseBlobs(uid, st, dev, m.blobs); changed = true; } else keep.push(m); }
    st.msgs[dev] = keep;
  }
  for (const id of Object.keys(st.blobs)) { const b = st.blobs[id]; if ((!b.used && t - b.ts > CFG.orphanMs) || t - b.ts > CFG.ttlMs) { dropBlob(uid, st, id); changed = true; } }
  return changed;
}
function releaseBlobs(uid, st, dev, ids) {
  for (const id of ids || []) { const b = st.blobs[id]; if (!b) continue; b.to = b.to.filter((d) => d !== dev); if (!b.to.length) dropBlob(uid, st, id); }
}

/* ---------------------------------------------------------------- handlers */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const need = (c, status, msg) => { if (!c) throw new HttpError(status, msg); };

const routes = {
  'POST /v1/devices': (uid, st, ctx) => { // register (or refresh) this device
    const b = ctx.json, id = b.deviceId;
    need(ID_RE.test(id || ''), 400, 'Invalid deviceId.');
    const name = String(b.name || '').slice(0, 60), kind = ['phone', 'web', 'windows', 'other'].includes(b.kind) ? b.kind : 'other';
    need(st.devices[id] || Object.keys(st.devices).length < CFG.maxDevices, 409, 'This account already has ' + CFG.maxDevices + ' devices. Remove one first.');
    st.devices[id] = { name, kind, pub: String(b.pub || '').slice(0, 2048), addedAt: (st.devices[id] || {}).addedAt || now() };
    st.msgs[id] = st.msgs[id] || []; st.seq[id] = st.seq[id] || 0;
    return { ok: true, devices: Object.keys(st.devices).length };
  },
  'GET /v1/devices': (uid, st) => ({ devices: Object.keys(st.devices).map((id) => ({ deviceId: id, name: st.devices[id].name, kind: st.devices[id].kind, pub: st.devices[id].pub, addedAt: st.devices[id].addedAt })) }),
  'DELETE /v1/devices': (uid, st, ctx) => {
    const id = ctx.query.get('deviceId'); need(st.devices[id], 404, 'Unknown device.');
    for (const m of st.msgs[id] || []) { st.bytes -= m.size; releaseBlobs(uid, st, id, m.blobs); }
    delete st.devices[id]; delete st.msgs[id]; delete st.seq[id];
    for (const b of Object.keys(st.blobs)) { st.blobs[b].to = st.blobs[b].to.filter((d) => d !== id); if (!st.blobs[b].to.length && st.blobs[b].used) dropBlob(uid, st, b); }
    return { ok: true };
  },
  'POST /v1/send': (uid, st, ctx) => { // put one ciphertext message into the mailboxes of other devices
    const b = ctx.json, from = b.from;
    need(st.devices[from], 404, 'Unknown sending device.');
    const kind = ['change', 'ctl'].includes(b.kind) ? b.kind : null; need(kind, 400, 'Bad kind.');
    need(typeof b.payload === 'string' && b.payload.length > 0 && Buffer.byteLength(b.payload) <= CFG.maxMsg, 413, 'Message too large.');
    const to = (Array.isArray(b.to) && b.to.length ? b.to : Object.keys(st.devices)).filter((d) => d !== from);
    need(to.every((d) => st.devices[d]), 404, 'Unknown receiving device.');
    const blobs = Array.isArray(b.blobs) ? b.blobs.slice(0, 50) : [];
    for (const id of blobs) { need(st.blobs[id] && st.blobs[id].from === from, 400, 'Unknown attachment ' + id + '.'); }
    const size = Buffer.byteLength(b.payload), id = crypto.randomBytes(12).toString('hex'), ts = now();
    need(st.bytes + size * to.length <= CFG.quota, 507, 'This account has too much undelivered data waiting. Open the other devices so they can receive it.');
    for (const d of to) { st.seq[d] += 1; st.msgs[d].push({ seq: st.seq[d], id, from, kind, payload: b.payload, blobs, ts, size }); st.bytes += size; }
    for (const bid of blobs) { st.blobs[bid].used = true; st.blobs[bid].to = Array.from(new Set(st.blobs[bid].to.concat(to))); }
    return { ok: true, id, delivered_to: to.length };
  },
  'GET /v1/inbox': (uid, st, ctx) => {
    const dev = ctx.query.get('device'); need(st.devices[dev], 404, 'This device is not registered (it may have been removed). Link it again.');
    const after = +(ctx.query.get('after') || 0), limit = Math.min(200, +(ctx.query.get('limit') || 100));
    const list = (st.msgs[dev] || []).filter((m) => m.seq > after).slice(0, limit).map((m) => ({ seq: m.seq, id: m.id, from: m.from, kind: m.kind, payload: m.payload, blobs: m.blobs, ts: m.ts }));
    return { messages: list, more: (st.msgs[dev] || []).filter((m) => m.seq > after).length > list.length };
  },
  'POST /v1/ack': (uid, st, ctx) => { // the device has stored everything up to seq: delete it from the relay
    const b = ctx.json, dev = b.device, upTo = +b.upTo;
    need(st.devices[dev], 404, 'Unknown device.'); need(Number.isFinite(upTo) && upTo >= 0, 400, 'Bad upTo.');
    const keep = []; let n = 0;
    for (const m of st.msgs[dev]) { if (m.seq <= upTo) { st.bytes -= m.size; releaseBlobs(uid, st, dev, m.blobs); n++; } else keep.push(m); }
    st.msgs[dev] = keep; return { ok: true, deleted: n };
  },
  'DELETE /v1/account': (uid, st) => { for (const id of Object.keys(st.blobs)) dropBlob(uid, st, id); st.devices = {}; st.msgs = {}; st.seq = {}; st.blobs = {}; st.bytes = 0; ctx_wipe = true; return { ok: true }; },
};
let ctx_wipe = false;

/* ---------------------------------------------------------------- blobs (raw bytes, ciphertext) */
async function blobPut(uid, req, query, res) {
  const id = query.get('id'), from = query.get('from'), to = (query.get('to') || '').split(',').filter(Boolean);
  if (!ID_RE.test(id || '')) throw new HttpError(400, 'Invalid blob id.');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n <= CFG.maxBlob) chunks.push(c); } // keep reading (discarding) so the client gets a clean answer
  if (n > CFG.maxBlob) throw new HttpError(413, 'Photo too large.');
  const body = Buffer.concat(chunks);
  return withLock(uid, async () => {
    const st = load(uid);
    need(st.devices[from], 404, 'Unknown sending device.');
    const targets = (to.length ? to : Object.keys(st.devices)).filter((d) => d !== from);
    need(targets.length && targets.every((d) => st.devices[d]), 404, 'Unknown receiving device.');
    need(!st.blobs[id], 409, 'That attachment id is already used.');
    need(st.bytes + body.length <= CFG.quota, 507, 'This account has too much undelivered data waiting.');
    fs.mkdirSync(path.join(dirOf(uid), 'blobs'), { recursive: true }); fs.writeFileSync(blobFile(uid, id), body);
    st.blobs[id] = { from, to: targets, size: body.length, ts: now(), used: false }; st.bytes += body.length; save(uid, st);
    return { ok: true, id };
  });
}
async function blobGet(uid, query, res) {
  const id = query.get('id'), dev = query.get('device');
  if (!ID_RE.test(id || '')) throw new HttpError(400, 'Invalid blob id.');
  return withLock(uid, async () => {
    const st = load(uid); const b = st.blobs[id];
    need(st.devices[dev] && b && b.to.includes(dev), 404, 'No such attachment for this device.');
    return fs.readFileSync(blobFile(uid, id));
  });
}

/* ---------------------------------------------------------------- server */
const rate = new Map(); // uid -> {n, until} simple burst limiter (600 requests / minute)
function limited(uid) { const t = now(), r = rate.get(uid) || { n: 0, reset: t + 60000 }; if (t > r.reset) { r.n = 0; r.reset = t + 60000; } r.n++; rate.set(uid, r); return r.n > 600; }
function send(res, code, obj, raw) {
  const body = raw || Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
  res.end(body);
}
async function readJson(req) {
  const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n <= CFG.maxMsg + 4096) ch.push(c); }
  if (n > CFG.maxMsg + 4096) throw new HttpError(413, 'Message too large.');
  try { return JSON.parse(Buffer.concat(ch).toString() || '{}'); } catch (e) { throw new HttpError(400, 'Bad JSON.'); }
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const u = new URL(req.url, 'http://x'), key = req.method + ' ' + u.pathname;
    if (key === 'GET /health') return send(res, 200, { ok: true });
    if (!CFG.project) return send(res, 503, { error: 'Relay not configured (RELAY_PROJECT_ID).' });
    const uid = await verifyToken(req.headers.authorization);
    if (!uid) return send(res, 401, { error: 'Sign in again.' });
    if (limited(uid)) return send(res, 429, { error: 'Slow down.' });
    if (key === 'PUT /v1/blob') return send(res, 200, await blobPut(uid, req, u.searchParams, res));
    if (key === 'GET /v1/blob') return send(res, 200, null, await blobGet(uid, u.searchParams, res));
    const h = routes[key]; if (!h) return send(res, 404, { error: 'Not found.' });
    const ctx = { query: u.searchParams, json: (req.method === 'POST') ? await readJson(req) : {} };
    const out = await withLock(uid, async () => {
      const st = load(uid); const swept = sweep(uid, st); ctx_wipe = false;
      const r = h(uid, st, ctx);
      if (ctx_wipe) { fs.rmSync(dirOf(uid), { recursive: true, force: true }); return r; }
      save(uid, st); return r;
    });
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('relay error:', e && e.message); send(res, 500, { error: 'Relay problem. Try again.' });
  }
});
if (require.main === module) {
  server.listen(CFG.port, () => console.log('RowSkan relay on :' + CFG.port + (CFG.project ? '' : '  (NOT CONFIGURED: set RELAY_PROJECT_ID)')));
}
module.exports = { server, CFG, sweepAll: (uid) => withLock(uid, async () => { const st = load(uid); if (sweep(uid, st)) save(uid, st); }) };
