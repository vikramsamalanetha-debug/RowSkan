/* RowSkan phone app - a product of LIT America (www.litamerica.net) */
(function () {
  'use strict';
  var C39 = window.LotCode39;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------- tiny storage helpers (localStorage may throw in private mode) ---------- */
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }

  var KEY = lsGet('rowskan.token', ''); // this phone's own secret key (issued when linked)
  var AUTO = lsGet('rowskan.auto', '1') === '1';
  var DEVICE = lsGet('rowskan.device', '');
  if (!DEVICE) { DEVICE = 'Phone-' + Math.random().toString(36).slice(2, 6).toUpperCase(); lsSet('rowskan.device', DEVICE); }

  // The QR link carries a one-time pairing code in the URL fragment (#p=...). Fragments are never sent over the network.
  function readHash() {
    var m = /[#&]p=([A-Za-z0-9-]{6,16})/.exec(location.hash || '');
    if (!m) return null;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    return m[1].toUpperCase();
  }
  var pendingCode = readHash();

  /* ---------- IndexedDB ---------- */
  var dbp = new Promise(function (res, rej) {
    var r = indexedDB.open('rowskan', 1);
    r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('vehicles', { keyPath: 'vin' }); d.createObjectStore('photos', { keyPath: 'id' }); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
  function tx(store, mode, fn) {
    return dbp.then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), s = t.objectStore(store), out, rq = fn(s);
        if (rq) rq.onsuccess = function () { out = rq.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  var getVeh = function (vin) { return tx('vehicles', 'readonly', function (s) { return s.get(vin); }); };
  var putVeh = function (v) { return tx('vehicles', 'readwrite', function (s) { return s.put(v); }); };
  var allVeh = function () { return tx('vehicles', 'readonly', function (s) { return s.getAll(); }); };
  var delVeh = function (vin) { return tx('vehicles', 'readwrite', function (s) { return s.delete(vin); }); };
  var getPhoto = function (id) { return tx('photos', 'readonly', function (s) { return s.get(id); }); };
  var putPhoto = function (p) { return tx('photos', 'readwrite', function (s) { return s.put(p); }); };
  var delPhoto = function (id) { return tx('photos', 'readwrite', function (s) { return s.delete(id); }); };

  /* ---------- UI helpers ---------- */
  var screens = ['sPair', 'sHome', 'sScan', 'sVeh', 'sSet'];
  function show(id) { screens.forEach(function (s) { $(s).classList.toggle('on', s === id); }); window.scrollTo(0, 0); }
  var toastT;
  function toast(t) { var e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(function () { e.classList.remove('show'); }, 2400); }
  function beep() {
    try { if (navigator.vibrate) navigator.vibrate(70); var A = window.AudioContext || window.webkitAudioContext; if (!A) return; var a = new A(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); setTimeout(function () { o.stop(); a.close(); }, 110); } catch (e) { /* ignore */ }
  }
  function rid() { var a = new Uint8Array(9); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return b.toString(36).padStart(2, '0'); }).join('').slice(0, 16); }
  function title(v) { var d = v.decoded || {}; return [d.year, d.make, d.model].filter(Boolean).join(' '); }

  /* ---------- camera ---------- */
  var stream = null;
  function stopCamera() { if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; } }
  function startCamera(video) {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('Camera needs a secure (https) connection'));
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(function (s) { stream = s; video.srcObject = s; return video.play().catch(function () { }); });
  }
  function frameToCanvas(video, maxW) {
    var w = video.videoWidth, h = video.videoHeight; if (!w || !h) return null;
    var k = Math.min(1, maxW / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c;
  }
  function grayOf(canvas) {
    var d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, n = canvas.width * canvas.height, g = new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return g;
  }

  /* ---------- VIN scanning ---------- */
  var detector = null, scanning = false, hits = { vin: null, n: 0 }, jsTick = 0, ignore = { vin: null, until: 0 };
  function initDetector() {
    if (detector !== null || !('BarcodeDetector' in window)) return Promise.resolve();
    return window.BarcodeDetector.getSupportedFormats().then(function (f) {
      var want = ['code_39', 'code_128', 'pdf417', 'data_matrix', 'qr_code'].filter(function (x) { return f.indexOf(x) >= 0; });
      detector = want.length ? new window.BarcodeDetector({ formats: want }) : false;
    }).catch(function () { detector = false; });
  }
  function openScan() {
    show('sScan'); hits = { vin: null, n: 0 }; $('vinIn').value = ''; vinInput();
    $('scanNote').hidden = true; $('torchBtn').hidden = true;
    initDetector().then(function () {
      $('scanPhotoBtn').hidden = false;
      return startCamera($('scanVideo'));
    }).then(function () {
      var tr = stream && stream.getVideoTracks()[0], caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
      $('torchBtn').hidden = !caps.torch;
      if (!detector) { $('scanNote').hidden = false; $('scanNote').textContent = 'Automatic reading works best on barcode stickers (Code 39). If it does not catch, tap “Pick a photo” or type the VIN.'; }
      scanning = true; scanLoop();
    }).catch(function (e) {
      $('scanNote').hidden = false;
      $('scanNote').textContent = 'Camera not available (' + (e && e.message || e) + '). You can still type the VIN or pick a photo.';
    });
  }
  function closeScan() { scanning = false; stopCamera(); }
  function scanLoop() {
    if (!scanning) return;
    var v = $('scanVideo'), p = Promise.resolve(null);
    if (v.readyState >= 2) {
      p = (detector ? detector.detect(v).then(function (codes) { return codes.map(function (c) { return c.rawValue; }).join(' '); }).catch(function () { return null; }) : Promise.resolve(null))
        .then(function (txt) {
          var vin = C39.extractVin(txt);
          if (vin) return { vin: vin, native: true };
          if (!detector || (++jsTick % 3 === 0)) { // built-in reader found nothing: try the JS Code 39 reader
            var c = frameToCanvas(v, 1280);
            if (c) { var s = C39.decodeImage(grayOf(c), c.width, c.height, { rows: 25, top: 0.25, bottom: 0.75 }); var vv = C39.extractVin(s); if (vv) return { vin: vv, native: false }; }
          }
          return null;
        });
    }
    p.then(function (r) {
      if (r && scanning) {
        if (r.vin === ignore.vin && Date.now() < ignore.until) { $('scanHint').textContent = 'That was the last vehicle — aim at the next one'; setTimeout(scanLoop, 250); return; }
        if (r.vin === hits.vin) hits.n++; else hits = { vin: r.vin, n: 1 };
        var sure = C39.vinCheckOk(r.vin) || r.native && hits.n >= 1 || hits.n >= 2;
        if (sure) { onVin(r.vin); return; }
        $('scanHint').textContent = 'Reading… hold steady';
      }
      setTimeout(scanLoop, 120);
    }).catch(function () { setTimeout(scanLoop, 200); });
  }
  function onVin(vin) { beep(); closeScan(); openVehicle(vin); }

  function vinInput() {
    var el = $('vinIn'), v = el.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); el.value = v;
    var msg = $('vinMsg'), ok = v.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
    if (!v) msg.textContent = '';
    else if (v.length < 17) msg.textContent = v.length + ' of 17 characters';
    else if (!ok) msg.textContent = 'VINs never contain the letters I, O or Q';
    else msg.textContent = C39.vinCheckOk(v) ? '✓ Valid VIN' : 'Check digit does not match — double-check, or continue if it is an older/foreign vehicle';
    $('vinGo').disabled = !ok;
  }
  $('vinIn').addEventListener('input', vinInput);
  $('vinGo').onclick = function () { closeScan(); openVehicle($('vinIn').value); };
  $('scanBack').onclick = function () { closeScan(); goHome(); };
  $('torchBtn').onclick = function () {
    var tr = stream && stream.getVideoTracks()[0]; if (!tr) return;
    var on = !$('torchBtn').dataset.on; $('torchBtn').dataset.on = on ? '1' : '';
    tr.applyConstraints({ advanced: [{ torch: on }] }).catch(function () { toast('Light not available'); });
  };
  $('scanPhotoBtn').onclick = function () { $('fileScan').value = ''; $('fileScan').click(); };
  $('fileScan').onchange = function () {
    var f = this.files && this.files[0]; if (!f) return;
    createImageBitmap(f).then(function (bmp) {
      var k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      var pr = detector ? detector.detect(c).then(function (cs) { return C39.extractVin(cs.map(function (x) { return x.rawValue; }).join(' ')); }).catch(function () { return null; }) : Promise.resolve(null);
      return pr.then(function (vin) {
        return vin || C39.extractVin(C39.decodeImage(grayOf(c), c.width, c.height, { rows: 61, top: 0.05, bottom: 0.95 }));
      });
    }).then(function (vin) {
      if (vin) { toast('VIN found'); onVin(vin); } else toast('No VIN barcode found in that photo — type it instead');
    }).catch(function () { toast('Could not read that photo'); });
  };

  /* ---------- VIN decode (NHTSA vPIC) ---------- */
  var NHTSA = { year: 'ModelYear', make: 'Make', model: 'Model', trim: 'Trim', series: 'Series', bodyClass: 'BodyClass', vehicleType: 'VehicleType', doors: 'Doors', driveType: 'DriveType', cylinders: 'EngineCylinders', displacementL: 'DisplacementL', engineHP: 'EngineHP', fuel: 'FuelTypePrimary', transmission: 'TransmissionStyle', plantCountry: 'PlantCountry', plantCity: 'PlantCity', gvwr: 'GVWR', manufacturer: 'Manufacturer', errorCode: 'ErrorCode', errorText: 'ErrorText' };
  function decodeVin(vin) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 9000);
    return fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + encodeURIComponent(vin) + '?format=json', { signal: ctl.signal })
      .then(function (r) { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var row = (j.Results || [])[0] || {}, d = {};
        Object.keys(NHTSA).forEach(function (k) { var x = row[NHTSA[k]]; if (x !== undefined && x !== null && String(x).trim() !== '') d[k] = String(x).trim(); });
        d.source = 'NHTSA vPIC'; d.decodedAt = new Date().toISOString();
        return d;
      });
  }

  /* ---------- current vehicle ---------- */
  var cur = null, urls = [];
  function openVehicle(vinRaw) {
    var vin = String(vinRaw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    getVeh(vin).then(function (v) {
      if (!v) v = { vin: vin, decoded: null, notes: '', lotLocation: '', capturedAt: new Date().toISOString(), done: false, dirty: true, photos: [], syncedAt: null };
      else { v.done = false; v.dirty = true; }
      cur = v; return putVeh(v);
    }).then(function () {
      show('sVeh'); renderVehicle(); startPhotoCamera();
      if (!(cur.decoded && cur.decoded.make)) decodeVin(vin).then(function (d) {
        if (!cur || cur.vin !== vin) return getVeh(vin).then(function (v) { if (v) { v.decoded = d; return putVeh(v); } });
        cur.decoded = d; return putVeh(cur).then(renderVehicle);
      }).catch(function () { if (cur && cur.vin === vin) renderVehicle(); });
    });
  }
  var camState = 'off'; // off | starting | ready | failed
  function startPhotoCamera() {
    $('photoHint').textContent = ''; camState = 'starting'; $('photoCam').hidden = false;
    startCamera($('photoVideo')).then(function () {
      camState = 'ready'; $('photoCam').hidden = false; $('shutter').disabled = false; $('pickBtn').hidden = false;
      $('photoHint').textContent = 'Walk around the vehicle — tap the button for each photo';
    }).catch(function () {
      camState = 'failed'; $('photoCam').hidden = true; $('shutter').disabled = false; $('pickBtn').hidden = false;
      toast('Live camera unavailable — using the phone camera app instead');
    });
  }
  function renderVehicle() {
    if (!cur) return;
    var d = cur.decoded;
    $('vehTitle').textContent = title(cur) || 'New vehicle';
    $('vehVin').textContent = cur.vin;
    var f = d ? [['Year', d.year], ['Make', d.make], ['Model', d.model], ['Trim', d.trim], ['Body', d.bodyClass], ['Drive', d.driveType], ['Engine', [d.cylinders && d.cylinders + ' cyl', d.displacementL && (+d.displacementL).toFixed(1) + 'L'].filter(Boolean).join(' ')], ['Fuel', d.fuel]].filter(function (x) { return x[1]; }) : [];
    $('vehDecoded').innerHTML = f.map(function (x) { return '<div><span>' + x[0] + '</span>' + esc(x[1]) + '</div>'; }).join('');
    var w = $('vehWarn'), msgs = [];
    if (!d) msgs.push('Looking up vehicle details… (if this phone is offline they are filled in automatically when you sync)');
    else if (!d.make) msgs.push('The VIN database found no match. Check the VIN: ' + (d.errorText || ''));
    if (!C39.vinCheckOk(cur.vin) && cur.vin.length === 17) msgs.push('VIN check digit does not match — double-check the number.');
    w.hidden = !msgs.length; w.textContent = msgs.join(' ');
    $('locIn').value = cur.lotLocation || ''; $('noteIn').value = cur.notes || '';
    renderStrip();
  }
  function renderStrip() {
    urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = [];
    var strip = $('strip'); strip.innerHTML = '';
    var live = cur.photos;
    $('photoCount').textContent = live.length + (live.length === 1 ? ' photo' : ' photos');
    live.forEach(function (p) {
      var box = document.createElement('div'); box.className = 'ph';
      var vinNow = cur.vin;
      function mark() {
        if (p.synced) { var ok = document.createElement('span'); ok.className = 'ok'; ok.textContent = '✓'; box.appendChild(ok); }
        else {
          var x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Delete photo');
          x.onclick = function () { cur.photos = cur.photos.filter(function (q) { return q.id !== p.id; }); cur.dirty = true; delPhoto(p.id); putVeh(cur).then(renderStrip); };
          box.appendChild(x);
        }
      }
      function showBlob(blob) { var u = URL.createObjectURL(blob); urls.push(u); box.innerHTML = '<img src="' + u + '" alt="">'; mark(); }
      getPhoto(p.id).then(function (rec) {
        if (rec && rec.blob) { showBlob(rec.blob); return; }
        box.innerHTML = '<div class="small" style="padding:10px 4px;text-align:center">on computer</div>'; mark();
        if (state === 'online') fetchPhoto(vinNow, p.id).then(function (b) { if (b && cur && cur.vin === vinNow) showBlob(b); }); // downloaded once, then kept on this phone
      });
      strip.appendChild(box);
    });
    strip.scrollLeft = strip.scrollWidth;
  }
  function savePhotoBlob(blob) {
    var id = rid(), veh = cur;
    if (!veh) return Promise.resolve();
    return putPhoto({ id: id, vin: veh.vin, blob: blob }).then(function () {
      veh.photos.push({ id: id, takenAt: new Date().toISOString(), synced: false }); veh.dirty = true; veh.done = false;
      return putVeh(veh);
    }).then(function () { if (cur === veh) renderStrip(); });
  }
  $('shutter').onclick = function () {
    var v = $('photoVideo');
    if (camState === 'starting' || (camState === 'ready' && v.readyState < 2)) { toast('Camera starting…'); return; }
    if (camState === 'ready' && stream) {
      var c = frameToCanvas(v, 1920); if (!c) return;
      c.toBlob(function (b) { if (b) { beep(); savePhotoBlob(b); } }, 'image/jpeg', 0.85);
    } else { $('fileIn').value = ''; $('fileIn').click(); }
  };
  $('pickBtn').onclick = function () { $('fileIn').value = ''; $('fileIn').click(); };
  $('fileIn').onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    files.reduce(function (p, f) {
      return p.then(function () {
        return createImageBitmap(f).then(function (bmp) {
          var k = Math.min(1, 1920 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
          c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          return new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.85); });
        }).then(function (b) { return b && savePhotoBlob(b); });
      });
    }, Promise.resolve()).catch(function () { toast('Could not add that photo'); });
  };
  function saveText() { if (cur) { cur.lotLocation = $('locIn').value.trim(); cur.notes = $('noteIn').value.trim(); cur.dirty = true; return putVeh(cur); } return Promise.resolve(); }
  $('vehDone').onclick = function () {
    if (!cur.photos.length && !confirm('No photos taken for this vehicle. Continue anyway?')) return;
    saveText().then(function () {
      cur.done = true; cur.dirty = true; return putVeh(cur);
    }).then(function () { stopCamera(); toast('Saved ' + cur.vin.slice(-6)); ignore = { vin: cur.vin, until: Date.now() + 20000 }; cur = null; refreshHome(); if (AUTO) syncSoon(); openScan(); });
  };
  $('vehBack').onclick = function () { saveText().then(function () { stopCamera(); if (cur.photos.length) { cur.done = true; cur.dirty = true; } return putVeh(cur); }).then(function () { cur = null; goHome(); if (AUTO) syncSoon(); }); };
  $('vehDel').onclick = function () {
    var anySynced = cur.photos.some(function (p) { return p.synced; });
    if (anySynced) { toast('Already on the computer — delete it there'); return; }
    if (!confirm('Discard this vehicle and its photos from the phone?')) return;
    Promise.all(cur.photos.map(function (p) { return delPhoto(p.id); })).then(function () { return delVeh(cur.vin); }).then(function () { stopCamera(); cur = null; goHome(); });
  };

  /* ---------- home ---------- */
  var thumbUrls = [], thumbChain = Promise.resolve();
  function refreshHome() {
    return allVeh().then(function (list) {
      list.sort(function (a, b) { return String(b.capturedAt).localeCompare(String(a.capturedAt)); });
      var wrap = $('list'); wrap.innerHTML = '';
      thumbUrls.forEach(function (u) { URL.revokeObjectURL(u); }); thumbUrls = [];
      list.forEach(function (v) {
        var b = document.createElement('button'); b.className = 'vcard card';
        var status = !v.done ? ['Capturing', 'wait'] : v.dirty ? ['Waiting to sync', 'wait'] : ['Synced ✓', 'ok'];
        b.innerHTML = '<img class="th" alt=""><div class="t"><b>' + esc(title(v) || 'Details pending') + '</b><span class="small mono">' + esc(v.vin) + '</span><div class="small">' + v.photos.length + ' photos</div></div><span class="chip ' + status[1] + '">' + status[0] + '</span>';
        var first = v.photos[0];
        if (first) getPhoto(first.id).then(function (r) {
          function put(blob) { var u = URL.createObjectURL(blob); thumbUrls.push(u); b.querySelector('img').src = u; }
          if (r && r.blob) put(r.blob);
          else if (state === 'online') thumbChain = thumbChain.then(function () { return fetchPhoto(v.vin, first.id); }).then(function (blob) { if (blob) put(blob); });
        });
        b.onclick = function () { openVehicle(v.vin); };
        wrap.appendChild(b);
      });
      $('emptyMsg').hidden = list.length > 0;
      var pend = list.filter(function (v) { return v.done && v.dirty; }).length;
      $('pendTxt').textContent = pend ? pend + (pend === 1 ? ' vehicle' : ' vehicles') + ' waiting to sync' : (list.length ? 'Everything is synced' : 'Nothing waiting');
      $('syncNow').disabled = !pend || syncing;
      return pend;
    });
  }
  function goHome() { closeScan(); stopCamera(); if (!KEY) { showPair(); return; } show('sHome'); refreshHome(); renderConn(); }
  $('newVeh').onclick = openScan;

  /* ---------- connection + sync ---------- */
  var state = 'checking', compName = '', syncing = false, syncT = null, acct = lsGet('rowskan.acct', '');
  function renderConn() {
    var dot = $('connDot'), txt = $('connTxt');
    dot.className = 'dot' + (state === 'online' ? ' on' : state === 'badkey' ? ' bad' : '');
    txt.textContent = state === 'online' ? (compName || 'Connected') : state === 'badkey' ? 'Wrong key' : state === 'checking' ? 'Checking…' : 'Not on computer’s WiFi';
    if (!syncing) $('syncMsg').textContent = state === 'online' ? 'Connected to ' + (compName || 'computer') : state === 'badkey' ? 'Access key not accepted' : 'Photos stay on the phone until you are on the same WiFi as the computer';
  }
  function checkServer() {
    if (!KEY) return Promise.resolve();
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, 4000);
    return fetch('/api/auth-check', { headers: { 'x-rowskan-token': KEY }, cache: 'no-store', signal: ctl.signal })
      .then(function (r) {
        clearTimeout(t);
        if (r.status === 401) { state = 'badkey'; unlinked(); return; }
        if (!r.ok) { state = 'offline'; return; }
        return r.json().then(function (j) { state = 'online'; compName = j.name || ''; acct = j.account || ''; lsSet('rowskan.acct', acct); });
      }).catch(function () { clearTimeout(t); state = 'offline'; })
      .then(function () { renderConn(); if (state === 'online') afterOnline(); });
  }
  function syncSoon() { clearTimeout(syncT); syncT = setTimeout(function () { syncAll(false); }, 400); }
  function authFetch(path, opts) {
    opts = opts || {}; opts.headers = Object.assign({ 'x-rowskan-token': KEY }, opts.headers || {}); opts.cache = 'no-store';
    return fetch(path, opts);
  }
  function syncAll(manual) {
    if (syncing) return Promise.resolve();
    syncing = true; $('syncNow').disabled = true;
    var done = 0, total = 0;
    return allVeh().then(function (list) {
      var todo = list.filter(function (v) { return v.done && v.dirty; });
      if (!todo.length) { if (manual) toast('Nothing to sync'); return; }
      todo.forEach(function (v) { total += v.photos.filter(function (p) { return !p.synced; }).length; });
      $('prog').hidden = false; $('prog').max = Math.max(total, 1); $('prog').value = 0;
      return todo.reduce(function (p, v) { return p.then(function () { return syncVehicle(v, function () { done++; $('prog').value = done; $('syncMsg').textContent = 'Sending photos ' + done + ' of ' + total + '…'; }); }); }, Promise.resolve())
        .then(function () { toast(todo.length + (todo.length === 1 ? ' vehicle' : ' vehicles') + ' synced'); });
    }).catch(function (e) {
      if (e && e.status === 401) { state = 'badkey'; } else if (!e || !e.status) { state = 'offline'; }
      if (manual || (e && e.status && e.status !== 401)) toast('Sync stopped: ' + (e && e.message || 'connection lost') + ' — will retry');
    }).then(function () { syncing = false; $('prog').hidden = true; renderConn(); return pullAll().catch(function () { }).then(refreshHome); });
  }
  function httpErr(r, what) { return r.json().catch(function () { return {}; }).then(function (j) { var e = new Error((j && j.error) || what + ' failed (' + r.status + ')'); e.status = r.status; throw e; }); }
  function syncVehicle(v, tick) {
    var payload = { vin: v.vin, decoded: v.decoded, notes: v.notes, lotLocation: v.lotLocation, capturedAt: v.capturedAt, device: DEVICE, photos: v.photos.map(function (p) { return { id: p.id, takenAt: p.takenAt }; }) };
    return authFetch('/api/sync/vehicle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.ok ? r.json() : httpErr(r, 'Vehicle sync'); })
      .then(function (res) {
        var missing = {}; (res.missingPhotos || []).forEach(function (id) { missing[id] = 1; });
        // photos the server already has (e.g. an earlier attempt got through) just get marked synced
        v.photos.forEach(function (p) { if (!missing[p.id] && !p.synced) { p.synced = true; tick(); } });
        return v.photos.filter(function (p) { return missing[p.id]; }).reduce(function (chain, p) {
          return chain.then(function () {
            return getPhoto(p.id).then(function (rec) {
              if (!rec || !rec.blob) { p.synced = true; tick(); return; }
              return authFetch('/api/sync/photo/' + v.vin + '/' + p.id, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: rec.blob })
                .then(function (r) { if (!r.ok) return httpErr(r, 'Photo upload'); p.synced = true; tick(); return getVeh(v.vin).then(function (fresh) { /* keep concurrent edits */ if (fresh) { fresh.photos.forEach(function (q) { if (q.id === p.id) q.synced = true; }); return putVeh(fresh); } }); });
            });
          });
        }, Promise.resolve());
      })
      .then(function () { return getVeh(v.vin); })
      .then(function (fresh) {
        if (!fresh) return;
        v.photos.forEach(function (p) { if (p.synced) fresh.photos.forEach(function (q) { if (q.id === p.id) q.synced = true; }); });
        var allSent = fresh.photos.every(function (p) { return p.synced; });
        if (allSent && fresh.done) { fresh.dirty = false; fresh.syncedAt = new Date().toISOString(); }
        return putVeh(fresh);
      });
  }
  $('syncNow').onclick = function () { checkServer().then(function () { if (state === 'online') syncAll(true); else toast(state === 'badkey' ? 'Access key not accepted' : 'Not connected to the computer'); }); };
  $('connPill').onclick = function () { openSettings(); };

  /* ---------- settings / pairing ---------- */
  function openSettings() {
    show('sSet'); $('autoSync').checked = AUTO; $('setComputer').textContent = (acct ? 'Account ' + acct + ' · ' : '') + (compName ? compName + ' · ' : '') + location.host;
    allVeh().then(function (l) {
      var n = 0, sy = 0; l.forEach(function (v) { v.photos.forEach(function (p) { n++; if (p.synced) sy++; }); });
      $('setStore').textContent = l.length + ' vehicles · ' + n + ' photos (' + sy + ' already on the computer)';
    });
  }
  $('setBack').onclick = goHome;
  $('autoSync').onchange = function () { AUTO = this.checked; lsSet('rowskan.auto', AUTO ? '1' : '0'); if (AUTO) syncSoon(); };
  $('clearSynced').onclick = function () {
    allVeh().then(function (l) {
      var ids = []; l.forEach(function (v) { v.photos.forEach(function (p) { if (p.synced) ids.push(p.id); }); });
      return Promise.all(ids.map(delPhoto)).then(function () { toast('Freed ' + ids.length + ' photos'); openSettings(); });
    });
  };
  function showPair(msg) {
    closeScan(); stopCamera(); show('sPair');
    $('devName').value = lsGet('rowskan.device', '') || DEVICE;
    $('unlinkedMsg').hidden = !msg; if (msg) $('unlinkedMsg').textContent = msg;
  }
  function unlinked() { // the computer removed this phone (or the key was wiped): keep local data, ask to link again
    lsDel('rowskan.token'); KEY = ''; compName = '';
    var cur = document.querySelector('.screen.on');
    if (cur && (cur.id === 'sHome' || cur.id === 'sSet' || cur.id === 'sPair')) showPair('This phone was unlinked from the computer. Your photos are still on this phone — link it again to keep syncing.');
    else toast('Unlinked from the computer — finish this vehicle, then link again');
  }
  $('unpair').onclick = function () {
    if (!confirm('Unlink this phone? It keeps its photos, but stops syncing until you link it again.')) return;
    var k = KEY;
    fetch('/api/unlink', { method: 'POST', headers: { 'x-rowskan-token': k } }).catch(function () { }).then(function () { lsDel('rowskan.token'); KEY = ''; state = 'checking'; showPair(); });
  };
  function pairWithCode(code, name) {
    return fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code, name: name || DEVICE }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Could not link (' + r.status + ')'); return j; }); })
      .then(function (j) { KEY = j.token; lsSet('rowskan.token', KEY); compName = j.computerName || ''; state = 'online'; });
  }
  $('keyIn').addEventListener('input', function () {
    var v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); this.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
  });
  $('keyGo').onclick = function () {
    var code = $('keyIn').value.replace(/[^A-Za-z0-9]/g, ''); if (code.length < 6) { $('keyErr').hidden = false; $('keyErr').textContent = 'Type the 8-character code shown on the computer.'; return; }
    var name = $('devName').value.trim() || DEVICE; lsSet('rowskan.device', name); DEVICE = name;
    $('keyErr').hidden = true; $('keyGo').disabled = true;
    pairWithCode(code, name).then(function () { $('keyGo').disabled = false; start(); })
      .catch(function (e) { $('keyGo').disabled = false; $('keyErr').hidden = false; $('keyErr').textContent = /fetch|Failed|network/i.test(e.message) ? 'Computer not reachable. Are you on the same WiFi?' : e.message; });
  };

  /* ---------- keep a full copy of the computer's inventory on this phone ---------- */
  var pulling = false;
  function fetchPhoto(vin, id) {
    return authFetch('/api/photo/' + vin + '/' + id).then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) { return b ? putPhoto({ id: id, vin: vin, blob: b }).then(function () { return b; }) : null; }).catch(function () { return null; });
  }
  function pullAll() {
    if (pulling || syncing || state !== 'online' || !KEY) return Promise.resolve();
    pulling = true;
    return authFetch('/api/vehicles').then(function (r) { if (!r.ok) throw new Error('pull ' + r.status); return r.json(); })
      .then(function (list) {
        return allVeh().then(function (local) {
          var byVin = {}, ops = [], onPc = {};
          local.forEach(function (v) { byVin[v.vin] = v; });
          list.forEach(function (sv) {
            onPc[sv.vin] = 1;
            var lv = byVin[sv.vin];
            if (lv && (lv.dirty || !lv.done)) return;          // unsent changes on the phone win until they are sent
            if (cur && cur.vin === sv.vin) return;              // being edited right now
            var photos = (sv.photos || []).filter(function (p) { return !p.pending; }).map(function (p) { return { id: p.id, takenAt: p.takenAt, synced: true }; });
            ops.push(putVeh({ vin: sv.vin, decoded: sv.decoded || null, notes: sv.notes || '', lotLocation: sv.lotLocation || '', capturedAt: sv.capturedAt || sv.createdAt, done: true, dirty: false, photos: photos, syncedAt: sv.syncedAt || null }));
          });
          local.forEach(function (lv) { // deleted on the computer -> removed here too (never touches unsent work)
            if (!onPc[lv.vin] && lv.done && !lv.dirty && !(cur && cur.vin === lv.vin)) ops.push(Promise.all(lv.photos.map(function (p) { return delPhoto(p.id); })).then(function () { return delVeh(lv.vin); }));
          });
          return Promise.all(ops);
        });
      }).then(function () { pulling = false; }, function (e) { pulling = false; throw e; });
  }
  function afterOnline() {
    var p = AUTO ? syncAll(false) : Promise.resolve();
    return p.then(function () { return pullAll(); }).catch(function () { }).then(function () { if ($('sHome').classList.contains('on')) refreshHome(); });
  }

  /* ---------- start ---------- */
  function start() {
    if (pendingCode) {
      var code = pendingCode; pendingCode = null;
      pairWithCode(code, DEVICE).then(start).catch(function (e) { showPair(e.message); });
      return;
    }
    if (!KEY) { showPair(); return; }
    goHome(); checkServer();
  }
  window.addEventListener('hashchange', function () { var c = readHash(); if (c) { pendingCode = c; state = 'checking'; start(); } }); // QR link opened while the app is already open
  window.addEventListener('online', checkServer);
  window.addEventListener('offline', function () { state = 'offline'; renderConn(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && KEY) checkServer(); });
  setInterval(function () { if (!document.hidden && KEY && !syncing) checkServer(); }, 10000);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* e.g. untrusted certificate: app still works while online */ });
  dbp.then(start).catch(function () { document.body.innerHTML = '<p style="padding:20px">This browser blocked on-phone storage (private mode?). Open RowSkan in a normal tab.</p>'; });

  // exposed for automated tests only
  window.__rowskan = { openVehicle: openVehicle, syncAll: syncAll, allVeh: allVeh };
})();
