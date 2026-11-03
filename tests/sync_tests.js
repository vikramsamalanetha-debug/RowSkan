const Y = require((process.env.APPDIR || '/home/claude/rowskan') + '/app/sync.js');
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '  PASS' : '  FAIL', m); };
const rec = (o) => Object.assign({ vin: '1HGCM82633A004352', photos: [], removed: [], f: {} }, o);
(async () => {
  console.log('\n[1] Encryption');
  const k = Y.newAccountKey(), k2 = Y.newAccountKey();
  ok(Y.unb64u(k).length === 32 && k !== k2, 'account key is 256 random bits, different each time');
  const obj = { vin: 'ABC', notes: 'dent on door ünïcode ✓' }; const t = await Y.encryptJson(k, obj);
  ok(!t.includes('dent') && JSON.stringify(await Y.decryptJson(k, t)) === JSON.stringify(obj), 'JSON round-trips and the ciphertext hides the content');
  ok((await Y.encryptJson(k, obj)) !== t, 'same data encrypts differently every time (random IV)');
  let threw = false; try { await Y.decryptJson(k2, t); } catch (e) { threw = true; } ok(threw, 'the wrong key cannot decrypt');
  const raw = Y.unb64u(t); raw[raw.length - 1] ^= 1; threw = false; try { await Y.decryptJson(k, Y.b64u(raw)); } catch (e) { threw = true; } ok(threw, 'a single flipped bit is detected (tamper-proof)');
  const photo = require('crypto').randomBytes(3_000_000); const eb = await Y.encryptBytes(k, photo);
  ok(eb.length === photo.length + 12 + 16 && Buffer.from(await Y.decryptBytes(k, eb)).equals(photo), '3 MB photo bytes round-trip (only 28 bytes of overhead)');

  console.log('\n[2] Linking a new device (QR hand-off)');
  const nd = await Y.newLinkKeys(); ok(Y.unb64u(nd.pub).length === 65 && Y.unb64u(nd.linkId).length === 16, 'new device makes a throw-away public key and a 128-bit link id');
  const secret = { key: k, refreshToken: 'rt-123', email: 'a@b.co', uid: 'uid1' };
  const sealed = await Y.sealHandoff(nd.pub, secret);
  ok(!sealed.includes('rt-123') && !sealed.includes(k), 'the hand-off reveals nothing to the relay');
  ok(JSON.stringify(await Y.openHandoff(nd.priv, sealed)) === JSON.stringify(secret), 'the new device opens it and gets key, token, email and uid');
  const other = await Y.newLinkKeys(); threw = false; try { await Y.openHandoff(other.priv, sealed); } catch (e) { threw = true; } ok(threw, 'a different device (e.g. someone who saw the traffic) cannot open it');
  ok((await Y.sealHandoff(nd.pub, secret)) !== sealed, 'each hand-off is unique (fresh ephemeral key)');

  console.log('\n[3] Merging vehicle records (two devices, any order)');
  const A = Y.stamp(rec({ notes: 'from phone', lotLocation: 'Row 3' }), ['notes', 'lotLocation'], '2026-11-02T10:00:00Z');
  const B = Y.stamp(rec({ lotLocation: 'Row 9' }), ['lotLocation'], '2026-11-02T11:00:00Z');
  const m1 = Y.mergeRecords(A, B), m2 = Y.mergeRecords(B, A);
  ok(Y.sameRecord(m1, m2), 'merge gives the same result in either order');
  ok(m1.lotLocation === 'Row 9' && m1.notes === 'from phone', 'edits to different fields both survive; the later edit of the same field wins');
  ok(Y.sameRecord(Y.mergeRecords(m1, m1), m1) && Y.sameRecord(Y.mergeRecords(m1, A), m1), 'merging is idempotent (replays and duplicates are harmless)');
  const P1 = rec({ photos: [{ id: 'p-aaaa1111', takenAt: '1' }, { id: 'p-bbbb2222', takenAt: '2' }] }), P2 = rec({ photos: [{ id: 'p-cccc3333', takenAt: '3' }, { id: 'p-bbbb2222', takenAt: '2' }] });
  ok(Y.mergeRecords(P1, P2).photos.map(p => p.id).join() === 'p-aaaa1111,p-bbbb2222,p-cccc3333', 'photos from both devices are combined, no duplicates');
  const R = rec({ removed: ['p-bbbb2222'] }); const pr = Y.mergeRecords(Y.mergeRecords(P1, P2), R);
  ok(pr.photos.map(p => p.id).join() === 'p-aaaa1111,p-cccc3333' && Y.sameRecord(pr, Y.mergeRecords(R, Y.mergeRecords(P2, P1))), 'a removed photo stays removed even if an old copy still has it');
  const E = Y.stamp(rec({ notes: 'x' }), ['notes'], '2026-11-02T10:00:00Z'); const D = rec({ deleted: true, deletedAt: '2026-11-02T12:00:00Z' });
  ok(Y.mergeRecords(E, D).deleted === true && Y.sameRecord(Y.mergeRecords(E, D), Y.mergeRecords(D, E)), 'a deletion beats an older edit');
  const E2 = Y.stamp(rec({ notes: 'came back' }), ['notes'], '2026-11-02T13:00:00Z');
  const back = Y.mergeRecords(D, E2); ok(!back.deleted && back.notes === 'came back', 'a vehicle added again AFTER the deletion comes back');
  ok(Y.mergeRecords(null, A).notes === 'from phone' && Y.mergeRecords(A, null).lotLocation === 'Row 3', 'merging with nothing returns the other side');
  // brute force: random edits on 3 replicas, delivered in random orders -> all converge
  let converged = true;
  for (let n = 0; n < 200; n++) {
    const ev = []; for (let i = 0; i < 6; i++) { const r = rec({}); const at = '2026-11-02T' + String(10 + Math.floor(Math.random() * 10)).padStart(2, '0') + ':00:00Z'; const c = Math.random();
      if (c < 0.3) { r.notes = 'n' + i; Y.stamp(r, ['notes'], at); } else if (c < 0.6) { r.lotLocation = 'L' + i; Y.stamp(r, ['lotLocation'], at); } else if (c < 0.8) r.photos = [{ id: 'ph-' + String(i).padStart(6, '0'), takenAt: at }]; else if (c < 0.9) r.removed = ['ph-' + String(Math.floor(Math.random() * 6)).padStart(6, '0')]; else { r.deleted = true; r.deletedAt = at; } ev.push(r); }
    const fold = (order) => order.reduce((acc, e) => Y.mergeRecords(acc, e), null);
    const sh = () => ev.map(e => [Math.random(), e]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const r1 = fold(sh()), r2 = fold(sh()); if (!Y.sameRecord(r1, r2)) { converged = false; break; }
  }
  ok(converged, '200 random sequences of edits/photos/removals/deletions delivered in different orders all end identical');
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
