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
    console.log('\n[Desktop] table, filters, side panel, bulk actions, spreadsheet import');
    const ctx = await br.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 }, acceptDownloads: true }); const D = await ctx.newPage(); const errs = []; D.on('pageerror', e => errs.push(String(e)));
    await D.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: 'window.ROWSKAN_CONFIG=' + JSON.stringify({ apiKey: 'k', projectId: PROJ, relayUrl: 'http://127.0.0.1:18787', appUrl: 'http://127.0.0.1:18900/', authBase: 'http://127.0.0.1:18950', tokenBase: 'http://127.0.0.1:18950', nhtsaBase: 'http://127.0.0.1:18950', pollMs: 700 }) }));
    await D.goto('http://127.0.0.1:18900/'); await on(D, 'sAuth'); await D.click('#tabUp'); await D.fill('#authEmail', 'desk@example.com'); await D.fill('#authPw', 'Desk-Top-1234'); await D.click('#authGo'); await on(D, 'sHome');
    ok(await D.isVisible('#desk') && !(await D.isVisible('#list')), 'wide screen shows the table view, not the phone cards');
    fs.writeFileSync('/tmp/rk/inv.csv', 'Stock #,VIN number,Lot spot,Comments\r\n1,' + VIN + ',Row 1,"Clean, one owner"\r\n2,' + VIN2 + ',Row 2,\r\n3,1FTFW1ET5DFC10312,Row 1,Needs keys\r\n4,BADVIN,Row 9,x\r\n');
    await D.setInputFiles('#importFile', '/tmp/rk/inv.csv');
    ok(await vis(D, '#mapDlg.on'), 'spreadsheet import opens the column-mapping dialog');
    ok((await D.$eval('#mCol0', e => e.options[e.selectedIndex].text)) === 'VIN number', 'VIN column detected automatically');
    ok((await D.$eval('#mCol1', e => e.options[e.selectedIndex].text)) === 'Lot spot', 'lot column detected automatically');
    ok(/3 valid VINs/.test(await D.textContent('#mapPrev')) && /1 rows skipped/.test(await D.textContent('#mapPrev')), 'preview counts valid and skipped rows');
    await D.click('#mapGo');
    ok(await vis(D, '#tb tr:nth-child(3)'), 'three vehicles imported as table rows');
    await D.waitForFunction(() => document.querySelectorAll('#tb tr td:nth-child(5)').length === 3 && Array.from(document.querySelectorAll('#tb tr td:nth-child(5)')).every(t => t.textContent === 'TOYOTA'), null, { timeout: 10000 }).catch(() => {});
    ok(await D.$$eval('#tb tr', r => r.filter(x => /Row [12]/.test(x.textContent)).length) === 3, 'lot locations came from the spreadsheet');
    ok(await D.$$eval('#fMake option', o => o.length) === 2, 'make filter filled from the decoded details');
    await D.selectOption('#fLot', 'Row 1'); await sleep(300); ok(await D.$$eval('#tb tr', r => r.length) === 2, 'lot filter narrows the table');
    await D.selectOption('#fLot', ''); await D.click('th[data-k="vin"]'); await sleep(300);
    const vins = await D.$$eval('#tb tr td:nth-child(3)', t => t.map(x => x.textContent)); ok(vins.join() === vins.slice().sort().join(), 'sorting by VIN orders the rows');
    await D.click('th[data-k="vin"]'); await sleep(300); const v2 = await D.$$eval('#tb tr td:nth-child(3)', t => t.map(x => x.textContent)); ok(v2.join() === vins.slice().reverse().join(), 'second click reverses the sort');
    await D.fill('#q', '1FTFW'); await sleep(300); ok(await D.$$eval('#tb tr', r => r.length) === 1, 'search box filters the table'); await D.fill('#q', '');
    await D.click('#tb tr:has-text("' + VIN + '") td:nth-child(3)'); ok(await vis(D, '#side:not([hidden])'), 'clicking a row opens the side panel');
    ok((await D.inputValue('#sNote')) === 'Clean, one owner', 'side panel shows the notes imported from the spreadsheet');
    await D.fill('#sLot', 'Front line'); await D.click('#sSave'); await sleep(400);
    ok(await D.$$eval('#tb tr', r => r.some(x => /Front line/.test(x.textContent))), 'saving in the side panel updates the table');
    await D.setInputFiles('#importFile', '/tmp/rk/inv2.csv'); await vis(D, '#mapDlg.on'); await D.click('#mapGo'); await sleep(800);
    ok(await D.$$eval('#tb tr', r => r.length) === 3, 're-importing does not duplicate vehicles');
    await D.click('#selAll'); await sleep(500); ok(/3 selected/.test(await D.textContent('#bulkN')), 'select-all selects every visible vehicle');
    await D.fill('#bulkLot', 'Back lot'); await D.click('#bulkSet'); await sleep(600);
    ok(await D.$$eval('#tb tr', r => r.every(x => /Back lot/.test(x.textContent))), 'bulk set location updates all selected');
    const [dl] = await Promise.all([D.waitForEvent('download'), D.click('#bulkExp')]); const csv = fs.readFileSync(await dl.path(), 'utf8'); ok((csv.match(/Back lot/g) || []).length === 3, 'export selected writes the chosen rows');
    D.once('dialog', d => d.accept()); await D.click('#bulkDel'); await sleep(800);
    ok(await D.$$eval('#tb tr', r => r.length) === 0, 'bulk delete removes the selected vehicles');
    ok(errs.length === 0, 'no page errors (' + errs.join(' | ') + ')');
  } catch (e) { fail++; console.log('  FAIL exception:', e.message.split('\n')[0]); }
  console.log(`\n${pass} passed, ${fail} failed`);
  await br.close(); rly.kill(); mock.close(); stat.close(); process.exit(fail ? 1 : 0);
})();
