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
  const signIn = async (pg, em, pw) => { await pg.goto('http://127.0.0.1:18900/'); await on(pg, 'sAuth'); await pg.fill('#authEmail', em); await pg.fill('#authPw', pw); await pg.click('#authGo'); };
  const addVeh = async (pg, vin) => { await pg.click('#newVeh'); await on(pg, 'sScan'); await pg.fill('#vinIn', vin); await pg.click('#vinGo'); await on(pg, 'sVeh'); await pg.setInputFiles('#fileIn', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }]); await vis(pg, '#photoCount:has-text("1 photo")'); await pg.click('#vehDone'); await on(pg, 'sScan'); await pg.click('#scanBack'); await on(pg, 'sHome'); };
  const envs = () => Array.from(DB.keys()).filter(k => k.endsWith('/meta/keyenv'));
  try {
    console.log('\n[Sign in with just email + password]');
    const D = await mk(false); await D.goto('http://127.0.0.1:18900/'); await on(D, 'sAuth'); await D.click('#tabUp'); await D.fill('#authEmail', 'pw@example.com'); await D.fill('#authPw', 'Password-Test-1'); await D.click('#authGo'); await on(D, 'sHome');
    await sleep(2500); ok(envs().length === 1, 'creating the account stores the password-locked key in the account');
    const stored = JSON.stringify(Array.from(DB.entries()).filter(e => e[0].endsWith('/meta/keyenv')));
    ok(!/Password-Test-1/.test(stored) && /ct/.test(stored), 'the stored copy does not contain the password');
    await D.click('#newVeh'); await on(D, 'sScan'); await D.fill('#vinIn', VIN); await D.click('#vinGo'); await on(D, 'sVeh'); await D.setInputFiles('#fileIn', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }]); await vis(D, '#photoCount:has-text("1 photo")'); await D.click('#vehDone'); await on(D, 'sScan'); await D.click('#scanBack'); await on(D, 'sHome');
    const P = await mk(true); await signIn(P, 'pw@example.com', 'Password-Test-1'); await on(P, 'sHome');
    ok(await vis(P, '.vcard:has-text("Camry")', 30000), 'a new phone that signs in with email + password gets the vehicle without any code or QR');
    ok(!(await P.isVisible('#sLink.on')), 'no link screen was shown');
    const W = await mk(true); await W.goto('http://127.0.0.1:18900/'); await on(W, 'sAuth'); await W.fill('#authEmail', 'pw@example.com'); await W.fill('#authPw', 'Password-Test-2x'); await W.click('#authGo');
    ok(await vis(W, '#authErr:not([hidden]), .banner.err:not([hidden])'), 'a wrong password is refused');
    // an account that existed before this feature (no locked key yet)
    console.log('\n[Older account: turn it on from a linked device]');
    const D2 = await mk(false); await D2.goto('http://127.0.0.1:18900/'); await on(D2, 'sAuth'); await D2.click('#tabUp'); await D2.fill('#authEmail', 'old@example.com'); await D2.fill('#authPw', 'Old-Account-12'); await D2.click('#authGo'); await on(D2, 'sHome'); await sleep(2500);
    for (const k of envs().filter(k => /uid1\//.test(k))) DB.delete(k);
    const P2 = await mk(true); await signIn(P2, 'old@example.com', 'Old-Account-12');
    ok(await vis(P2, '#sLink.on #codeIn'), 'without a locked key the new phone still needs the code (fallback works)');
    await D2.click('#setBtn'); await on(D2, 'sSet'); ok(await vis(D2, '#pwState:has-text("Off")'), 'Settings says password sign-in is off');
    await D2.fill('#pwEnable', 'Not-The-Password1'); await D2.click('#pwGo'); await sleep(1200); ok(envs().filter(k => /uid1\//.test(k)).length === 0, 'a wrong password does not turn it on');
    await D2.fill('#pwEnable', 'Old-Account-12'); await D2.click('#pwGo'); ok(await vis(D2, '#pwState:has-text("On")', 15000), 'the right password turns it on');
    const P3 = await mk(true); await signIn(P3, 'old@example.com', 'Old-Account-12'); ok(await vis(P3, '#sHome.on', 30000) && !(await P3.isVisible('#sLink.on')), 'after that a new phone signs in with just the password');
    // password changed (reset): old locked key no longer fits; link once, then it works again
    console.log('\n[After a password reset]');
    users['old@example.com'].pw = 'Brand-New-Pw-99';
    const P4 = await mk(true); await signIn(P4, 'old@example.com', 'Brand-New-Pw-99'); ok(await vis(P4, '#sLink.on #codeIn'), 'after a reset the first new device falls back to the code');
    await D2.click('#addDev'); await on(D2, 'sApprove'); await vis(D2, '#offerCode:text-matches("^[A-Z2-9]{5}-[A-Z2-9]{5}$")'); const code = await D2.textContent('#offerCode');
    await P4.fill('#codeIn', code); await P4.click('#codeGo'); await on(P4, 'sHome'); await sleep(2500);
    const P5 = await mk(true); await signIn(P5, 'old@example.com', 'Brand-New-Pw-99'); ok(await vis(P5, '#sHome.on', 30000) && !(await P5.isVisible('#sLink.on')), 'after linking once with the new password, new devices sign in with just that password');
    ok([D, P, D2, P2, P3, P4, P5].every(p => p.errs.length === 0), 'no page errors ' + JSON.stringify([D, P, D2, P2, P3, P4, P5].flatMap(p => p.errs)));
  } catch (e) { fail++; console.log('  FAIL exception:', e.message.split('\n')[0]); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await br.close(); mock.close(); stat.close(); process.exit(fail ? 1 : 0);
})();
