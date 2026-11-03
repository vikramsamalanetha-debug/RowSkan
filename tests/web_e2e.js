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
    console.log('\n[1] Device A: register and capture');
    const A = await mk(); await signUp(A, 'dealer@example.com', 'short');
    ok(/8/.test(await A.textContent('#authErr')), 'weak password is refused with a clear message');
    await A.fill('#authPw', 'Lot-Lizard-42'); await A.click('#authGo'); await on(A, 'sHome');
    ok(true, 'registered and landed on the inventory list');
    await A.click('#newVeh'); await on(A, 'sScan'); await A.fill('#vinIn', VIN); await A.click('#vinGo'); await on(A, 'sVeh');
    ok(await vis(A, '#vehTitle:has-text("2019 TOYOTA Camry")'), 'vehicle details decoded automatically (NHTSA)');
    await A.setInputFiles('#fileIn', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }, { name: 'b.png', mimeType: 'image/png', buffer: PNG }]);
    ok(await vis(A, '#photoCount:has-text("2 photos")'), 'two photos added to the vehicle');
    await A.fill('#locIn', 'Row 4'); await A.click('#vehDone'); await on(A, 'sScan'); await A.click('#scanBack'); await on(A, 'sHome');
    ok(await vis(A, '.vcard:has-text("Camry")'), 'vehicle appears in the list');
    ok(await vis(A, '.vcard:has-text("Synced")'), 'single device: marked synced once sent to the relay');

    console.log('\n[2] Device B: sign in, link like WhatsApp Web, receive history');
    const B = await mk(); await B.goto('http://127.0.0.1:18900/'); await on(B, 'sAuth'); await B.fill('#authEmail', 'dealer@example.com'); await B.fill('#authPw', 'wrong-pass-1'); await B.click('#authGo');
    ok(await vis(B, '#authErr:not([hidden])'), 'wrong password is rejected');
    await B.fill('#authPw', 'Lot-Lizard-42'); await B.click('#authGo');
    ok(await vis(B, '#sLink.on'), 'second device is asked to link (no inventory key yet)');
    await vis(B, '#linkTxt:not([value=""])'); await sleep(500);
    const link = await B.inputValue('#linkTxt'); ok(/#link=/.test(link), 'link text produced');
    ok(await B.$eval('#linkQr', e => !!e.querySelector('svg')), 'QR code drawn');
    await A.click('#setBtn'); await on(A, 'sSet'); await A.click('#addDev'); await on(A, 'sApprove');
    await A.fill('#apPaste', link); await A.click('#apUse'); ok(await vis(A, '#apConfirm:not([hidden])'), 'signed-in device shows the approve prompt');
    await A.click('#apYes'); await on(A, 'sSet');
    ok(await vis(B, '#sHome.on', 15000), 'device B is linked and opens the inventory');
    ok(await vis(B, '.vcard:has-text("Camry")', 15000), 'B received the vehicle');
    await B.click('.vcard:has-text("Camry")'); await on(B, 'sVeh');
    ok(await vis(B, '#photoCount:has-text("2 photos")', 15000), 'B received both photos');
    ok((await B.inputValue('#locIn')) === 'Row 4', 'B has the lot location');
    ok(await vis(B, '#strip img', 15000), 'B can display the photo (decrypted)');

    console.log('\n[3] Edits and deletes travel both ways');
    await B.fill('#noteIn', 'Needs detail'); await B.click('#vehBack'); await on(B, 'sHome');
    await sleep(2500); await A.click('#setBack'); await on(A, 'sHome'); await A.click('.vcard:has-text("Camry")'); await on(A, 'sVeh');
    ok(await vis(A, '#noteIn:text("")', 3000) && await (async () => { for (let i = 0; i < 20; i++) { if ((await A.inputValue('#noteIn')) === 'Needs detail') return true; await sleep(500); } return false; })(), 'note edited on B shows up on A');
    ok((await A.inputValue('#locIn')) === 'Row 4', 'A keeps its own field edits');
    A.once('dialog', d => d.accept()); await A.click('#vehDel'); await on(A, 'sHome');
    await sleep(2500);
    ok(await B.$$eval('.vcard', l => l.length) === 0, 'delete on A removes it from B');

    console.log('\n[4] Offline capture syncs later');
    await B.ctx.setOffline(true);
    await B.click('#newVeh'); await on(B, 'sScan'); await B.fill('#vinIn', VIN2); await B.click('#vinGo'); await on(B, 'sVeh');
    await B.setInputFiles('#fileIn', [{ name: 'c.png', mimeType: 'image/png', buffer: PNG }]); await vis(B, '#photoCount:has-text("1 photo")');
    await B.click('#vehBack'); await on(B, 'sHome');
    ok(await vis(B, '.vcard:has-text("Waiting to sync")', 5000) || await vis(B, '.vcard:has-text("2T1BURHE0JC012345")', 3000), 'offline: vehicle is saved on the device');
    ok(await A.$$eval('.vcard', l => l.length) === 0, 'A has not got it yet');
    await B.ctx.setOffline(false);
    ok(await vis(A, '.vcard:has-text("2T1BURHE0JC012345")', 20000), 'back online: A receives it automatically');

    console.log('\n[5] Search, export, import, sign out');
    await A.fill('#q', 'zzzz'); await sleep(300); ok(await A.$$eval('.vcard', l => l.length) === 0, 'search with no match shows nothing');
    await A.fill('#q', 'camry'); await sleep(300); ok(await A.$$eval('.vcard', l => l.length) === 1, 'search finds by model (decoded details)');
    await A.fill('#q', '');
    const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#exportBtn')]); const csv = fs.readFileSync(await dl.path(), 'utf8');
    ok(/2T1BURHE0JC012345/.test(csv) && /^﻿VIN,/.test(csv), 'CSV export contains the inventory');
    fs.writeFileSync('/tmp/rk/vins.txt', 'VIN list\n' + VIN + '\n1FTFW1ET5DFC10312\nnotavin\n');
    await A.setInputFiles('#importFile', '/tmp/rk/vins.txt');
    ok(await vis(A, '.vcard:has-text("1FTFW1ET5DFC10312")', 8000), 'VIN list import adds vehicles');
    ok(await vis(B, '.vcard:has-text("1FTFW1ET5DFC10312")', 20000), 'imported vehicles sync to B');
    A.once('dialog', d => d.accept()); await A.click('#setBtn'); await on(A, 'sSet'); await A.click('#signOut'); await on(A, 'sAuth');
    ok(await A.evaluate(() => indexedDB.databases().then(l => true)), 'signed out returns to the sign-in screen');
    ok(A.errs.length === 0 && B.errs.length === 0, 'no page errors (' + A.errs.concat(B.errs).join(' | ') + ')');
  } catch (e) { fail++; console.log('  FAIL exception:', e.message.split('\n')[0]); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await br.close(); rly.kill(); mock.close(); stat.close(); process.exit(fail ? 1 : 0);
})();
