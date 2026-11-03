'use strict';
/*
 * RowSkan - computer app (server + dashboard host)
 * A product of LIT America - https://www.litamerica.net
 *
 * Zero npm dependencies. Needs Node 18+ and the `openssl` command (for the
 * local HTTPS certificate; ships with macOS/Linux/Git for Windows).
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const QRCode = require('./lib/qr/index.js');
const QRLevel = require('./lib/qr/QRErrorCorrectLevel.js');

const ROOT = __dirname;
const DATA_DIR = process.env.ROWSKAN_DATA || path.join(ROOT, 'data');
const VEH_DIR = path.join(DATA_DIR, 'vehicles');
const CERT_DIR = path.join(DATA_DIR, 'certs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HTTPS_PORT = parseInt(process.env.ROWSKAN_HTTPS_PORT || '8443', 10);
const HTTP_PORT = parseInt(process.env.ROWSKAN_HTTP_PORT || '8080', 10);
const MAX_PHOTO = 30 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;

fs.mkdirSync(VEH_DIR, { recursive: true });
fs.mkdirSync(CERT_DIR, { recursive: true });

/* ---------------------------------------------------------------- config */
function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { /* first run */ }
  delete cfg.key; // legacy shared access key (replaced by per-phone keys)
  if (!Array.isArray(cfg.devices)) cfg.devices = [];
  if (!cfg.createdAt) cfg.createdAt = new Date().toISOString();
  if (!cfg.name) cfg.name = os.hostname();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}
const config = loadConfig();
function saveConfig() { writeJsonAtomic(CONFIG_FILE, config); }

/* ------------------------------------------------------- account (email + password) */
// Sign-up / sign-in use Firebase Authentication (same service as DayZift) through its public REST API.
// The project's Web API key is put in account.config.json {"firebaseApiKey": "..."} or ROWSKAN_FIREBASE_API_KEY.
// A Firebase web API key is designed to be public. Passwords are only forwarded to Firebase, never stored or logged here.
// "Forgot password" makes Firebase email a reset link to the registered address.
// ROWSKAN_ACCOUNT_DEV=1 is for demos/testing only: accounts live in memory on this computer.
const ACCOUNT_CFG = (() => {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(process.env.ROWSKAN_ACCOUNT_CONFIG || path.join(ROOT, 'account.config.json'), 'utf8')); } catch (e) { /* not set up */ }
  return { key: String(process.env.ROWSKAN_FIREBASE_API_KEY || c.firebaseApiKey || '').trim(),
    base: String(process.env.ROWSKAN_FIREBASE_BASE || 'https://identitytoolkit.googleapis.com').replace(/\/+$/, '') };
})();
const ACCOUNT_DEV = process.env.ROWSKAN_ACCOUNT_DEV === '1';
const accountConfigured = () => ACCOUNT_DEV || !!ACCOUNT_CFG.key;
if (config.account && config.account.provider === 'dev' && !ACCOUNT_DEV) { delete config.account; saveConfig(); } // test registrations never carry over
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const maskEmail = (e) => { const [u, d] = String(e || '').split('@'); return u ? u.slice(0, 1) + '***@' + d : ''; };
const devUsers = new Map();  // demo mode only: email -> { salt, hash }
const lastSent = new Map();  // email -> time a reset code was last requested
const signinFails = new Map(); // email -> { n, until }
const COMMON_PW = new Set(['password', 'password1', 'password12', 'password123', '12345678', '123456789', '1234567890', '11111111', '00000000', 'qwertyui', 'qwerty123', 'abcd1234', 'abc12345', 'iloveyou', 'letmein1', 'welcome1', 'admin123', 'rowskan1', 'rowskan123']);
function checkPassword(pw) {
  if (typeof pw !== 'string' || !pw) return 'Enter a password.';
  if (pw.length < 8) return 'Use at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Use 72 characters or fewer.';
  if (/^(.)\1+$/.test(pw) || COMMON_PW.has(pw.toLowerCase())) return 'That password is too easy to guess. Choose another one.';
  return null;
}
const scryptHash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function jsonRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr), lib = u.protocol === 'https:' ? https : http, data = body ? JSON.stringify(body) : null;
    const rq = lib.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, timeout: 15000,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => {
      const ch = []; r.on('data', (c) => ch.push(c));
      r.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(ch).toString('utf8')); } catch (e) { /* not json */ } resolve({ status: r.statusCode, json: j }); });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout'))); rq.on('error', reject);
    if (data) rq.write(data); rq.end();
  });
}
const fbUrl = (op) => ACCOUNT_CFG.base + '/v1/accounts:' + op + '?key=' + encodeURIComponent(ACCOUNT_CFG.key);
const NOT_CONFIGURED = { status: 503, body: { error: 'Sign-up is not set up on this installation yet.', notConfigured: true } };
const UNREACHABLE = { status: 502, body: { error: 'Could not reach the sign-in service. Check this computer\'s internet connection.' } };
const fbCode = (r) => String((r.json && r.json.error && r.json.error.message) || '').split(/[ :]/)[0];
function finishRegistration(user, email) {
  config.account = { email: normEmail(user.email || email), userId: String(user.id), registeredAt: new Date().toISOString(), provider: ACCOUNT_DEV ? 'dev' : 'firebase' };
  saveConfig(); broadcast('account', {});
  return { status: 200, body: { ok: true, email: config.account.email } };
}
function precheck(email) {
  if (config.account) return { status: 409, body: { error: 'This computer is already signed in.' } };
  if (!EMAIL_RE.test(email) || email.length > 254) return { status: 400, body: { error: 'Enter a valid email address.' } };
  if (!accountConfigured()) return NOT_CONFIGURED;
  return null;
}
async function accountSignup(email, password) {
  const bad = precheck(email); if (bad) return bad;
  const pwErr = checkPassword(password); if (pwErr) return { status: 400, body: { error: pwErr } };
  if (ACCOUNT_DEV) {
    if (devUsers.has(email)) return { status: 409, body: { error: 'That email already has an account. Sign in instead.' } };
    const salt = crypto.randomBytes(16).toString('hex'); devUsers.set(email, { salt, hash: scryptHash(password, salt) });
    return finishRegistration({ id: 'dev-' + sha(email).slice(0, 12), email }, email);
  }
  try {
    const r = await jsonRequest('POST', fbUrl('signUp'), null, { email, password, returnSecureToken: true });
    const c = fbCode(r);
    if (r.status === 200 && r.json && r.json.localId) return finishRegistration({ id: r.json.localId, email: r.json.email }, email);
    if (c === 'EMAIL_EXISTS') return { status: 409, body: { error: 'That email already has an account. Sign in instead.' } };
    if (c === 'INVALID_EMAIL') return { status: 400, body: { error: 'Enter a valid email address.' } };
    if (c === 'WEAK_PASSWORD') return { status: 400, body: { error: 'Choose a stronger password.' } };
    if (c === 'TOO_MANY_ATTEMPTS_TRY_LATER') return { status: 429, body: { error: 'Too many attempts. Wait a few minutes and try again.' } };
    if (c === 'OPERATION_NOT_ALLOWED') return { status: 409, body: { error: 'Email/password sign-in is switched off in the Firebase project. The owner must enable it (see README).', needsOwner: true } };
    if (r.status >= 500) return { status: 502, body: { error: 'The sign-in service had a problem. Try again in a moment.' } };
    return { status: 502, body: { error: 'The sign-in service refused the request' + (c ? ' (' + c + ').' : '.') } };
  } catch (e) { return UNREACHABLE; }
}
async function accountSigninRaw(email, password) {
  try {
    const r = await jsonRequest('POST', fbUrl('signInWithPassword'), null, { email, password, returnSecureToken: true });
    const c = fbCode(r);
    if (r.status === 200 && r.json && r.json.localId) return finishRegistration({ id: r.json.localId, email: r.json.email }, email);
    if (c === 'TOO_MANY_ATTEMPTS_TRY_LATER') return { status: 429, body: { error: 'Too many wrong passwords. Wait a few minutes, or reset your password.' } };
    if (c === 'USER_DISABLED') return { status: 403, body: { error: 'This account has been disabled.' } };
    if (r.status >= 500) return { status: 502, body: { error: 'The sign-in service had a problem. Try again in a moment.' } };
    if (r.status === 400) return { status: 403, body: { error: 'Email or password is incorrect.' } };
    return { status: 502, body: { error: 'The sign-in service refused the request' + (c ? ' (' + c + ').' : '.') } };
  } catch (e) { return UNREACHABLE; }
}
async function accountSignin(email, password) {
  const bad = precheck(email); if (bad) return bad;
  if (!password) return { status: 400, body: { error: 'Enter your password.' } };
  const f = signinFails.get(email) || { n: 0, until: 0 };
  if (f.until > Date.now()) return { status: 429, body: { error: 'Too many wrong passwords. Wait a minute and try again.' } };
  let r;
  if (ACCOUNT_DEV) {
    const u = devUsers.get(email);
    const okPw = u && crypto.timingSafeEqual(Buffer.from(scryptHash(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    r = okPw ? finishRegistration({ id: 'dev-' + sha(email).slice(0, 12), email }, email) : { status: 403, body: { error: 'Email or password is incorrect.' } };
  } else r = await accountSigninRaw(email, password);
  if (r.status === 403) { f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } signinFails.set(email, f); } else if (r.status === 200) signinFails.delete(email);
  return r;
}
async function accountForgot(email) {
  const bad = precheck(email); if (bad) return bad;
  const now = Date.now();
  if (now - (lastSent.get(email) || 0) < 60000) return { status: 429, body: { error: 'Please wait a minute before asking again.' } };
  lastSent.set(email, now);
  const ok = { status: 200, body: { ok: true, cooldown: 60 } }; // same answer whether or not the email has an account
  if (ACCOUNT_DEV) { if (devUsers.has(email)) console.log('\n  [DEV MODE] a password-reset link would be emailed to ' + email + '\n'); return ok; }
  try {
    const r = await jsonRequest('POST', fbUrl('sendOobCode'), null, { requestType: 'PASSWORD_RESET', email });
    const c = fbCode(r);
    if (r.status === 200 || c === 'EMAIL_NOT_FOUND') return ok;
    if (c === 'TOO_MANY_ATTEMPTS_TRY_LATER') return { status: 429, body: { error: 'Too many reset requests for this email. Please wait a while and try again.' } };
    return { status: 502, body: { error: 'The sign-in service could not send the email' + (c ? ' (' + c + ').' : '.') } };
  } catch (e) { return UNREACHABLE; }
}

/* ------------------------------------------------------------- utilities */
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}
const isLoopback = (addr) => !!addr && (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
const VIN_RE = /^[A-Z0-9]{5,17}$/;
const PHOTO_RE = /^[A-Za-z0-9_-]{6,64}$/;
const safeEq = (a, b) => {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  if (typeof body === 'object' && !Buffer.isBuffer(body)) {
    h['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(body);
  }
  res.writeHead(code, h);
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const vehDir = (vin) => path.join(VEH_DIR, vin);
const vehFile = (vin) => path.join(vehDir(vin), 'vehicle.json');
function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function readVehicle(vin) {
  try { return JSON.parse(fs.readFileSync(vehFile(vin), 'utf8')); } catch (e) { return null; }
}
function listVehicles() {
  const out = [];
  for (const d of fs.readdirSync(VEH_DIR)) {
    if (!VIN_RE.test(d)) continue;
    const v = readVehicle(d);
    if (v) out.push(v);
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

/* VIN check digit (North American VINs; others may legitimately fail) */
function vinCheckOk(vin) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  const map = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
  const w = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? +c : map[c]) * w[i];
  }
  const r = sum % 11;
  return vin[8] === (r === 10 ? 'X' : String(r));
}

/* ---------------------------------------------------------- NHTSA decode */
const DECODE_FIELDS = {
  year: 'ModelYear', make: 'Make', model: 'Model', trim: 'Trim', series: 'Series',
  bodyClass: 'BodyClass', vehicleType: 'VehicleType', doors: 'Doors',
  driveType: 'DriveType', cylinders: 'EngineCylinders', displacementL: 'DisplacementL',
  engineHP: 'EngineHP', fuel: 'FuelTypePrimary', transmission: 'TransmissionStyle',
  plantCountry: 'PlantCountry', plantCity: 'PlantCity', gvwr: 'GVWR', manufacturer: 'Manufacturer',
  errorCode: 'ErrorCode', errorText: 'ErrorText'
};
const NHTSA_BASE = process.env.ROWSKAN_NHTSA_BASE || 'https://vpic.nhtsa.dot.gov'; // override only for testing
function decodeVinNHTSA(vin) {
  return new Promise((resolve, reject) => {
    const url = NHTSA_BASE + '/api/vehicles/DecodeVinValues/' + encodeURIComponent(vin) + '?format=json';
    const rq = (url.startsWith('https:') ? https : http).get(url, { timeout: 12000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        try {
          if (r.statusCode !== 200) throw new Error('NHTSA HTTP ' + r.statusCode);
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const row = (j.Results || [])[0] || {};
          const d = {};
          for (const k of Object.keys(DECODE_FIELDS)) {
            const val = row[DECODE_FIELDS[k]];
            if (val !== undefined && val !== null && String(val).trim() !== '') d[k] = String(val).trim();
          }
          d.source = 'NHTSA vPIC';
          d.decodedAt = new Date().toISOString();
          resolve(d);
        } catch (e) { reject(e); }
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('NHTSA timeout')));
    rq.on('error', reject);
  });
}
const decodeOk = (d) => !!(d && d.make && d.year);

/* -------------------------------------------------------- live updates */
const sseClients = new Set();
function broadcast(event, data) {
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data || {}) + '\n\n';
  for (const r of sseClients) { try { r.write(msg); } catch (e) { sseClients.delete(r); } }
}

/* -------------------------------------------------------- certificates */
function ensureCerts() {
  const ips = lanIPs();
  const sanList = ['DNS:localhost', 'IP:127.0.0.1', 'DNS:' + os.hostname()].concat(ips.map((i) => 'IP:' + i));
  const sanStr = sanList.join(',');
  const caKey = path.join(CERT_DIR, 'ca.key'), caCrt = path.join(CERT_DIR, 'ca.crt');
  const srvKey = path.join(CERT_DIR, 'server.key'), srvCrt = path.join(CERT_DIR, 'server.crt');
  const sanFile = path.join(CERT_DIR, 'server.san');
  const run = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    if (!fs.existsSync(caKey) || !fs.existsSync(caCrt)) {
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', caCrt, '-days', '3650',
        '-subj', '/CN=RowSkan Local CA/O=LIT America', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    }
    let needServer = !fs.existsSync(srvKey) || !fs.existsSync(srvCrt);
    if (!needServer) {
      try { needServer = fs.readFileSync(sanFile, 'utf8') !== sanStr; } catch (e) { needServer = true; }
    }
    if (needServer) {
      const csr = path.join(CERT_DIR, 'server.csr'), ext = path.join(CERT_DIR, 'server.ext');
      fs.writeFileSync(ext, 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' +
        'extendedKeyUsage=serverAuth\nsubjectAltName=' + sanStr + '\n');
      run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', srvKey, '-out', csr, '-subj', '/CN=RowSkan/O=LIT America']);
      run(['x509', '-req', '-in', csr, '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial', '-out', srvCrt,
        '-days', '800', '-sha256', '-extfile', ext]);
      fs.writeFileSync(sanFile, sanStr);
    }
    return { key: fs.readFileSync(srvKey), cert: fs.readFileSync(srvCrt) };
  } catch (e) {
    console.error('\n[!] Could not create the HTTPS certificate (is "openssl" installed?):', String(e.message).split('\n')[0]);
    console.error('    The phone camera needs HTTPS, so phone capture will not work until this is fixed.\n');
    return null;
  }
}

/* ---------------------------------------------------------------- QR svg */
function qrSvg(text) {
  const q = new QRCode(0, QRLevel.M);
  q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges">' +
    '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#111"/></svg>';
}

/* ------------------------------------------------------------------ auth */
// Linking works like WhatsApp Web: the computer shows a one-time code (as a QR). A phone that presents it
// gets its OWN secret key. Keys can be revoked per phone; only a hash of each key is stored here.
const PAIR_TTL = parseInt(process.env.ROWSKAN_PAIR_TTL_MS || String(5 * 60 * 1000), 10);
const pairCodes = new Map(); // code -> { exp }
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function newPairCode() {
  const now = Date.now();
  for (const [c, v] of pairCodes) if (v.exp < now) pairCodes.delete(c);
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alike characters
  let code = ''; const b = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[b[i] % alphabet.length];
  pairCodes.set(code, { exp: now + PAIR_TTL });
  return { code, expiresAt: new Date(now + PAIR_TTL).toISOString() };
}
const failures = new Map(); // ip -> {n, until}
const locked = (ip) => { const f = failures.get(ip); return !!(f && f.until > Date.now()); };
function noteFailure(ip) {
  const rec = failures.get(ip) || { n: 0, until: 0 };
  rec.n++;
  if (rec.n >= 8) { rec.until = Date.now() + 60000; rec.n = 0; }
  failures.set(ip, rec);
}
let lastSave = 0;
function authorized(req, url) {
  const ip = req.socket.remoteAddress;
  if (isLoopback(ip)) return true; // the computer itself
  if (locked(ip)) return false;
  const tok = String(req.headers['x-rowskan-token'] || url.searchParams.get('token') || '');
  if (tok) {
    const h = sha(tok);
    const d = config.devices.find((x) => safeEq(x.tokenHash, h));
    if (d) {
      req.device = d; d.lastSeen = new Date().toISOString(); failures.delete(ip);
      if (Date.now() - lastSave > 60000) { lastSave = Date.now(); saveConfig(); }
      return true;
    }
  }
  noteFailure(ip);
  return false;
}

/* ------------------------------------------------------------ vehicle ops */
function mergeVehicle(body) {
  const vin = String(body.vin || '').toUpperCase().trim();
  if (!VIN_RE.test(vin)) throw Object.assign(new Error('Invalid VIN'), { status: 400 });
  fs.mkdirSync(path.join(vehDir(vin), 'photos'), { recursive: true });
  const now = new Date().toISOString();
  const cur = readVehicle(vin) || { vin, createdAt: now, photos: [] };
  cur.vin = vin;
  cur.vinCheckOk = vinCheckOk(vin);
  if (body.decoded && typeof body.decoded === 'object') cur.decoded = Object.assign({}, cur.decoded || {}, body.decoded);
  if (typeof body.notes === 'string') cur.notes = body.notes.slice(0, 2000);
  if (typeof body.lotLocation === 'string') cur.lotLocation = body.lotLocation.slice(0, 200);
  if (body.capturedAt) cur.capturedAt = cur.capturedAt && cur.capturedAt < body.capturedAt ? cur.capturedAt : body.capturedAt;
  if (body.device) cur.device = String(body.device).slice(0, 120);
  const have = new Map(cur.photos.map((p) => [p.id, p]));
  const missing = [];
  for (const p of Array.isArray(body.photos) ? body.photos : []) {
    if (!p || !PHOTO_RE.test(String(p.id))) continue;
    const file = path.join(vehDir(vin), 'photos', p.id + '.jpg');
    if (fs.existsSync(file)) {
      if (!have.has(p.id)) have.set(p.id, { id: p.id, takenAt: p.takenAt || now, bytes: fs.statSync(file).size });
    } else {
      missing.push(p.id);
      if (!have.has(p.id)) have.set(p.id, { id: p.id, takenAt: p.takenAt || now, pending: true });
    }
  }
  cur.photos = Array.from(have.values()).sort((a, b) => String(a.takenAt).localeCompare(String(b.takenAt)));
  cur.updatedAt = now;
  cur.syncedAt = now;
  writeJsonAtomic(vehFile(vin), cur);
  return { vehicle: cur, missing };
}

function csvEscape(v) {
  v = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; // neutralise spreadsheet formulas
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function exportCsv() {
  const cols = ['VIN', 'Year', 'Make', 'Model', 'Trim', 'Body', 'Drive', 'Cylinders', 'Fuel', 'Lot location', 'Notes', 'Photos', 'Captured', 'Synced'];
  const rows = [cols.join(',')];
  for (const v of listVehicles()) {
    const d = v.decoded || {};
    const nPhotos = (v.photos || []).filter((p) => !p.pending).length;
    rows.push([v.vin, d.year, d.make, d.model, d.trim, d.bodyClass, d.driveType, d.cylinders, d.fuel,
      v.lotLocation, v.notes, nPhotos, v.capturedAt, v.syncedAt].map(csvEscape).join(','));
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------- static files */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  let p = pathname;
  if (p === '/') p = '/desktop/index.html';
  if (p === '/m' ) { res.writeHead(301, { Location: '/m/' }); return res.end(); }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    h['Cache-Control'] = (file.endsWith('sw.js') || ext === '.html') ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, h);
    res.end(buf);
  });
}

/* ---------------------------------------------------------------- router */
async function handle(req, res, secure) {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  const ip = req.socket.remoteAddress;
  const local = isLoopback(ip);

  // CORS is deliberately NOT enabled: the phone app is served from this same origin.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  try {
    if (!pathname.startsWith('/api/') && pathname !== '/events' && pathname !== '/ca.crt') {
      return serveStatic(req, res, pathname);
    }

    /* open endpoints (no key): discovery + root certificate */
    if (pathname === '/api/ping' && req.method === 'GET') {
      return send(res, 200, { app: 'RowSkan', name: config.name, secure, time: new Date().toISOString() });
    }
    if (pathname === '/ca.crt') {
      const f = path.join(CERT_DIR, 'ca.crt');
      if (!fs.existsSync(f)) return send(res, 404, 'No certificate');
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="RowSkan-Local-CA.crt"' });
    }

    /* account: registration happens on the computer */
    if (pathname === '/api/account' && req.method === 'GET') {
      if (!local) return send(res, 403, { error: 'Computer only' });
      return send(res, 200, { registered: !!config.account, email: config.account ? config.account.email : null, configured: accountConfigured(), dev: ACCOUNT_DEV });
    }
    const acctRoute = /^\/api\/account\/(signup|signin|forgot)$/.exec(pathname);
    if (acctRoute && req.method === 'POST') {
      if (!local) return send(res, 403, { error: 'Computer only' });
      const b = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}'), em = normEmail(b.email);
      const r = acctRoute[1] === 'signup' ? await accountSignup(em, b.password)
        : acctRoute[1] === 'signin' ? await accountSignin(em, b.password)
        : await accountForgot(em);
      return send(res, r.status, r.body);
    }
    if (!config.account) return send(res, 403, { error: 'Create your RowSkan account on the computer first.', needsRegistration: true });

    /* linking a phone: the phone sends the one-time code and receives its own key */
    if (pathname === '/api/pair' && req.method === 'POST') {
      if (!local && locked(ip)) return send(res, 429, { error: 'Too many wrong attempts. Wait a minute and try again.' });
      const b = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
      const code = String(b.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rec = pairCodes.get(code);
      if (!rec || rec.exp < Date.now()) {
        if (!local) noteFailure(ip);
        return send(res, 403, { error: 'That code is wrong or has expired. Make a new one on the computer.' });
      }
      pairCodes.delete(code); // single use
      const token = crypto.randomBytes(32).toString('hex');
      const now = new Date().toISOString();
      const dev = { id: crypto.randomBytes(6).toString('hex'), name: String(b.name || '').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'Phone', tokenHash: sha(token), createdAt: now, lastSeen: now };
      config.devices.push(dev); saveConfig();
      broadcast('paired', { id: dev.id, name: dev.name });
      return send(res, 200, { token, deviceId: dev.id, computerName: config.name });
    }

    /* computer-only: make a code, list and unlink phones */
    if (pathname === '/api/pairing/new' && req.method === 'POST') {
      if (!local) return send(res, 403, { error: 'Open this on the computer running RowSkan.' });
      const c = newPairCode(), ips = lanIPs();
      const urls = ips.map((i) => 'https://' + i + ':' + HTTPS_PORT + '/m/#p=' + c.code);
      return send(res, 200, { code: c.code, expiresAt: c.expiresAt, name: config.name, ips, httpsReady: !!httpsServer, urls, qr: urls.map(qrSvg), dataDir: DATA_DIR });
    }
    if (pathname === '/api/devices' && req.method === 'GET') {
      if (!local) return send(res, 403, { error: 'Computer only' });
      return send(res, 200, config.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen })));
    }
    let dm;
    if ((dm = /^\/api\/devices\/([a-f0-9]{6,32})$/.exec(pathname)) && req.method === 'DELETE') {
      if (!local) return send(res, 403, { error: 'Computer only' });
      const n = config.devices.length;
      config.devices = config.devices.filter((d) => d.id !== dm[1]);
      if (config.devices.length === n) return send(res, 404, { error: 'Not found' });
      saveConfig(); broadcast('devices', {});
      return send(res, 200, { ok: true });
    }

    if (!authorized(req, url)) return send(res, 401, { error: 'Missing or wrong access key' });

    if (pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname === '/api/auth-check') return send(res, 200, { ok: true, name: config.name, device: req.device ? { id: req.device.id, name: req.device.name } : null, account: maskEmail(config.account && config.account.email) });
    if (pathname === '/api/unlink' && req.method === 'POST') { // a phone unlinking itself
      if (!req.device) return send(res, 400, { error: 'Not a linked phone' });
      config.devices = config.devices.filter((d) => d.id !== req.device.id); saveConfig(); broadcast('devices', {});
      return send(res, 200, { ok: true });
    }

    let m;
    if ((m = /^\/api\/vin\/([A-Za-z0-9]{5,17})$/.exec(pathname)) && req.method === 'GET') {
      const vin = m[1].toUpperCase();
      try { return send(res, 200, { vin, checkDigitOk: vinCheckOk(vin), decoded: await decodeVinNHTSA(vin) }); }
      catch (e) { return send(res, 502, { error: 'VIN decode unavailable: ' + e.message }); }
    }

    if (pathname === '/api/vehicles' && req.method === 'GET') return send(res, 200, listVehicles());

    if (pathname === '/api/sync/vehicle' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
      body.device = req.device ? req.device.name : 'This computer';
      const r = mergeVehicle(body);
      // if the phone could not decode (no internet there), try from here
      if (!decodeOk(r.vehicle.decoded)) {
        try {
          const d = await decodeVinNHTSA(r.vehicle.vin);
          r.vehicle.decoded = Object.assign({}, r.vehicle.decoded || {}, d);
          writeJsonAtomic(vehFile(r.vehicle.vin), r.vehicle);
        } catch (e) { /* stays undecoded; user can retry from the dashboard */ }
      }
      broadcast('vehicle', { vin: r.vehicle.vin });
      return send(res, 200, { ok: true, vin: r.vehicle.vin, missingPhotos: r.missing, decoded: decodeOk(r.vehicle.decoded) });
    }

    if ((m = /^\/api\/sync\/photo\/([A-Za-z0-9]{5,17})\/([A-Za-z0-9_-]{6,64})$/.exec(pathname)) && req.method === 'PUT') {
      const vin = m[1].toUpperCase(), id = m[2];
      const v = readVehicle(vin);
      if (!v) return send(res, 404, { error: 'Sync the vehicle record first' });
      const buf = await readBody(req, MAX_PHOTO);
      const isJpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
      if (!isJpeg) return send(res, 415, { error: 'Only JPEG photos are accepted' });
      const dest = path.join(vehDir(vin), 'photos', id + '.jpg');
      const tmp = dest + '.tmp';
      fs.writeFileSync(tmp, buf); fs.renameSync(tmp, dest);
      const rec = (v.photos || []).find((p) => p.id === id);
      if (rec) { delete rec.pending; rec.bytes = buf.length; }
      else v.photos.push({ id, takenAt: new Date().toISOString(), bytes: buf.length });
      v.updatedAt = new Date().toISOString();
      writeJsonAtomic(vehFile(vin), v);
      broadcast('photo', { vin, id });
      return send(res, 200, { ok: true, bytes: buf.length });
    }

    if ((m = /^\/api\/vehicles\/([A-Za-z0-9]{5,17})$/.exec(pathname))) {
      const vin = m[1].toUpperCase();
      const v = readVehicle(vin);
      if (req.method === 'GET') return v ? send(res, 200, v) : send(res, 404, { error: 'Not found' });
      if (!local) return send(res, 403, { error: 'Editing is only allowed on the computer' });
      if (req.method === 'PATCH' && v) {
        const b = JSON.parse((await readBody(req, MAX_JSON)).toString('utf8') || '{}');
        if (typeof b.notes === 'string') v.notes = b.notes.slice(0, 2000);
        if (typeof b.lotLocation === 'string') v.lotLocation = b.lotLocation.slice(0, 200);
        if (b.redecode) {
          try { v.decoded = Object.assign({}, v.decoded || {}, await decodeVinNHTSA(vin)); }
          catch (e) { return send(res, 502, { error: 'VIN decode unavailable: ' + e.message }); }
        }
        v.updatedAt = new Date().toISOString();
        writeJsonAtomic(vehFile(vin), v);
        broadcast('vehicle', { vin });
        return send(res, 200, v);
      }
      if (req.method === 'DELETE' && v) {
        fs.rmSync(vehDir(vin), { recursive: true, force: true });
        broadcast('vehicle', { vin, deleted: true });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'Not found' });
    }

    if ((m = /^\/api\/photo\/([A-Za-z0-9]{5,17})\/([A-Za-z0-9_-]{6,64})$/.exec(pathname)) && req.method === 'GET') {
      const f = path.join(vehDir(m[1].toUpperCase()), 'photos', m[2] + '.jpg');
      if (!fs.existsSync(f)) return send(res, 404, 'Not found');
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    }

    if (pathname === '/api/export.csv' && req.method === 'GET') {
      return send(res, 200, exportCsv(), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="rowskan-inventory.csv"' });
    }

    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || (e instanceof SyntaxError ? 400 : 500);
    if (status === 500) console.error(e);
    return send(res, status, { error: status === 500 ? 'Server error' : e.message });
  }
}

/* ---------------------------------------------------------------- start */
let httpsServer = null;
const creds = ensureCerts();
if (creds) {
  httpsServer = https.createServer(creds, (req, res) => handle(req, res, true));
  httpsServer.on('error', (e) => console.error('HTTPS server error:', e.message));
  httpsServer.listen(HTTPS_PORT, '0.0.0.0');
}
// Plain HTTP: bound to this computer only (dashboard). Phones must use HTTPS.
const httpServer = http.createServer((req, res) => handle(req, res, false));
httpServer.on('error', (e) => { console.error('HTTP server error:', e.message); });
httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  const ips = lanIPs();
  console.log('\n  RowSkan is running   (a product of LIT America - www.litamerica.net)\n');
  console.log('  Computer dashboard :  http://localhost:' + HTTP_PORT + '/');
  if (httpsServer) ips.forEach((i) => console.log('  Phone address      :  https://' + i + ':' + HTTPS_PORT + '/m/'));
  console.log('  Account            :  ' + (config.account ? 'registered (' + maskEmail(config.account.email) + ')' : accountConfigured() ? 'not registered yet - create it in the dashboard' : 'SIGN-UP NOT CONFIGURED (see README: account.config.json)'));
  if (ACCOUNT_DEV) console.log('  *** DEV MODE: sign-in codes are printed here instead of emailed. Do not use for real customers. ***');
  console.log('  Link a phone       :  open the dashboard and use "Link a phone"');
  console.log('  Inventory folder   :  ' + VEH_DIR + '\n');
});
