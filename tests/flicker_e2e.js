const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++); console.log(c ? '  PASS' : '  FAIL', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = '/home/claude/rowskan/app', KEY = fs.readFileSync('/tmp/rk/k.pem'), CERT = fs.readFileSync('/tmp/rk/c.pem', 'utf8'), PROJ = 'rowskan-test';
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = uid => { const t = Math.floor(Date.now() / 1000), si = b64u(JSON.stringify({ alg: 'RS256', kid: 'kid1', typ: 'JWT' })) + '.' + b64u(JSON.stringify({ iss: 'https://securetoken.google.com/' + PROJ, aud: PROJ, sub: uid, iat: t - 10, exp: t + 3600 })); return si + '.' + b64u(crypto.createSign('RSA-SHA256').update(si).sign(KEY)); };

// ---------- Firestore stand-in (REST subset the app uses) with the same per-user rules as firestore.rules ----------
const DB = new Map(); const DOCROOT = '/v1/projects/' + PROJ + '/databases/(default)/documents'; let usec = 0;
const tsMicro = s => { const m = /^(.*?)(?:\.(\d+))?Z$/.exec(String(s)); return Math.floor(Date.parse(m[1] + 'Z') / 1000) * 1000000 + parseInt(((m[2] || '') + '000000').slice(0, 6), 10); };
const microTs = u => new Date(Math.floor(u / 1e6) * 1000).toISOString().replace(/\.\d+Z$/, '.' + ('000000' + (u % 1e6)).slice(-6) + 'Z');
const authUid = q => { const h = q.headers.authorization || ''; if (!h.startsWith('Bearer ')) return null; try { return JSON.parse(Buffer.from(h.slice(7).split('.')[1], 'base64').toString()).sub; } catch (e) { return null; } };
const allowed = (path, uid, op) => { const s = path.split('/'); if (s[0] === 'users') return !!uid && uid === s[1]; if (s[0] === 'links' && s.length === 2) return op === 'get' || op === 'delete' || (op === 'create' && !!uid); return false; };
const nameToPath = n => n.slice(n.indexOf('/documents/') + 11);
function fsHandler(q, r, u, b, send) {
  const uid = authUid(q), p = decodeURIComponent(u.pathname.slice(DOCROOT.length)).replace(/^\//, '');
  const doc = path => DB.has(path) ? { name: 'projects/' + PROJ + '/databases/(default)/documents/' + path, fields: DB.get(path) } : null;
  if (q.method === 'GET') {
    const segs = p.split('/');
    if (segs.length % 2 === 0) { if (!allowed(p, uid, 'get')) return send(403, { error: { status: 'PERMISSION_DENIED', message: 'denied' } }); const d = doc(p); return d ? send(200, d) : send(404, { error: { status: 'NOT_FOUND' } }); }
    if (!allowed(p + '/x', uid, 'list') || segs[0] === 'links') return send(403, { error: { status: 'PERMISSION_DENIED' } });
    const kids = Array.from(DB.keys()).filter(k => k.startsWith(p + '/') && k.slice(p.length + 1).indexOf('/') < 0).sort();
    return send(200, kids.length ? { documents: kids.map(doc) } : {});
  }
  if (q.method === 'DELETE') { if (!allowed(p, uid, 'delete')) return send(403, { error: { status: 'PERMISSION_DENIED' } }); DB.delete(p); return send(200, {}); }
  if (q.method === 'POST' && p.endsWith(':commit')) {
    for (const w of b.writes) { const path = nameToPath((w.update || {}).name || w.delete || ''); if (!allowed(path, uid, w.delete ? 'delete' : (w.currentDocument && w.currentDocument.exists === false ? 'create' : 'update'))) return send(403, { error: { status: 'PERMISSION_DENIED' } }); }
    for (const w of b.writes) { const path = nameToPath((w.update || {}).name || w.delete || ''), ex = DB.has(path);
      if (w.currentDocument && w.currentDocument.exists === false && ex) return send(409, { error: { status: 'ALREADY_EXISTS', message: 'exists' } });
      if (w.currentDocument && w.currentDocument.exists === true && !ex) return send(404, { error: { status: 'NOT_FOUND', message: 'nf' } }); }
    for (const w of b.writes) {
      if (w.delete) { DB.delete(nameToPath(w.delete)); continue; }
      const path = nameToPath(w.update.name), f = Object.assign({}, DB.get(path) || {});
      if (!(w.updateMask && !Object.keys(w.update.fields || {}).length)) Object.assign(f, w.update.fields || {});
      for (const t of w.updateTransforms || []) {
        if (t.setToServerValue) f[t.fieldPath] = { timestampValue: microTs(Date.now() * 1000 + (usec++ % 1000)) };
        if (t.removeAllFromArray) { const rm = t.removeAllFromArray.values.map(v => v.stringValue); f[t.fieldPath] = { arrayValue: { values: ((f[t.fieldPath] || {}).arrayValue || { values: [] }).values.filter(v => rm.indexOf(v.stringValue) < 0) } }; }
      }
      DB.set(path, f);
    }
    return send(200, { writeResults: [] });
  }
  if (q.method === 'POST' && p.endsWith(':runQuery')) {
    const parent = p.slice(0, -9), sq = b.structuredQuery, col = sq.from[0].collectionId, flt = sq.where.fieldFilter, val = tsMicro(flt.value.timestampValue);
    if (!allowed(parent + '/x', uid, 'list')) return send(403, { error: { status: 'PERMISSION_DENIED' } });
    let kids = Array.from(DB.keys()).filter(k => k.startsWith(parent + '/' + col + '/') && k.slice((parent + '/' + col).length + 1).indexOf('/') < 0)
      .filter(k => { const t = tsMicro((DB.get(k).ts || {}).timestampValue); return flt.op === 'GREATER_THAN' ? t > val : t <= val; })
      .sort((a, c) => tsMicro(DB.get(a).ts.timestampValue) - tsMicro(DB.get(c).ts.timestampValue)).slice(0, sq.limit);
    return send(200, kids.length ? kids.map(k => ({ document: doc(k) })) : [{ readTime: new Date().toISOString() }]);
  }
  send(404, { error: { message: 'unhandled ' + q.method + ' ' + p } });
}

// ---- mock Firebase + certs + NHTSA (one server) ----
const users = {}; const body = q => new Promise(r => { let d = ''; q.on('data', c => d += c); q.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const mock = http.createServer(async (q, r) => {
  const send = (s, j) => { r.writeHead(s, Object.assign({ 'Content-Type': 'application/json' }, cors)); r.end(JSON.stringify(j)); };
  if (q.method === 'OPTIONS') { r.writeHead(204, cors); return r.end(); }
  const u = new URL(q.url, 'http://x'), b = await body(q);
  if (u.pathname.startsWith('/v1/projects/')) return fsHandler(q, r, u, b, send);
  if (u.pathname === '/certs') return send(200, { kid1: CERT });
  if (u.pathname.startsWith('/api/vehicles/DecodeVinValues/')) { const vin = u.pathname.split('/').pop(); return send(200, { Results: [{ ModelYear: '2019', Make: 'TOYOTA', Model: 'Camry', Trim: 'LE', BodyClass: 'Sedan', ErrorCode: '0' }] }); }
  const op = u.pathname.split(':')[1];
  if (op === 'signUp') { if (users[b.email]) return send(400, { error: { message: 'EMAIL_EXISTS' } }); users[b.email] = { pw: b.password, uid: 'uid' + Object.keys(users).length, rt: 'rt-' + crypto.randomBytes(6).toString('hex') }; const x = users[b.email]; return send(200, { idToken: jwt(x.uid), refreshToken: x.rt, localId: x.uid, email: b.email, expiresIn: '3600' }); }
  if (op === 'signInWithPassword') { const x = users[b.email]; if (!x || x.pw !== b.password) return send(400, { error: { message: 'INVALID_LOGIN_CREDENTIALS' } }); return send(200, { idToken: jwt(x.uid), refreshToken: x.rt, localId: x.uid, email: b.email, expiresIn: '3600' }); }
  if (u.pathname === '/v1/token') { const e = Object.keys(users).find(k => users[k].rt === b.refresh_token); if (!e) return send(400, { error: { message: 'INVALID_REFRESH_TOKEN' } }); return send(200, { id_token: jwt(users[e].uid), refresh_token: users[e].rt, user_id: users[e].uid, expires_in: '3600' }); }
  if (op === 'sendOobCode') return send(200, { email: b.email });
  if (op === 'delete') return send(200, {});
  send(404, {});
});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const stat = http.createServer((q, r) => { let p = new URL(q.url, 'http://x').pathname; if (p === '/') p = '/index.html'; const f = path.join(APP, p); if (!f.startsWith(APP) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(fs.readFileSync(f)); });
// 1x1-ish PNG for photos
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAOklEQVR4Xu3QQQ0AMAzDwK6Qwh/AYE0j4Xx8BCz53GQathH9DGNcjXE1xtUYV2NcjXE1xtUYV2Nqqx9UxgFoLHJXEwAAAABJRU5ErkJggg==', 'base64');
const VIN = '1HGCM82633A004352', VIN2 = '2T1BURHE0JC012345';
(async () => {
  await new Promise(r => mock.listen(18950, '127.0.0.1', r)); await new Promise(r => stat.listen(18900, '127.0.0.1', r));
  const br = await chromium.launch({ args: ['--proxy-server=direct://', '--proxy-bypass-list=*'] });
  const mk = async (phone) => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: phone ? { width: 400, height: 800 } : { width: 1300, height: 850 }, userAgent: phone ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' : undefined });
    const pg = await ctx.newPage(); pg.errs = []; pg.on('pageerror', e => pg.errs.push(String(e)));
    await pg.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.ROWSKAN_CONFIG=' + JSON.stringify({ apiKey: 'k', projectId: PROJ, relayUrl: '', appUrl: 'http://127.0.0.1:18900/', authBase: 'http://127.0.0.1:18950', tokenBase: 'http://127.0.0.1:18950', firestoreBase: 'http://127.0.0.1:18950', nhtsaBase: 'http://127.0.0.1:18950' }) }));
    return pg;
  };
  const on = (pg, id) => pg.waitForSelector('#' + id + '.on', { timeout: 8000 });
  const vis = async (pg, sel, t = 12000) => { try { await pg.waitForSelector(sel, { timeout: t }); return true; } catch (e) { return false; } };
  try {
    console.log('\n[No flicker during background sync]');
    const D = await mk(false); await D.goto('http://127.0.0.1:18900/'); await on(D, 'sAuth'); await D.click('#tabUp'); await D.fill('#authEmail', 'flick@example.com'); await D.fill('#authPw', 'Flick-Tests-12'); await D.click('#authGo'); await on(D, 'sHome');
    await D.click('#newVeh'); await on(D, 'sScan'); await D.fill('#vinIn', VIN); await D.click('#vinGo'); await on(D, 'sVeh');
    await D.setInputFiles('#fileIn', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }]); await vis(D, '#photoCount:has-text("1 photo")'); await D.click('#vehDone'); await on(D, 'sScan'); await D.click('#scanBack'); await on(D, 'sHome');
    await vis(D, '#tb tr.row2'); await sleep(2500);
    await D.evaluate(() => { window.__mut = 0; const o = new MutationObserver((m) => { window.__mut += m.length; }); o.observe(document.getElementById('tb'), { childList: true, subtree: true }); o.observe(document.getElementById('list'), { childList: true, subtree: true }); });
    for (let i = 0; i < 3; i++) { await D.click('#dSync'); await sleep(2500); }
    const n = await D.evaluate(() => window.__mut); ok(n === 0, 'three sync checks with nothing new did not redraw the list (mutations: ' + n + ')');
    await D.evaluate(() => { window.__mut2 = 0; new MutationObserver((m) => { window.__mut2 += m.length; window.__mt = (window.__mt || {}); m.forEach(x => { const t = x.target; const k = (t.id || t.className || t.tagName) + ':' + x.type + ':' + (x.attributeName || ''); window.__mt[k] = (window.__mt[k] || 0) + 1; }); }).observe(document.getElementById('sHome'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] }); });
    for (let i = 0; i < 3; i++) { await D.evaluate(() => window.RS_Net.syncNow()); await sleep(1500); }
    const n2 = await D.evaluate(() => window.__mut2); ok(n2 <= 3, 'background sync checks leave the page alone (only the "last synced" time changes) (changes: ' + n2 + ')');
    await D.fill('#q', 'honda'); await sleep(400); ok(await D.evaluate(() => window.__mut) > 0, 'but searching still redraws it');
    ok(D.errs.length === 0, 'no page errors');
  } catch (e) { fail++; console.log('  FAIL exception:', e.message.split('\n')[0]); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await br.close(); mock.close(); stat.close(); process.exit(fail ? 1 : 0);
})();
