/*
 * RowSkan sign-in + background sync engine. A product of LIT America (www.litamerica.net).
 *  - Sign-in: Firebase Authentication (email + password) through its public REST API.
 *  - Sync: every device keeps its own full copy; changes travel through the encrypted relay (see relay/).
 *  - Nothing here ever sends the account key, vehicle data or photos to the relay unencrypted.
 */
(function () {
  'use strict';
  var CFG = Object.assign({ apiKey: '', projectId: '', relayUrl: '', appUrl: '', authBase: 'https://identitytoolkit.googleapis.com', tokenBase: 'https://securetoken.googleapis.com', pollMs: 8000 }, window.ROWSKAN_CONFIG || {});
  CFG.relayUrl = String(CFG.relayUrl || '').replace(/\/+$/, ''); CFG.fs = !CFG.relayUrl && !!CFG.projectId && CFG.firestore !== false; // default: sync through the user's own Firebase (Firestore); a relayUrl switches to a self-hosted relay
  var configured = function () { return !!(CFG.relayUrl || CFG.fs); }; CFG.authBase = CFG.authBase.replace(/\/+$/, ''); CFG.tokenBase = CFG.tokenBase.replace(/\/+$/, '');
  var S = window.RS_Store, Y = window.RowSkanSync;
  var handlers = {};
  function on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }
  function emit(ev, data) { (handlers[ev] || []).forEach(function (f) { try { f(data); } catch (e) { /* a listener must never break sync */ } }); }
  function nowIso() { return new Date().toISOString(); }

  /* ------------------------------------------------------------ passwords (same rules everywhere) */
  var COMMON = ['password', 'password1', 'password12', 'password123', '12345678', '123456789', '1234567890', '11111111', '00000000', 'qwertyui', 'qwerty123', 'abcd1234', 'abc12345', 'iloveyou', 'letmein1', 'welcome1', 'admin123', 'rowskan1', 'rowskan123'];
  function passwordProblem(pw) {
    if (!pw) return 'Enter a password.';
    if (pw.length < 8) return 'Use at least 8 characters.';
    if (new TextEncoder().encode(pw).length > 72) return 'Use 72 characters or fewer.';
    if (/^(.)\1+$/.test(pw) || COMMON.indexOf(pw.toLowerCase()) >= 0) return 'That password is too easy to guess. Choose another one.';
    return null;
  }

  /* ------------------------------------------------------------ Firebase Auth (REST) */
  var acct = null, session = { idToken: '', exp: 0 }; // acct = { email, uid, refreshToken }
  function authError(code, status) {
    var m = {
      EMAIL_EXISTS: 'That email already has an account. Sign in instead.', INVALID_EMAIL: 'Enter a valid email address.', WEAK_PASSWORD: 'Choose a stronger password.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.', USER_DISABLED: 'This account has been disabled.',
      OPERATION_NOT_ALLOWED: 'Email/password sign-in is switched off in the Firebase project (the owner must enable it).',
      INVALID_LOGIN_CREDENTIALS: 'Email or password is incorrect.', INVALID_PASSWORD: 'Email or password is incorrect.', EMAIL_NOT_FOUND: 'Email or password is incorrect.'
    };
    var e = new Error(m[code] || (status >= 500 ? 'The sign-in service had a problem. Try again in a moment.' : 'Could not complete that (' + (code || status) + ').'));
    e.code = code; e.status = status; return e;
  }
  function fbPost(url, body, asForm) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': asForm ? 'application/x-www-form-urlencoded' : 'application/json' }, body: asForm ? new URLSearchParams(body).toString() : JSON.stringify(body) })
      .catch(function () { var e = new Error('Could not reach the sign-in service. Check your internet connection.'); e.offline = true; throw e; })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw authError(String((j.error && j.error.message) || '').split(/[ :]/)[0], r.status); return j; }); });
  }
  var fbOp = function (op, body) { return fbPost(CFG.authBase + '/v1/accounts:' + op + '?key=' + encodeURIComponent(CFG.apiKey), body); };
  function adopt(j) {
    acct = { email: String(j.email || (acct && acct.email) || '').toLowerCase(), uid: j.localId || j.user_id || (acct && acct.uid), refreshToken: j.refreshToken || j.refresh_token };
    session = { idToken: j.idToken || j.id_token, exp: Date.now() + (+(j.expiresIn || j.expires_in || 3600)) * 1000 };
    return S.metaSet('acct', acct).then(function () { return acct; });
  }
  function signUp(email, pw) {
    var p = passwordProblem(pw); if (p) return Promise.reject(new Error(p));
    if (!CFG.apiKey) return Promise.reject(new Error('Sign-in is not set up in this copy of RowSkan.'));
    return fbOp('signUp', { email: email.trim().toLowerCase(), password: pw, returnSecureToken: true }).then(adopt);
  }
  function signIn(email, pw) {
    if (!pw) return Promise.reject(new Error('Enter your password.'));
    if (!CFG.apiKey) return Promise.reject(new Error('Sign-in is not set up in this copy of RowSkan.'));
    return fbOp('signInWithPassword', { email: email.trim().toLowerCase(), password: pw, returnSecureToken: true }).then(adopt);
  }
  function sendReset(email) { // always looks successful, so it never reveals who has an account
    return fbOp('sendOobCode', { requestType: 'PASSWORD_RESET', email: email.trim().toLowerCase() }).catch(function (e) { if (e.code === 'EMAIL_NOT_FOUND') return {}; throw e; });
  }
  function refresh() {
    if (!acct || !acct.refreshToken) return Promise.reject(new Error('Signed out'));
    return fbPost(CFG.tokenBase + '/v1/token?key=' + encodeURIComponent(CFG.apiKey), { grant_type: 'refresh_token', refresh_token: acct.refreshToken }, true)
      .then(function (j) { return adopt(Object.assign({ email: acct.email }, j)); })
      .catch(function (e) { if (!e.offline && /TOKEN_EXPIRED|USER_DISABLED|USER_NOT_FOUND|INVALID_REFRESH_TOKEN/.test(e.code || '')) { signedOut('Your sign-in expired. Please sign in again.'); } throw e; });
  }
  function idToken() { return (session.idToken && session.exp - 60000 > Date.now()) ? Promise.resolve(session.idToken) : refresh().then(function () { return session.idToken; }); }
  function signedOut(msg) { acct = null; session = { idToken: '', exp: 0 }; S.metaDel('acct'); emit('signedout', msg || ''); }

  var fsInst = null;
  function fsx() { return fsInst || (fsInst = window.RS_Fs.make({ project: CFG.projectId, base: CFG.firestoreBase, token: idToken, uid: function () { return acct && acct.uid; } })); }

  /* ------------------------------------------------------------ relay */
  function relay(method, path, body, raw) {
    if (!configured()) return Promise.reject(Object.assign(new Error('Sync server not set up'), { notConfigured: true }));
    if (CFG.fs) return fsx().call(method, path, body, raw);
    return idToken().then(function (tok) {
      var headers = { Authorization: 'Bearer ' + tok }; if (body) headers['Content-Type'] = 'application/json'; if (raw) headers['Content-Type'] = 'application/octet-stream';
      return fetch(CFG.relayUrl + path, { method: method, headers: headers, body: raw ? raw : (body ? JSON.stringify(body) : undefined), cache: 'no-store' });
    }).catch(function (e) { if (e && e.status !== undefined) throw e; var er = new Error(e && e.message || 'offline'); er.offline = true; er.cause = e; throw er; })
      .then(function (r) {
        if (r.ok) return path.indexOf('/v1/blob') === 0 && method === 'GET' ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) : r.json();
        return r.json().catch(function () { return {}; }).then(function (j) { var e = new Error(j.error || 'Server problem (' + r.status + ')'); e.status = r.status; throw e; });
      });
  }

  /* ------------------------------------------------------------ account key / device state */
  var meta = { key: null, deviceId: null, lastSeq: 0, name: '' };
  function loadMeta() {
    return Promise.all([S.metaGet('acct'), S.metaGet('key'), S.metaGet('deviceId'), S.metaGet('lastSeq'), S.metaGet('deviceName')]).then(function (r) {
      acct = r[0] || null; meta.key = r[1] || null; meta.deviceId = r[2] || null; meta.lastSeq = r[3] || 0; meta.name = r[4] || '';
      return acct;
    });
  }
  function setName(n) { meta.name = String(n || '').slice(0, 40); return S.metaSet('deviceName', meta.name); }
  function setKey(k) { meta.key = k; return S.metaSet('key', k); }
  function resetDevice() { meta.deviceId = null; meta.lastSeq = 0; return Promise.all([S.metaDel('deviceId'), S.metaDel('lastSeq')]); }
  var others = []; // other devices on this account (from the last check)
  var DEVICE_KIND = (function () { var u = navigator.userAgent || ''; return /Android|iPhone|iPad|Mobile/i.test(u) ? 'phone' : /Windows/i.test(u) ? 'windows' : 'web'; })();

  /* ------------------------------------------------------------ vehicle records on the wire */
  function wire(v) {
    var r = { vin: v.vin, photos: (v.photos || []).map(function (p) { return { id: p.id, takenAt: p.takenAt }; }), removed: v.removed || [], f: v.f || {}, u: v.u };
    ['decoded', 'notes', 'lotLocation', 'capturedAt'].forEach(function (k) { if (v[k] !== undefined && v[k] !== null) r[k] = v[k]; });
    if (v.deletedAt) { r.deletedAt = v.deletedAt; } if (v.deleted) r.deleted = true;
    return r;
  }
  function send(msg, kind, blobs, to) {
    return Y.encodeMessage(meta.key, msg).then(function (payload) { return relay('POST', '/v1/send', { from: meta.deviceId, to: to, kind: kind, payload: payload, blobs: blobs || [] }); });
  }
  function sendRecord(v, to) { // uploads the photos the other devices do not have yet, then the record itself
    var blobs = {}, ids = [], sentNow = [];
    var chain = Promise.resolve();
    (v.photos || []).forEach(function (p) {
      if (!to && (v.sent || []).indexOf(p.id) >= 0) return;
      chain = chain.then(function () {
        return S.getPhoto(p.id).then(function (rec) {
          if (!rec || !rec.blob) return;
          return rec.blob.arrayBuffer().then(function (ab) { return Y.encryptBytes(meta.key, new Uint8Array(ab)); }).then(function (enc) {
            var bid = (String(p.id).replace(/[^A-Za-z0-9_-]/g, '') + '-' + Y.randomId(4)).slice(0, 64);
            return relay('PUT', '/v1/blob?id=' + encodeURIComponent(bid) + '&from=' + encodeURIComponent(meta.deviceId) + (to ? '&to=' + encodeURIComponent(to.join(',')) : ''), null, enc).then(function () { blobs[p.id] = bid; ids.push(bid); sentNow.push(p.id); });
          });
        });
      });
    });
    return chain.then(function () { return send({ t: 'rec', rec: wire(v), blobs: blobs }, 'change', ids, to); }).then(function () { return sentNow; });
  }

  /* ------------------------------------------------------------ cycle: register, send, receive */
  var busy = false, kickT = null, timer = null, st = { state: 'idle', error: '', lastOk: 0, pending: 0 };
  function setState(s, err) { st.state = s; st.error = err || ''; if (s === 'ok') st.lastOk = Date.now(); emit('status', Object.assign({}, st)); }
  function ensureDevice() {
    return relay('GET', '/v1/devices').then(function (r) {
      var list = r.devices || [], mine = meta.deviceId && list.some(function (d) { return d.deviceId === meta.deviceId; });
      others = list.filter(function (d) { return d.deviceId !== meta.deviceId; });
      var step = Promise.resolve();
      if (!meta.deviceId) { meta.deviceId = Y.randomId(12); step = S.metaSet('deviceId', meta.deviceId); }
      if (!meta.key) {
        if (others.length) return step.then(function () { return 'needslink'; });   // other devices hold the key: link with one of them
        step = step.then(function () { return setKey(Y.newAccountKey()); });         // first device on this account
      }
      if (mine) return step.then(function () { return 'ready'; });
      return step.then(function () { meta.lastSeq = 0; return S.metaSet('lastSeq', 0); })
        .then(function () { return relay('POST', '/v1/devices', { deviceId: meta.deviceId, name: meta.name || DEVICE_KIND, kind: DEVICE_KIND, pub: '' }); })
        .then(function () { return others.length ? send({ t: 'need-history' }, 'ctl', [], undefined) : null; })
        .then(function () { return 'ready'; });
    });
  }
  function pushDirty() {
    return S.allVeh().then(function (list) {
      var todo = list.filter(function (v) { return v.done !== false && v.dirty; }); st.pending = todo.length; emit('status', Object.assign({}, st));
      return todo.reduce(function (p, v) {
        return p.then(function () {
          if (!others.length) return S.getVeh(v.vin).then(function (f) { if (f && f.rev === v.rev) { f.dirty = false; return S.putVeh(f); } }); // nobody to send to yet; a device that joins asks for everything
          return sendRecord(v).then(function (sentIds) {
            return S.getVeh(v.vin).then(function (f) {
              if (!f) return;
              f.sent = Array.from(new Set((f.sent || []).concat(sentIds)));
              if (f.rev === v.rev) f.dirty = false;
              return S.putVeh(f);
            });
          });
        });
      }, Promise.resolve());
    });
  }
  function processHistory() {
    return S.metaGet('historyFor').then(function (want) {
      want = (want || []).filter(function (id) { return others.some(function (d) { return d.deviceId === id; }); });
      if (!want.length) return S.metaSet('historyFor', []);
      return S.allVeh().then(function (list) {
        return want.reduce(function (p, dev) {
          return p.then(function () { return list.reduce(function (q, v) { return q.then(function () { return sendRecord(v, [dev]); }); }, Promise.resolve()); })
            .then(function () { return S.metaGet('historyFor'); }).then(function (cur) { return S.metaSet('historyFor', (cur || []).filter(function (x) { return x !== dev; })); });
        }, Promise.resolve());
      });
    });
  }
  function writeMerged(vin, incoming, blobMap) {
    return S.getVeh(vin).then(function (local) {
      var merged = Y.mergeRecords(local ? wire(local) : null, incoming);
      var out = Object.assign({}, local || {}, merged);
      if (!local) { out.done = true; out.dirty = false; out.rev = 0; out.sent = []; }
      var fetchPhotos = (merged.photos || []).filter(function (p) { return blobMap && blobMap[p.id]; });
      return fetchPhotos.reduce(function (p, ph) {
        return p.then(function () {
          return S.getPhoto(ph.id).then(function (have) {
            if (have) return;
            return relay('GET', '/v1/blob?id=' + encodeURIComponent(blobMap[ph.id]) + '&device=' + encodeURIComponent(meta.deviceId))
              .then(function (enc) { return Y.decryptBytes(meta.key, enc); })
              .then(function (bytes) { return S.putPhoto({ id: ph.id, vin: vin, blob: new Blob([bytes], { type: 'image/jpeg' }) }); })
              .catch(function (e) { if (e.status === 404) return; throw e; }); // gone from the relay (expired): the photo stays on the device that took it
          });
        });
      }, Promise.resolve()).then(function () {
        var gone = (merged.removed || []).concat(out.deleted ? (local && local.photos || []).map(function (p) { return p.id; }) : []);
        return Promise.all(gone.map(function (id) { return S.delPhoto(id); }));
      }).then(function () {
        // keep whatever the screen is editing right now: re-read, then merge again so no edit made meanwhile is lost
        return S.getVeh(vin).then(function (again) {
          var fin = again ? Object.assign({}, again, Y.mergeRecords(wire(again), merged)) : out;
          if (again) { fin.done = again.done; fin.dirty = again.dirty; fin.rev = again.rev; fin.sent = again.sent || out.sent || []; } else { fin = out; }
          return S.putVeh(fin).then(function () { emit('vehicle', { vin: vin }); });
        });
      });
    });
  }
  function applyMessage(m) {
    return Y.decodeMessage(meta.key, m.payload).then(function (msg) {
      if (msg.t === 'need-history') { return S.metaGet('historyFor').then(function (cur) { cur = cur || []; if (cur.indexOf(m.from) < 0) cur.push(m.from); return S.metaSet('historyFor', cur); }); }
      if (msg.t === 'rec' && msg.rec && /^[A-Z0-9]{3,20}$/.test(String(msg.rec.vin))) return writeMerged(msg.rec.vin, msg.rec, msg.blobs || {});
    }, function () { var e = new Error('Could not read a message from another device (different account key).'); e.keyMismatch = true; throw e; });
  }
  function pull() {
    function page() {
      return relay('GET', '/v1/inbox?device=' + encodeURIComponent(meta.deviceId) + '&after=' + meta.lastSeq + '&limit=50').then(function (r) {
        var msgs = r.messages || []; if (!msgs.length) return;
        return msgs.reduce(function (p, m) { return p.then(function () { return applyMessage(m); }); }, Promise.resolve()).then(function () {
          var last = msgs[msgs.length - 1].seq; meta.lastSeq = last;
          return S.metaSet('lastSeq', last).then(function () { return relay('POST', '/v1/ack', { device: meta.deviceId, upTo: last }); }).then(function () { if (r.more) return page(); });
        });
      });
    }
    return page();
  }
  function cycle() {
    if (busy) return Promise.resolve();
    if (!acct) return Promise.resolve();
    if (!configured()) { setState('unconfigured'); return Promise.resolve(); }
    busy = true; setState('syncing');
    return ensureDevice().then(function (r) {
      if (r === 'needslink') { setState('needslink'); return; }
      return processHistory().then(pushDirty).then(pull).then(function () { setState('ok'); });
    }).catch(function (e) {
      if (e.offline) setState('offline');
      else if (e.keyMismatch) setState('error', e.message);
      else if (e.status === 404 && /not registered|removed/i.test(e.message)) { removedHere(); }
      else if (e.status === 401) { setState('error', 'Sign in again.'); }
      else setState('error', e.message);
    }).then(function () { busy = false; });
  }
  function removedHere() { // another device removed this one: keep the local data, forget the key, ask to link again
    return Promise.all([S.metaDel('key'), resetDevice()]).then(function () { meta.key = null; setState('needslink'); emit('removed'); });
  }
  function kickSoon() { clearTimeout(kickT); kickT = setTimeout(cycle, 400); }
  function start() {
    stop();
    var every = CFG.fs ? (DEVICE_KIND === 'phone' ? 60000 : 300000) : CFG.pollMs; // free Firebase plan: be gentle with reads
    timer = setInterval(function () { if (!document.hidden) cycle(); }, every); cycle();
  }
  function stop() { clearInterval(timer); timer = null; clearInterval(boostT); boostT = null; }
  var boostT = null;
  function boost(ms) { // after approving a new device, check often for a couple of minutes so its inventory arrives within seconds
    clearInterval(boostT); var until = Date.now() + (ms || 120000);
    boostT = setInterval(function () { if (Date.now() > until) { clearInterval(boostT); boostT = null; return; } cycle(); }, 4000);
  }
  window.addEventListener('online', function () { if (acct) cycle(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && acct) cycle(); });

  /* ------------------------------------------------------------ linking a new device (QR) */
  function appBase() { return (CFG.appUrl || (location.origin + location.pathname)).replace(/#.*$/, ''); }
  function startLinkRequest() { // the NEW device: make a one-time key pair and a link to show as QR / text
    return Y.newLinkKeys().then(function (k) {
      var text = appBase() + '#link=' + Y.b64u(new TextEncoder().encode(JSON.stringify({ l: k.linkId, p: k.pub, n: meta.name || DEVICE_KIND })));
      return { text: text, linkId: k.linkId, priv: k.priv };
    });
  }
  function awaitLink(req, isCancelled) { // poll the relay until the signed-in device leaves the hand-off
    function poll() {
      if (isCancelled && isCancelled()) return Promise.resolve(null);
      var got = CFG.fs ? fsx().linkGet(req.linkId) : fetch(CFG.relayUrl + '/v1/link?id=' + encodeURIComponent(req.linkId), { cache: 'no-store' }).then(function (r) { return r.status === 200 ? r.text() : null; });
      return got.then(function (txt) { if (txt) return txt; return new Promise(function (res) { setTimeout(res, 1500); }).then(poll); })
        .catch(function () { return new Promise(function (res) { setTimeout(res, 3000); }).then(poll); });
    }
    return poll().then(function (text) {
      if (!text) return null;
      return Y.openHandoff(req.priv, text).then(function (p) {
        if (!p || !p.key) throw new Error('That link was not valid.');
        var s = setKey(p.key);
        if (!acct && p.refreshToken) { acct = { email: p.email || '', uid: p.uid || '', refreshToken: p.refreshToken }; s = s.then(function () { return refresh(); }); }
        return s.then(function () { return { email: p.email }; });
      });
    });
  }
  function parseLink(text) {
    var m = /#link=([A-Za-z0-9_-]+)/.exec(String(text || '')); if (!m) return null;
    try { var o = JSON.parse(new TextDecoder().decode(Y.unb64u(m[1]))); return o && o.l && o.p ? { linkId: o.l, pub: o.p, name: String(o.n || 'another device').slice(0, 40) } : null; } catch (e) { return null; }
  }
  function approveLink(req) { // a SIGNED-IN device hands the account key (and sign-in) to the new device
    if (!meta.key || !acct) return Promise.reject(new Error('Sign in on this device first.'));
    return Y.sealHandoff(req.pub, { v: 1, key: meta.key, email: acct.email, uid: acct.uid, refreshToken: acct.refreshToken })
      .then(function (body) { return relay('PUT', '/v1/link?id=' + encodeURIComponent(req.linkId), null, new TextEncoder().encode(body)); });
  }

  /* ------------------------------------------------------------ account actions */
  function listDevices() { return relay('GET', '/v1/devices').then(function (r) { return { me: meta.deviceId, devices: r.devices || [] }; }); }
  function removeDevice(id) { return relay('DELETE', '/v1/devices?deviceId=' + encodeURIComponent(id)); }
  function signOut(wipe) {
    stop();
    var p = Promise.resolve();
    if (meta.deviceId && configured() && acct) p = relay('DELETE', '/v1/devices?deviceId=' + encodeURIComponent(meta.deviceId)).catch(function () { });
    return p.then(function () { return wipe ? S.wipe() : Promise.all([S.metaDel('acct'), S.metaDel('key'), S.metaDel('deviceId'), S.metaDel('lastSeq')]); })
      .then(function () { acct = null; meta.key = null; meta.deviceId = null; meta.lastSeq = 0; session = { idToken: '', exp: 0 }; emit('signedout', ''); });
  }
  function deleteAccount() { // wipes the relay's copy, the sign-in account itself, and everything on this device
    stop();
    return (configured() ? relay('DELETE', '/v1/account').catch(function (e) { if (!e.offline && !e.notConfigured) throw e; }) : Promise.resolve())
      .then(function () { return idToken(); })
      .then(function (tok) { return fbOp('delete', { idToken: tok }); })
      .then(function () { return S.wipe(); })
      .then(function () { acct = null; meta.key = null; meta.deviceId = null; session = { idToken: '', exp: 0 }; emit('signedout', 'Your account was deleted.'); });
  }

  window.RS_Net = {
    CFG: CFG, wire: wire, on: on, passwordProblem: passwordProblem, loadMeta: loadMeta, signUp: signUp, signIn: signIn, sendReset: sendReset,
    account: function () { return acct; }, hasKey: function () { return !!meta.key; }, setName: setName, deviceName: function () { return meta.name; }, deviceId: function () { return meta.deviceId; },
    start: start, stop: stop, syncNow: cycle, kickSoon: kickSoon, status: function () { return Object.assign({}, st); }, nowIso: nowIso,
    boost: boost, deviceKind: function () { return DEVICE_KIND; }, startLinkRequest: startLinkRequest, awaitLink: awaitLink, parseLink: parseLink, approveLink: approveLink,
    listDevices: listDevices, removeDevice: removeDevice, signOut: signOut, deleteAccount: deleteAccount, relayConfigured: configured
  };
})();
