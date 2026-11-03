const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  PASS' : '  FAIL', m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = fs.readFileSync('/tmp/rk/k.pem'), KEY2 = fs.readFileSync('/tmp/rk/k2.pem'), CERT = fs.readFileSync('/tmp/rk/c.pem', 'utf8');
const PROJ = 'rowskan-test', b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwt(uid, o = {}) {
  const t = Math.floor(Date.now() / 1000), h = { alg: o.alg || 'RS256', kid: o.kid || 'kid1', typ: 'JWT' };
  const p = { iss: 'https://securetoken.google.com/' + (o.iss || PROJ), aud: o.aud || PROJ, sub: uid, iat: t - 10, exp: o.exp || t + 3600 };
  const si = b64u(JSON.stringify(h)) + '.' + b64u(JSON.stringify(p));
  const sig = crypto.createSign('RSA-SHA256').update(si).sign(o.key || KEY);
  return si + '.' + b64u(sig);
}
const certSrv = http.createServer((q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ kid1: CERT })); });
function call(method, p, token, body, raw) {
  return new Promise((res, rej) => {
    const data = body && !raw ? JSON.stringify(body) : raw;
    const r = http.request({ method, hostname: '127.0.0.1', port: 18787, path: p, headers: Object.assign(token ? { Authorization: 'Bearer ' + token } : {}, data ? { 'Content-Length': Buffer.byteLength(data), 'Content-Type': raw ? 'application/octet-stream' : 'application/json' } : {}) }, x => {
      const ch = []; x.on('data', c => ch.push(c)); x.on('end', () => { const buf = Buffer.concat(ch); let j = null; try { j = JSON.parse(buf.toString()); } catch (e) {} res({ status: x.statusCode, json: j, buf }); });
    }); r.on('error', rej); if (data) r.write(data); r.end();
  });
}
function start(env, dir) { const p = spawn('node', [(process.env.APPDIR || '/home/claude/rowskan') + '/relay/relay.js'], { env: { ...process.env, RELAY_PROJECT_ID: PROJ, RELAY_DATA: dir, RELAY_PORT: 18787, RELAY_CERTS_URL: 'http://127.0.0.1:18786/', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); p.out = ''; p.stdout.on('data', d => p.out += d); p.stderr.on('data', d => p.out += d); return p; }
(async () => {
  await new Promise(r => certSrv.listen(18786, '127.0.0.1', r));
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')), s = start({}, dir); await sleep(600);
  const A = jwt('userA'), B = jwt('userB'), D1 = 'phone-0001', D2 = 'comp-00001', D3 = 'web-000001';
  const reg = (tok, id, kind) => call('POST', '/v1/devices', tok, { deviceId: id, name: id, kind });
  console.log('\n[1] Who may talk to the relay');
  ok((await call('GET', '/health')).status === 200, 'health check needs no sign-in');
  ok((await call('GET', '/v1/devices')).status === 401, 'no token -> 401');
  ok((await call('GET', '/v1/devices', 'garbage')).status === 401, 'garbage token -> 401');
  ok((await call('GET', '/v1/devices', jwt('userA', { key: KEY2 }))).status === 401, 'token signed by a different key -> 401 (forged)');
  ok((await call('GET', '/v1/devices', jwt('userA', { exp: Math.floor(Date.now() / 1000) - 5 }))).status === 401, 'expired token -> 401');
  ok((await call('GET', '/v1/devices', jwt('userA', { aud: 'other-project', iss: 'other-project' }))).status === 401, 'token for another Firebase project -> 401');
  ok((await call('GET', '/v1/devices', jwt('userA', { alg: 'HS256' }))).status === 401, 'wrong algorithm -> 401');
  ok((await call('GET', '/v1/devices', A)).status === 200, 'a valid token works');

  console.log('\n[2] Devices and mailboxes');
  ok((await reg(A, D1, 'phone')).status === 200 && (await reg(A, D2, 'windows')).status === 200 && (await reg(A, D3, 'web')).status === 200, 'three devices register');
  ok((await reg(A, 'x', 'phone')).status === 400, 'bad device id rejected');
  let r = await call('POST', '/v1/send', A, { from: D1, kind: 'change', payload: 'Y2lwaGVydGV4dC0x' });
  ok(r.status === 200 && r.json.delivered_to === 2, 'one change from the phone lands in the other two devices\' mailboxes');
  r = await call('GET', '/v1/inbox?device=' + D2 + '&after=0', A); ok(r.json.messages.length === 1 && r.json.messages[0].payload === 'Y2lwaGVydGV4dC0x' && r.json.messages[0].from === D1 && r.json.messages[0].seq === 1, 'computer receives it, with sender and sequence number');
  r = await call('GET', '/v1/inbox?device=' + D1 + '&after=0', A); ok(r.json.messages.length === 0, 'the sender does not get its own change back');
  await call('POST', '/v1/send', A, { from: D1, kind: 'change', payload: 'c2Vjb25k', to: [D2] });
  r = await call('GET', '/v1/inbox?device=' + D3 + '&after=0', A); ok(r.json.messages.length === 1, 'a targeted message reaches only its target (web device still has 1)');
  r = await call('GET', '/v1/inbox?device=' + D2 + '&after=1', A); ok(r.json.messages.length === 1 && r.json.messages[0].seq === 2, '"after" cursor returns only newer messages');
  r = await call('POST', '/v1/ack', A, { device: D2, upTo: 2 }); ok(r.json.deleted === 2, 'after the computer confirms receipt the relay deletes both messages');
  r = await call('GET', '/v1/inbox?device=' + D2 + '&after=0', A); ok(r.json.messages.length === 0, 'computer\'s mailbox is empty again');
  r = await call('GET', '/v1/inbox?device=' + D3 + '&after=0', A); ok(r.json.messages.length === 1, 'the web device\'s copy is untouched by the computer\'s confirmation');
  ok((await call('POST', '/v1/send', A, { from: D1, kind: 'change', payload: 'x'.repeat(300000) })).status === 413, 'oversized message refused');
  ok((await call('POST', '/v1/send', A, { from: 'nope-12345', kind: 'change', payload: 'eA==' })).status === 404, 'unknown sender refused');
  ok((await call('POST', '/v1/send', A, { from: D1, kind: 'bogus', payload: 'eA==' })).status === 400, 'bad kind refused');

  console.log('\n[3] Accounts never see each other');
  await reg(B, D1, 'phone'); await reg(B, 'otherdev-1', 'windows');
  r = await call('GET', '/v1/devices', B); ok(r.json.devices.length === 2, 'user B sees only B\'s two devices (even though a device id repeats)');
  r = await call('GET', '/v1/inbox?device=' + D3, B); ok(r.status === 404, 'user B cannot read user A\'s web device mailbox');
  r = await call('POST', '/v1/send', B, { from: D1, kind: 'change', payload: 'QkJC' }); r = await call('GET', '/v1/inbox?device=' + D2 + '&after=0', A); ok(r.json.messages.length === 0, 'B\'s message never lands in A\'s mailbox');

  console.log('\n[4] Photos (encrypted attachments)');
  const blob = crypto.randomBytes(5000), BID = 'photo-0001';
  r = await call('PUT', '/v1/blob?id=' + BID + '&from=' + D1 + '&to=' + D2, A, null, blob); ok(r.status === 200, 'phone uploads an encrypted photo for the computer');
  r = await call('GET', '/v1/blob?id=' + BID + '&device=' + D2, A); ok(r.status === 200 && r.buf.equals(blob), 'computer downloads exactly the same bytes');
  r = await call('GET', '/v1/blob?id=' + BID + '&device=' + D3, A); ok(r.status === 404, 'a device it was not addressed to cannot download it');
  r = await call('GET', '/v1/blob?id=' + BID + '&device=' + D2, B); ok(r.status === 404, 'another account cannot download it');
  r = await call('POST', '/v1/send', A, { from: D1, kind: 'change', payload: 'cGhvdG8=', to: [D2], blobs: [BID] }); ok(r.status === 200, 'a change can reference the photo');
  r = await call('POST', '/v1/send', A, { from: D1, kind: 'change', payload: 'cGhvdG8=', blobs: ['missing-id-1'] }); ok(r.status === 400, 'referencing a photo that was never uploaded is refused');
  const m = (await call('GET', '/v1/inbox?device=' + D2 + '&after=2', A)).json.messages; await call('POST', '/v1/ack', A, { device: D2, upTo: m[m.length - 1].seq });
  r = await call('GET', '/v1/blob?id=' + BID + '&device=' + D2, A); ok(r.status === 404, 'once the computer confirms, the photo is deleted from the relay');
  ok(fs.readdirSync(path.join(dir, fs.readdirSync(dir).find(d => fs.existsSync(path.join(dir, d, 'blobs'))), 'blobs')).length === 0, 'and the file is really gone from disk');
  ok((await call('PUT', '/v1/blob?id=big-000001&from=' + D1 + '&to=' + D2, A, null, Buffer.alloc(13 * 1024 * 1024))).status === 413, 'photos over 12 MB refused');
  r = await call('PUT', '/v1/blob?id=' + 'dup-000001' + '&from=' + D1, A, null, Buffer.from('a')); ok(r.status === 200, 'blob with no "to" goes to all other devices');
  ok((await call('PUT', '/v1/blob?id=dup-000001&from=' + D1, A, null, Buffer.from('b'))).status === 409, 'reusing an attachment id is refused');

  console.log('\n[5] Removing a device and deleting an account');
  r = await call('DELETE', '/v1/devices?deviceId=' + D3, A); ok(r.status === 200, 'remove the web device');
  r = await call('GET', '/v1/inbox?device=' + D3, A); ok(r.status === 404 && /Link it again/.test(r.json.error), 'a removed device is told to link again');
  r = await call('DELETE', '/v1/account', B); ok(r.status === 200, 'user B deletes their account data');
  r = await call('GET', '/v1/devices', B); ok(r.json.devices.length === 0, 'nothing is left for B');
  ok(!fs.readdirSync(dir).some(d => fs.existsSync(path.join(dir, d, 'state.json')) && fs.readFileSync(path.join(dir, d, 'state.json'), 'utf8').includes('otherdev-1')), 'and B\'s files are gone from disk');
  r = await call('GET', '/v1/devices', A); ok(r.json.devices.length === 2, 'A is unaffected');
  s.kill(); await sleep(300);

  console.log('\n[6] Limits: device count, quota, expiry');
  fs.rmSync(dir, { recursive: true, force: true }); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-')); s = start({ RELAY_QUOTA_BYTES: '3000', RELAY_TTL_DAYS: '0.00002' }, dir); await sleep(600);
  for (let i = 1; i <= 10; i++) await reg(A, 'dev-' + String(i).padStart(4, '0'), 'other');
  ok((await reg(A, 'dev-0011', 'other')).status === 409, 'an account is limited to 10 devices');
  ok((await reg(A, 'dev-0001', 'other')).status === 200, 're-registering an existing device is fine');
  r = await call('POST', '/v1/send', A, { from: 'dev-0001', kind: 'change', payload: 'x'.repeat(2000), to: ['dev-0002'] }); ok(r.status === 200, 'first 2 KB change accepted');
  r = await call('POST', '/v1/send', A, { from: 'dev-0001', kind: 'change', payload: 'x'.repeat(2000), to: ['dev-0002'] }); ok(r.status === 507, 'quota: a second 2 KB change is refused with a clear message');
  ok(/too much undelivered data/.test(r.json.error), 'the message tells the user to open their other devices');
  await sleep(2500); // TTL 0.00002 days = 1.7 s
  r = await call('GET', '/v1/inbox?device=dev-0002&after=0', A); ok(r.json.messages.length === 0, 'undelivered mail expires after the retention time');
  r = await call('POST', '/v1/send', A, { from: 'dev-0001', kind: 'change', payload: 'x'.repeat(2000), to: ['dev-0002'] }); ok(r.status === 200, 'expiry frees the quota again');
  s.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true });


  console.log('\n[8] QR link channel');
  s = start({ RELAY_LINK_TTL_MS: '1500' }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'))); await sleep(600);
  const LID = crypto.randomBytes(16).toString('base64url'), secret = crypto.randomBytes(300);
  ok((await call('GET', '/v1/link?id=' + LID)).status === 404, 'nothing there before the signed-in device scans');
  ok((await call('PUT', '/v1/link?id=' + LID, null, null, secret)).status === 401, 'only a signed-in device may leave a hand-off');
  ok((await call('PUT', '/v1/link?id=short', A, null, secret)).status === 400, 'guessable (short) ids are refused');
  ok((await call('PUT', '/v1/link?id=' + LID, A, null, secret)).status === 200, 'signed-in phone leaves the encrypted hand-off');
  ok((await call('PUT', '/v1/link?id=' + LID, A, null, secret)).status === 409, 'the same code cannot be used twice');
  r = await call('GET', '/v1/link?id=' + LID); ok(r.status === 200 && r.buf.equals(secret), 'the new device (no sign-in) reads it with the random id');
  ok((await call('GET', '/v1/link?id=' + LID)).status === 404, 'and it is deleted after that one read');
  const LID2 = crypto.randomBytes(16).toString('base64url'); await call('PUT', '/v1/link?id=' + LID2, A, null, secret); await sleep(2200);
  ok((await call('GET', '/v1/link?id=' + LID2)).status === 404, 'an unclaimed hand-off expires');
  ok((await call('PUT', '/v1/link?id=' + crypto.randomBytes(16).toString('base64url'), A, null, Buffer.alloc(30000))).status === 413, 'oversized hand-off refused');
  s.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true });

  console.log('\n[7] Not configured');
  s = start({ RELAY_PROJECT_ID: '' }, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'))); await sleep(600);
  ok((await call('GET', '/v1/devices', A)).status === 503, 'without a Firebase project id the relay refuses everything');
  s.kill(); certSrv.close(); fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
