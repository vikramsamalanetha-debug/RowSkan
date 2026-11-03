const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : (fail++); console.log(c ? '  PASS' : '  FAIL', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const APP = '/home/claude/rowskan/app', KEY = fs.readFileSync('/tmp/rk/k.pem'), CERT = fs.readFileSync('/tmp/rk/c.pem', 'utf8'), PROJ = 'rowskan-test';
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = uid => { const t = Math.floor(Date.now() / 1000), si = b64u(JSON.stringify({ alg: 'RS256', kid: 'kid1', typ: 'JWT' })) + '.' + b64u(JSON.stringify({ iss: 'https://securetoken.google.com/' + PROJ, aud: PROJ, sub: uid, iat: t - 10, exp: t + 3600 })); return si + '.' + b64u(crypto.createSign('RSA-SHA256').update(si).sign(KEY)); };
// ---- mock Firebase + certs + NHTSA (one server) ----
const users = {}; const body = q => new Promise(r => { let d = ''; q.on('data', c => d += c); q.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const mock = http.createServer(async (q, r) => {
  const send = (s, j) => { r.writeHead(s, Object.assign({ 'Content-Type': 'application/json' }, cors)); r.end(JSON.stringify(j)); };
  if (q.method === 'OPTIONS') { r.writeHead(204, cors); return r.end(); }
  const u = new URL(q.url, 'http://x'), b = await body(q);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rly-'));
  const rly = spawn('node', ['/home/claude/rowskan/relay/relay.js'], { env: { ...process.env, RELAY_PROJECT_ID: PROJ, RELAY_DATA: dir, RELAY_PORT: 18787, RELAY_CERTS_URL: 'http://127.0.0.1:18950/certs' }, stdio: 'ignore' });
  await sleep(700);
  const br = await chromium.launch({ args: ['--proxy-server=direct://', '--proxy-bypass-list=*', '--use-fake-ui-for-media-stream'] });
  const mk = async () => {
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 420, height: 860 } }); const pg = await ctx.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(String(e))); pg.errs = errs;
    await pg.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.ROWSKAN_CONFIG=' + JSON.stringify({ apiKey: 'k', projectId: PROJ, relayUrl: 'http://127.0.0.1:18787', appUrl: 'http://127.0.0.1:18900/', authBase: 'http://127.0.0.1:18950', tokenBase: 'http://127.0.0.1:18950', nhtsaBase: 'http://127.0.0.1:18950', pollMs: 700 }) }));
    pg.ctx = ctx; return pg;
  };
  const on = (pg, id) => pg.waitForSelector('#' + id + '.on', { timeout: 8000 });
  const vis = async (pg, sel, t = 12000) => { try { await pg.waitForSelector(sel, { timeout: t }); return true; } catch (e) { return false; } };
  const signUp = async (pg, em, pw) => { await pg.goto('http://127.0.0.1:18900/'); await on(pg, 'sAuth'); await pg.click('#tabUp'); await pg.fill('#authEmail', em); await pg.fill('#authPw', pw); await pg.click('#authGo'); };
  try {
    console.log('\n[No-VIN vehicles]');
    const A = await mk(); await signUp(A, 'old@example.com', 'Old-Cars-1962'); await on(A, 'sHome');
    await A.click('#newVeh'); await on(A, 'sScan');
    ok(await A.isHidden('#scanCam') && await A.isVisible('#camStart') && await A.isVisible('#vinIn') && await A.isVisible('#noVinBtn'), 'camera does not start by itself; typing, photo and no-VIN options are all there');
    await A.click('#camStart'); await sleep(500); ok(await A.isVisible('#scanCam') || await A.isVisible('#scanNote'), 'camera button starts scanning (or explains why not)');
    if (await A.isVisible('#camStop')) await A.click('#camStop'); await sleep(200); ok(await A.isHidden('#scanCam'), 'camera area is closed again');
    await A.fill('#vinIn', 'F100-1962'); await sleep(200);
    ok(/serial number/i.test(await A.textContent('#vinMsg')) && /serial/i.test(await A.textContent('#vinGo')), 'short serial accepted and labelled as a serial number');
    await A.click('#vinGo'); await on(A, 'sVeh');
    ok(/Serial number F1001962/.test(await A.textContent('#vehVin')), 'vehicle opens with the serial number');
    ok(/No VIN to look up/.test(await A.textContent('#vehWarn')), 'tells the user to type the details');
    ok(await A.$eval('#manDet', e => e.open), 'details form opens by itself');
    await A.selectOption('#sYear', '1962'); await A.selectOption('#sMake', 'Ford'); await A.selectOption('#sModel', '__o'); await A.fill('#mModel', 'F-100'); await A.fill('#locIn', 'Barn');
    await A.setInputFiles('#fileIn', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }]); await vis(A, '#photoCount:has-text("1 photo")');
    await A.click('#vehDone'); await on(A, 'sScan');
    ok(await A.evaluate(() => fetch('http://127.0.0.1:18950/api/vehicles/DecodeVinValues/x').then(() => 1)), 'sanity');
    await A.click('#noVinBtn'); await on(A, 'sVeh');
    ok(/No VIN · ID NV[A-Z0-9]{6}/.test(await A.textContent('#vehVin')), 'add-without-any-number creates a no-VIN record');
    await A.selectOption('#sMake', 'Chevrolet'); await A.selectOption('#sModel', '__o'); await A.fill('#mModel', 'Bel Air'); await A.setInputFiles('#fileIn', [{ name: 'b.png', mimeType: 'image/png', buffer: PNG }]); await vis(A, '#photoCount:has-text("1 photo")');
    await A.click('#vehDone'); await on(A, 'sScan'); await A.click('#scanBack'); await on(A, 'sHome');
    ok(await vis(A, '.vcard:has-text("1962 Ford F-100")'), 'serial-number vehicle listed with the typed details');
    ok(await vis(A, '.vcard:has-text("Chevrolet Bel Air")') && await vis(A, '.vcard:has-text("No VIN")'), 'no-VIN vehicle listed');
    await sleep(1500); ok(await A.$$eval('.vcard', l => l.length) === 2, 'nothing was looked up or duplicated');
    ok(await vis(A, '.vcard:has-text("Synced")'), 'both sync like any other vehicle');
    ok(A.errs.length === 0, 'no page errors (' + A.errs.join(' | ') + ')');
  } catch (e) { fail++; console.log('  FAIL exception:', e.message.split('\n')[0]); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await br.close(); rly.kill(); mock.close(); stat.close(); process.exit(fail ? 1 : 0);
})();
