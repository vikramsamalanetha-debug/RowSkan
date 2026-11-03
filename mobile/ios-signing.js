// Creates a temporary Apple distribution certificate + App Store profile through the App Store Connect API (no devices needed),
// installs them on the build machine, and removes them again afterwards. Zero dependencies (Node 18+, macOS: openssl + security).
// usage: node ios-signing.js setup | cleanup     env: ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_FILE APPLE_TEAM_ID BUNDLE_ID RUNNER_TEMP
const crypto = require('crypto'), fs = require('fs'), path = require('path'), os = require('os'), { execFileSync } = require('child_process');
const E = process.env, TMP = E.RUNNER_TEMP || os.tmpdir(), STATE = path.join(TMP, 'rowskan-signing.json'), API = 'https://api.appstoreconnect.apple.com';
const BUNDLE = E.BUNDLE_ID || 'net.litamerica.rowskan', KC = path.join(TMP, 'rowskan-build.keychain-db'), KCPW = crypto.randomBytes(12).toString('hex');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jwt() {
  const t = Math.floor(Date.now() / 1000), head = b64u(JSON.stringify({ alg: 'ES256', kid: E.ASC_KEY_ID, typ: 'JWT' })), body = b64u(JSON.stringify({ iss: E.ASC_ISSUER_ID, iat: t, exp: t + 900, aud: 'appstoreconnect-v1' }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: fs.readFileSync(E.ASC_KEY_FILE), dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64u(sig);
}
async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + jwt(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch (e) { /* empty body */ }
  if (!r.ok) { const m = (j.errors || []).map((x) => x.title + ': ' + (x.detail || '')).join(' | ') || txt.slice(0, 300); const err = new Error(method + ' ' + p.split('?')[0] + ' -> ' + r.status + ' ' + m); err.status = r.status; throw err; }
  return j;
}
const run = (cmd, args, opt) => execFileSync(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'inherit'] }, opt || {})).toString();
async function setup() {
  const dir = fs.mkdtempSync(path.join(TMP, 'sign-')), key = path.join(dir, 'key.pem'), csr = path.join(dir, 'req.csr'), cer = path.join(dir, 'cert.cer'), pem = path.join(dir, 'cert.pem'), p12 = path.join(dir, 'cert.p12'), P12PW = crypto.randomBytes(9).toString('hex');
  run('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=RowSkan CI/O=LIT America/C=US']);
  const cert = await api('POST', '/v1/certificates', { data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: fs.readFileSync(csr, 'utf8') } } }).catch(async (e) => {
    if (/DISTRIBUTION/.test(e.message) || e.status === 409 || e.status === 400) return api('POST', '/v1/certificates', { data: { type: 'certificates', attributes: { certificateType: 'IOS_DISTRIBUTION', csrContent: fs.readFileSync(csr, 'utf8') } } });
    throw e;
  });
  const certId = cert.data.id; fs.writeFileSync(STATE, JSON.stringify({ certId })); // remembered first so cleanup can remove it even if a later step fails
  fs.writeFileSync(cer, Buffer.from(cert.data.attributes.certificateContent, 'base64'));
  run('openssl', ['x509', '-inform', 'der', '-in', cer, '-out', pem]);
  run('openssl', ['pkcs12', '-export', '-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1', '-inkey', key, '-in', pem, '-out', p12, '-passout', 'pass:' + P12PW]); // old-style encryption: macOS cannot read the newer OpenSSL 3 default
  const bid = await api('GET', '/v1/bundleIds?filter[identifier]=' + encodeURIComponent(BUNDLE) + '&limit=5');
  const bundle = (bid.data || []).find((x) => x.attributes.identifier === BUNDLE); if (!bundle) throw new Error('Bundle ID ' + BUNDLE + ' is not registered in the developer account.');
  const name = 'RowSkan CI ' + (E.GITHUB_RUN_NUMBER || Date.now());
  const prof = await api('POST', '/v1/profiles', { data: { type: 'profiles', attributes: { name, profileType: 'IOS_APP_STORE' }, relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } }, certificates: { data: [{ type: 'certificates', id: certId }] } } } });
  fs.writeFileSync(STATE, JSON.stringify({ certId, profileId: prof.data.id }));
  const pdir = path.join(os.homedir(), 'Library', 'MobileDevice', 'Provisioning Profiles'); fs.mkdirSync(pdir, { recursive: true });
  fs.writeFileSync(path.join(pdir, prof.data.attributes.uuid + '.mobileprovision'), Buffer.from(prof.data.attributes.profileContent, 'base64'));
  // keychain with the certificate and Apple's intermediate certificates
  run('security', ['create-keychain', '-p', KCPW, KC]); run('security', ['set-keychain-settings', '-lut', '21600', KC]); run('security', ['unlock-keychain', '-p', KCPW, KC]);
  for (const u of ['AppleWWDRCAG3.cer', 'AppleWWDRCAG6.cer']) { try { const f = path.join(dir, u); fs.writeFileSync(f, Buffer.from(await (await fetch('https://www.apple.com/certificateauthority/' + u)).arrayBuffer())); run('security', ['import', f, '-k', KC, '-T', '/usr/bin/codesign']); } catch (e) { console.log('note: could not add ' + u); } }
  run('security', ['import', p12, '-k', KC, '-P', P12PW, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
  run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', KCPW, KC]);
  const cur = run('security', ['list-keychains', '-d', 'user']).split('\n').map((x) => x.trim().replace(/"/g, '')).filter(Boolean);
  run('security', ['list-keychains', '-d', 'user', '-s', KC].concat(cur));
  console.log(run('security', ['find-identity', '-v', '-p', 'codesigning', KC]));
  const out = 'PROFILE_NAME=' + name + '\n'; if (E.GITHUB_ENV) fs.appendFileSync(E.GITHUB_ENV, out); console.log('signing ready: profile "' + name + '"');
}
async function cleanup() {
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return console.log('nothing to clean up'); }
  if (st.profileId) await api('DELETE', '/v1/profiles/' + st.profileId).catch((e) => console.log('profile: ' + e.message));
  if (st.certId) await api('DELETE', '/v1/certificates/' + st.certId).then(() => console.log('temporary certificate removed'), (e) => console.log('certificate: ' + e.message));
  try { run('security', ['delete-keychain', KC]); } catch (e) { /* ignore */ }
}
({ setup, cleanup }[process.argv[2]] || (() => { console.error('usage: node ios-signing.js setup|cleanup'); process.exit(1); }))().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
