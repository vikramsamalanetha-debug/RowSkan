/*
 * RowSkan sync over Firebase Firestore (no server of our own). A product of LIT America (www.litamerica.net).
 *
 * Gives the app the same small "relay" interface (devices, mailboxes, attachments, link hand-off) but keeps the
 * encrypted mailboxes in the user's own Firebase project. Everything stored is ciphertext (see sync.js); the security
 * rules (firestore.rules) only let a signed-in user touch their own mailboxes.
 *
 *   users/{uid}/devices/{deviceId}                    name, kind, addedAt
 *   users/{uid}/devices/{deviceId}/inbox/{messageId}  from, kind, payload(ciphertext), blobs[], ts(server time), expireAt
 *   users/{uid}/blobs/{blobId}                        from, refs[] (devices still to collect it), total, size, expireAt
 *   users/{uid}/blobs/{blobId}/c/{000..}              data (ciphertext chunk)
 *   links/{linkId}                                    body (sealed hand-off for a new device), ts, expireAt
 *
 * Delivered messages and attachments are deleted by the receiving device (and expire after 30 days).
 */
(function (root) {
  'use strict';
  var MAX_DEV = 10, CHUNK = 600 * 1024, MAX_BLOB = 8 * 1024 * 1024, MAX_MSG = 800000, TTL_MS = 30 * 86400000, LINK_TTL = 300000, LINK_MAX = 30000;
  var ID_RE = /^[A-Za-z0-9_-]{8,64}$/, LINK_RE = /^[A-Za-z0-9_-]{22,64}$/;

  function b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { var b = atob(s), o = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }
  function hex(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function S(v) { return { stringValue: String(v) }; } function I(n) { return { integerValue: String(n) }; }
  function A(a) { return { arrayValue: { values: (a || []).map(S) } }; } function T(ms) { return { timestampValue: new Date(ms).toISOString() }; }
  function gs(f, k) { return f && f[k] && f[k].stringValue !== undefined ? f[k].stringValue : ''; }
  function gi(f, k) { return f && f[k] && f[k].integerValue !== undefined ? parseInt(f[k].integerValue, 10) : 0; }
  function ga(f, k) { var v = f && f[k] && f[k].arrayValue && f[k].arrayValue.values; return (v || []).map(function (x) { return x.stringValue; }); }
  function tsMicro(s) { var m = /^(.*?)(?:\.(\d+))?Z$/.exec(String(s || '')); if (!m) return 0; return Math.floor(Date.parse(m[1] + 'Z') / 1000) * 1000000 + parseInt(((m[2] || '') + '000000').slice(0, 6), 10); }
  function microTs(u) { var sec = Math.floor(u / 1000000), frac = ('000000' + (u % 1000000)).slice(-6); return new Date(sec * 1000).toISOString().replace(/\.\d+Z$/, '.' + frac + 'Z'); }
  function lastSeg(name) { return String(name).split('/').pop(); }
  function fail(status, msg) { var e = new Error(msg); e.status = status; return e; }

  function make(cfg) {
    var base = String(cfg.base || 'https://firestore.googleapis.com').replace(/\/+$/, '') + '/v1/projects/' + cfg.project + '/databases/(default)/documents';
    var rootName = 'projects/' + cfg.project + '/databases/(default)/documents/';
    var cache = {}; // device -> messages handed out by the last inbox read (so an acknowledgement needs no second read)
    var uid = function () { return cfg.uid(); };
    function http(method, url, body, signedIn) {
      return (signedIn === false ? Promise.resolve('') : cfg.token()).then(function (tok) {
        var h = {}; if (tok) h.Authorization = 'Bearer ' + tok; if (body) h['Content-Type'] = 'application/json';
        return fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      }).catch(function (e) { if (e && e.status !== undefined) throw e; var er = new Error(e && e.message || 'offline'); er.offline = true; er.cause = e; throw er; })
        .then(function (r) {
          if (r.ok) return r.json().catch(function () { return {}; });
          return r.json().catch(function () { return {}; }).then(function (j) {
            var m = (j && j.error && j.error.message) || '', e;
            if (r.status === 403 || (j && j.error && j.error.status === 'PERMISSION_DENIED')) e = fail(403, 'Sync is not switched on for this Firebase project yet (database rules missing).');
            else if (r.status === 401) e = fail(401, 'Sign in again.');
            else if (r.status === 429) e = fail(429, 'Sync limit reached for today. It will resume automatically.');
            else e = fail(r.status, m || 'Sync problem (' + r.status + ')');
            throw e;
          });
        });
    }
    var getDoc = function (path) { return http('GET', base + '/' + path).catch(function (e) { if (e.status === 404) return null; throw e; }); };
    function listDocs(path) {
      var out = [];
      return (function page(tok) {
        return http('GET', base + '/' + path + '?pageSize=100' + (tok ? '&pageToken=' + encodeURIComponent(tok) : '')).then(function (r) {
          (r.documents || []).forEach(function (d) { out.push(d); }); if (r.nextPageToken) return page(r.nextPageToken);
        });
      })('').then(function () { return out; });
    }
    function commit(writes) { var p = Promise.resolve(); for (var i = 0; i < writes.length; i += 400) (function (part) { p = p.then(function () { return http('POST', base + ':commit', { writes: part }); }); })(writes.slice(i, i + 400)); return p; }
    function query(parent, sq) { return http('POST', base + (parent ? '/' + parent : '') + ':runQuery', { structuredQuery: sq }).then(function (rows) { return (rows || []).filter(function (r) { return r.document; }).map(function (r) { return r.document; }); }); }
    var devPath = function (id) { return 'users/' + uid() + '/devices/' + id; };
    var del = function (name) { return { delete: name }; };
    var nameOf = function (path) { return rootName + path; };

    function devices() { return listDocs('users/' + uid() + '/devices').then(function (docs) { return docs.map(function (d) { var f = d.fields || {}; return { deviceId: lastSeg(d.name), name: gs(f, 'name'), kind: gs(f, 'kind'), pub: '', addedAt: gi(f, 'addedAt') }; }); }); }
    function dropBlobIfDone(bid) {
      return getDoc('users/' + uid() + '/blobs/' + bid).then(function (m) {
        if (!m || ga(m.fields, 'refs').length) return;
        return listDocs('users/' + uid() + '/blobs/' + bid + '/c').then(function (cs) { return commit(cs.map(function (c) { return del(c.name); }).concat([del(m.name)])); });
      });
    }
    function release(dev, bids) { // this device has stored these attachments: stop waiting for it; the last one out deletes them
      var ids = Array.from(new Set(bids || []));
      return ids.reduce(function (p, bid) {
        return p.then(function () {
          return commit([{ update: { name: nameOf('users/' + uid() + '/blobs/' + bid) }, updateMask: { fieldPaths: [] }, currentDocument: { exists: true }, updateTransforms: [{ fieldPath: 'refs', removeAllFromArray: { values: [S(dev)] } }] }])
            .then(function () { return dropBlobIfDone(bid); }, function (e) { if (e.status === 404 || e.status === 400) return; throw e; });
        });
      }, Promise.resolve());
    }
    function inboxDocs(dev) { return listDocs(devPath(dev) + '/inbox'); }
    function removeDevice(dev) {
      return getDoc(devPath(dev)).then(function (d) {
        if (!d) throw fail(404, 'Unknown device.');
        return inboxDocs(dev).then(function (msgs) {
          var bids = []; msgs.forEach(function (m) { bids = bids.concat(ga(m.fields, 'blobs')); });
          return commit(msgs.map(function (m) { return del(m.name); }).concat([del(d.name)])).then(function () { delete cache[dev]; return release(dev, bids); });
        });
      });
    }
    function bytesOf(raw) { return raw instanceof Uint8Array ? raw : new Uint8Array(raw); }

    function call(method, pathq, body, raw) {
      var qi = pathq.indexOf('?'), path = qi < 0 ? pathq : pathq.slice(0, qi), q = new URLSearchParams(qi < 0 ? '' : pathq.slice(qi + 1)), key = method + ' ' + path;
      try {
        if (key === 'POST /v1/devices') {
          var id = body.deviceId; if (!ID_RE.test(id || '')) return Promise.reject(fail(400, 'Invalid deviceId.'));
          return Promise.all([getDoc(devPath(id)), devices()]).then(function (r) {
            if (!r[0] && r[1].length >= MAX_DEV) throw fail(409, 'This account already has ' + MAX_DEV + ' devices. Remove one first.');
            var kind = ['phone', 'web', 'windows', 'other'].indexOf(body.kind) >= 0 ? body.kind : 'other';
            return commit([{ update: { name: nameOf(devPath(id)), fields: { name: S(String(body.name || '').slice(0, 60)), kind: S(kind), addedAt: I(r[0] ? gi(r[0].fields, 'addedAt') : Date.now()) } } }]);
          }).then(function () { return { ok: true }; });
        }
        if (key === 'GET /v1/devices') return devices().then(function (l) { return { devices: l }; });
        if (key === 'DELETE /v1/devices') return removeDevice(q.get('deviceId')).then(function () { return { ok: true }; });
        if (key === 'POST /v1/send') {
          var from = body.from;
          return devices().then(function (list) {
            var ids = list.map(function (d) { return d.deviceId; });
            if (ids.indexOf(from) < 0) throw fail(404, 'Unknown sending device.');
            var kind = ['change', 'ctl'].indexOf(body.kind) >= 0 ? body.kind : null; if (!kind) throw fail(400, 'Bad kind.');
            if (typeof body.payload !== 'string' || !body.payload || body.payload.length > MAX_MSG) throw fail(413, 'Message too large.');
            var to = (Array.isArray(body.to) && body.to.length ? body.to : ids).filter(function (d) { return d !== from; });
            if (!to.every(function (d) { return ids.indexOf(d) >= 0; })) throw fail(404, 'Unknown receiving device.');
            if (!to.length) return { ok: true, delivered_to: 0 };
            var id = hex(12), blobs = (Array.isArray(body.blobs) ? body.blobs : []).slice(0, 50);
            return commit(to.map(function (d) { return { update: { name: nameOf(devPath(d) + '/inbox/' + id), fields: { from: S(from), kind: S(kind), payload: S(body.payload), blobs: A(blobs), expireAt: T(Date.now() + TTL_MS) } }, updateTransforms: [{ fieldPath: 'ts', setToServerValue: 'REQUEST_TIME' }] }; }))
              .then(function () { return { ok: true, id: id, delivered_to: to.length }; });
          });
        }
        if (key === 'GET /v1/inbox') {
          var dev = q.get('device'), after = +(q.get('after') || 0), limit = Math.min(200, +(q.get('limit') || 100));
          return query(devPath(dev), { from: [{ collectionId: 'inbox' }], where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'GREATER_THAN', value: { timestampValue: microTs(after) } } }, orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }], limit: limit + 1 })
            .then(function (docs) {
              var more = docs.length > limit; docs = docs.slice(0, limit);
              var msgs = docs.map(function (d) { var f = d.fields || {}; return { seq: tsMicro(f.ts && f.ts.timestampValue), id: lastSeg(d.name), from: gs(f, 'from'), kind: gs(f, 'kind'), payload: gs(f, 'payload'), blobs: ga(f, 'blobs'), ts: Date.parse((f.ts && f.ts.timestampValue) || 0) || 0, _name: d.name }; });
              cache[dev] = msgs.map(function (m) { return { name: m._name, seq: m.seq, blobs: m.blobs }; });
              return { messages: msgs.map(function (m) { delete m._name; return m; }), more: more };
            });
        }
        if (key === 'POST /v1/ack') {
          var dv = body.device, upTo = +body.upTo, known = (cache[dv] || []).filter(function (m) { return m.seq <= upTo; });
          var got = known.length ? Promise.resolve(known) : query(devPath(dv), { from: [{ collectionId: 'inbox' }], where: { fieldFilter: { field: { fieldPath: 'ts' }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: microTs(upTo) } } }, orderBy: [{ field: { fieldPath: 'ts' }, direction: 'ASCENDING' }], limit: 200 })
            .then(function (docs) { return docs.map(function (d) { return { name: d.name, seq: 0, blobs: ga(d.fields, 'blobs') }; }); });
          return got.then(function (items) {
            var bids = []; items.forEach(function (m) { bids = bids.concat(m.blobs); });
            return commit(items.map(function (m) { return del(m.name); })).then(function () { cache[dv] = (cache[dv] || []).filter(function (m) { return m.seq > upTo; }); return release(dv, bids); }).then(function () { return { ok: true, deleted: items.length }; });
          });
        }
        if (key === 'PUT /v1/blob') {
          var bid = q.get('id'), bfrom = q.get('from'), bto = (q.get('to') || '').split(',').filter(Boolean), bytes = bytesOf(raw);
          if (!ID_RE.test(bid || '')) return Promise.reject(fail(400, 'Invalid blob id.'));
          if (bytes.length > MAX_BLOB) return Promise.reject(fail(413, 'Photo too large.'));
          return devices().then(function (list) {
            var ids = list.map(function (d) { return d.deviceId; });
            if (ids.indexOf(bfrom) < 0) throw fail(404, 'Unknown sending device.');
            var targets = (bto.length ? bto : ids).filter(function (d) { return d !== bfrom; });
            if (!targets.length || !targets.every(function (d) { return ids.indexOf(d) >= 0; })) throw fail(404, 'Unknown receiving device.');
            var n = Math.max(1, Math.ceil(bytes.length / CHUNK)), exp = Date.now() + TTL_MS, w = [{ update: { name: nameOf('users/' + uid() + '/blobs/' + bid), fields: { from: S(bfrom), refs: A(targets), total: I(n), size: I(bytes.length), expireAt: T(exp) } }, currentDocument: { exists: false } }];
            for (var i = 0; i < n; i++) w.push({ update: { name: nameOf('users/' + uid() + '/blobs/' + bid + '/c/' + ('000' + i).slice(-3)), fields: { n: I(i), data: { bytesValue: b64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) }, expireAt: T(exp) } } });
            return commit(w).catch(function (e) { if (e.status === 409 || e.status === 400) throw fail(409, 'That attachment id is already used.'); throw e; });
          }).then(function () { return { ok: true, id: bid }; });
        }
        if (key === 'GET /v1/blob') {
          var gid = q.get('id'), gdev = q.get('device');
          return getDoc('users/' + uid() + '/blobs/' + gid).then(function (m) {
            if (!m || ga(m.fields, 'refs').indexOf(gdev) < 0) throw fail(404, 'No such attachment for this device.');
            return listDocs('users/' + uid() + '/blobs/' + gid + '/c').then(function (cs) {
              cs.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
              var parts = cs.map(function (c) { return unb64(c.fields.data.bytesValue || ''); }), len = 0; parts.forEach(function (p) { len += p.length; });
              if (cs.length !== gi(m.fields, 'total')) throw fail(404, 'No such attachment for this device.');
              var out = new Uint8Array(len), o = 0; parts.forEach(function (p) { out.set(p, o); o += p.length; }); return out;
            });
          });
        }
        if (key === 'DELETE /v1/account') {
          return devices().then(function (list) { return list.reduce(function (p, d) { return p.then(function () { return removeDevice(d.deviceId).catch(function (e) { if (e.status !== 404) throw e; }); }); }, Promise.resolve()); })
            .then(function () { return listDocs('users/' + uid() + '/blobs'); })
            .then(function (bl) { return bl.reduce(function (p, b) { return p.then(function () { return listDocs('users/' + uid() + '/blobs/' + lastSeg(b.name) + '/c').then(function (cs) { return commit(cs.map(function (c) { return del(c.name); }).concat([del(b.name)])); }); }); }, Promise.resolve()); })
            .then(function () { return { ok: true }; });
        }
        if (key === 'PUT /v1/link') return linkPut(q.get('id'), raw).then(function () { return { ok: true }; });
        return Promise.reject(fail(404, 'Not found.'));
      } catch (e) { return Promise.reject(e); }
    }

    // ---- link hand-off for a brand-new device (QR): the signed-in device writes, the new device reads once ----
    function linkPut(id, raw) {
      if (!LINK_RE.test(id || '')) return Promise.reject(fail(400, 'Invalid link id.'));
      var text = new TextDecoder().decode(bytesOf(raw)); if (text.length > LINK_MAX) return Promise.reject(fail(413, 'Too large.'));
      return commit([{ update: { name: nameOf('links/' + id), fields: { body: S(text), ts: I(Date.now()), expireAt: T(Date.now() + 2 * LINK_TTL) } }, currentDocument: { exists: false } }])
        .catch(function (e) { if (e.status === 409 || e.status === 400) throw fail(409, 'This code was already used.'); throw e; });
    }
    function linkGet(id) { // no sign-in needed: knowing the random id is the proof; it is read once and deleted
      if (!LINK_RE.test(id || '')) return Promise.resolve(null);
      return http('GET', base + '/links/' + id, null, false).then(function (d) {
        var fresh = Date.now() - gi(d.fields, 'ts') < LINK_TTL, text = gs(d.fields, 'body');
        return http('DELETE', base + '/links/' + id, null, false).catch(function () { }).then(function () { return fresh ? text : null; });
      }, function (e) { if (e.status === 404 || e.status === 403) return null; throw e; });
    }
    return { call: call, linkGet: linkGet };
  }
  root.RS_Fs = { make: make };
})(window);
