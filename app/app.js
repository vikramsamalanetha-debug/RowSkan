/* RowSkan app (web, Android, iPhone, Windows) - a product of LIT America (www.litamerica.net) */
(function () {
  'use strict';
  const C39 = window.LotCode39, S = window.RS_Store, Net = window.RS_Net, Y = window.RowSkanSync, CFG = Net.CFG;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = (v) => { const d = v.decoded || {}; return [d.year, d.make, d.model].filter(Boolean).join(' '); };
  const rid = () => { const a = new Uint8Array(9); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16); };
  const wire = (v) => Net.wire(v);

  /* ---------------------------------------------------------------- UI helpers */
  const screens = ['sAuth', 'sLink', 'sHome', 'sScan', 'sVeh', 'sSet', 'sApprove'];
  let current = '';
  function show(id) { current = id; screens.forEach((s) => $(s).classList.toggle('on', s === id)); window.scrollTo(0, 0); }
  let toastT;
  function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), 2600); }
  function beep() { try { if (navigator.vibrate) navigator.vibrate(70); const A = window.AudioContext || window.webkitAudioContext; if (!A) return; const a = new A(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); setTimeout(() => { o.stop(); a.close(); }, 110); } catch (e) { /* ignore */ } }
  const showErr = (el, msg) => { el.hidden = !msg; el.textContent = msg || ''; };

  /* ---------------------------------------------------------------- local records */
  // Every change stamps the edited fields with the time, so two devices editing different fields never overwrite each other.
  function commit(v, fields) { // save a vehicle from the screen: merge with whatever the sync engine wrote meanwhile
    if (fields) Y.stamp(v, fields, Net.nowIso());
    v.dirty = true; v.rev = (v.rev || 0) + 1;
    return S.getVeh(v.vin).then((db) => {
      if (db) {
        const m = Y.mergeRecords(wire(db), wire(v));
        v = Object.assign({}, v, m); v.sent = Array.from(new Set((db.sent || []).concat(v.sent || [])));
        v.rev = Math.max(v.rev || 0, db.rev || 0);
      }
      return S.putVeh(v).then(() => { if (cur && cur.vin === v.vin) cur = v; return v; });
    });
  }
  const live = (v) => !v.deleted;
  function newRecord(vin) {
    const t = Net.nowIso();
    return { vin, photos: [], removed: [], f: { capturedAt: t }, u: t, capturedAt: t, notes: '', lotLocation: '', decoded: null, done: false, dirty: true, rev: 1, sent: [] };
  }

  /* ---------------------------------------------------------------- camera + scanning (unchanged behaviour) */
  let stream = null;
  function stopCamera() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
  function startCamera(video) {
    stopCamera();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject(new Error('Camera needs a secure (https) connection'));
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => { stream = s; video.srcObject = s; return video.play().catch(() => { }); });
  }
  function frameToCanvas(video, maxW) {
    const w = video.videoWidth, h = video.videoHeight; if (!w || !h) return null;
    const k = Math.min(1, maxW / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k); c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); return c;
  }
  function grayOf(canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, n = canvas.width * canvas.height, g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; return g;
  }
  let detector = null, scanning = false, hits = { vin: null, n: 0 }, jsTick = 0, ignore = { vin: null, until: 0 };
  function initDetector() {
    if (detector !== null || !('BarcodeDetector' in window)) return Promise.resolve();
    return window.BarcodeDetector.getSupportedFormats().then((f) => {
      const want = ['code_39', 'code_128', 'pdf417', 'data_matrix', 'qr_code'].filter((x) => f.indexOf(x) >= 0);
      detector = want.length ? new window.BarcodeDetector({ formats: want }) : false;
    }).catch(() => { detector = false; });
  }
  function openScan() {
    show('sScan'); hits = { vin: null, n: 0 }; $('vinIn').value = ''; vinInput(); $('scanNote').hidden = true; $('torchBtn').hidden = true;
    initDetector().then(() => { $('scanPhotoBtn').hidden = false; return startCamera($('scanVideo')); }).then(() => {
      const tr = stream && stream.getVideoTracks()[0], caps = tr && tr.getCapabilities ? tr.getCapabilities() : {};
      $('torchBtn').hidden = !caps.torch;
      if (!detector) { $('scanNote').hidden = false; $('scanNote').textContent = 'Automatic reading works best on barcode stickers (Code 39). If it does not catch, tap “Pick a photo” or type the VIN.'; }
      scanning = true; scanLoop();
    }).catch((e) => { $('scanNote').hidden = false; $('scanNote').textContent = 'Camera not available (' + (e && e.message || e) + '). You can still type the VIN or pick a photo.'; });
  }
  function closeScan() { scanning = false; stopCamera(); }
  function scanLoop() {
    if (!scanning) return;
    const v = $('scanVideo'); let p = Promise.resolve(null);
    if (v.readyState >= 2) {
      p = (detector ? detector.detect(v).then((codes) => codes.map((c) => c.rawValue).join(' ')).catch(() => null) : Promise.resolve(null)).then((txt) => {
        const vin = C39.extractVin(txt); if (vin) return { vin, native: true };
        if (!detector || (++jsTick % 3 === 0)) { const c = frameToCanvas(v, 1280); if (c) { const s = C39.decodeImage(grayOf(c), c.width, c.height, { rows: 25, top: 0.25, bottom: 0.75 }), vv = C39.extractVin(s); if (vv) return { vin: vv, native: false }; } }
        return null;
      });
    }
    p.then((r) => {
      if (r && scanning) {
        if (r.vin === ignore.vin && Date.now() < ignore.until) { $('scanHint').textContent = 'That was the last vehicle — aim at the next one'; setTimeout(scanLoop, 250); return; }
        if (r.vin === hits.vin) hits.n++; else hits = { vin: r.vin, n: 1 };
        if (C39.vinCheckOk(r.vin) || (r.native && hits.n >= 1) || hits.n >= 2) { onVin(r.vin); return; }
        $('scanHint').textContent = 'Reading… hold steady';
      }
      setTimeout(scanLoop, 120);
    }).catch(() => setTimeout(scanLoop, 200));
  }
  function onVin(vin) { beep(); closeScan(); openVehicle(vin); }
  function vinInput() {
    const el = $('vinIn'), v = el.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); el.value = v;
    const msg = $('vinMsg'), ok = v.length === 17 && /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
    if (!v) msg.textContent = ''; else if (v.length < 17) msg.textContent = v.length + ' of 17 characters';
    else if (!ok) msg.textContent = 'VINs never contain the letters I, O or Q';
    else msg.textContent = C39.vinCheckOk(v) ? '✓ Valid VIN' : 'Check digit does not match — double-check, or continue if it is an older/foreign vehicle';
    $('vinGo').disabled = !ok;
  }
  $('vinIn').addEventListener('input', vinInput);
  $('vinGo').onclick = () => { closeScan(); openVehicle($('vinIn').value); };
  $('scanBack').onclick = () => { closeScan(); goHome(); };
  $('torchBtn').onclick = () => { const tr = stream && stream.getVideoTracks()[0]; if (!tr) return; const on = !$('torchBtn').dataset.on; $('torchBtn').dataset.on = on ? '1' : ''; tr.applyConstraints({ advanced: [{ torch: on }] }).catch(() => toast('Light not available')); };
  $('scanPhotoBtn').onclick = () => { $('fileScan').value = ''; $('fileScan').click(); };
  $('fileScan').onchange = function () {
    const f = this.files && this.files[0]; if (!f) return;
    createImageBitmap(f).then((bmp) => {
      const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const pr = detector ? detector.detect(c).then((cs) => C39.extractVin(cs.map((x) => x.rawValue).join(' '))).catch(() => null) : Promise.resolve(null);
      return pr.then((vin) => vin || C39.extractVin(C39.decodeImage(grayOf(c), c.width, c.height, { rows: 61, top: 0.05, bottom: 0.95 })));
    }).then((vin) => { if (vin) { toast('VIN found'); onVin(vin); } else toast('No VIN barcode found in that photo — type it instead'); }).catch(() => toast('Could not read that photo'));
  };

  /* ---------------------------------------------------------------- VIN decode (NHTSA vPIC) */
  const NHTSA = { year: 'ModelYear', make: 'Make', model: 'Model', trim: 'Trim', series: 'Series', bodyClass: 'BodyClass', vehicleType: 'VehicleType', doors: 'Doors', driveType: 'DriveType', cylinders: 'EngineCylinders', displacementL: 'DisplacementL', engineHP: 'EngineHP', fuel: 'FuelTypePrimary', transmission: 'TransmissionStyle', plantCountry: 'PlantCountry', plantCity: 'PlantCity', gvwr: 'GVWR', manufacturer: 'Manufacturer', errorCode: 'ErrorCode', errorText: 'ErrorText' };
  function decodeVin(vin) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
    return fetch((CFG.nhtsaBase || 'https://vpic.nhtsa.dot.gov') + '/api/vehicles/DecodeVinValues/' + encodeURIComponent(vin) + '?format=json', { signal: ctl.signal })
      .then((r) => { clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((j) => { const row = (j.Results || [])[0] || {}, d = {}; Object.keys(NHTSA).forEach((k) => { const x = row[NHTSA[k]]; if (x !== undefined && x !== null && String(x).trim() !== '') d[k] = String(x).trim(); }); d.source = 'NHTSA vPIC'; d.decodedAt = new Date().toISOString(); return d; });
  }
  function decodeInto(vin) { // look the details up and store them (no matter which screen is open)
    return decodeVin(vin).then((d) => S.getVeh(vin).then((v) => { if (!v) return; v.decoded = Object.assign({}, v.decoded || {}, d); return commit(v, ['decoded']); }));
  }

  let decoding = false;
  function decodePending() { // vehicles captured offline get their details as soon as a connection exists
    if (decoding || !navigator.onLine) return; decoding = true;
    S.allVeh().then((all) => all.filter((v) => live(v) && !(v.decoded && v.decoded.make) && !(v.decoded && v.decoded.errorText)).reduce((p, v) => p.then(() => decodeInto(v.vin).catch(() => { })), Promise.resolve()))
      .then(() => { decoding = false; if (current === 'sHome') refreshHome(); Net.kickSoon(); }, () => { decoding = false; });
  }
  window.addEventListener('online', () => setTimeout(decodePending, 500));
  setInterval(decodePending, 30000);

  /* ---------------------------------------------------------------- vehicle screen */
  let cur = null, urls = [];
  function openVehicle(vinRaw) {
    const vin = String(vinRaw).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return S.getVeh(vin).then((v) => {
      if (!v) v = newRecord(vin);
      else if (v.deleted) { delete v.deleted; v.photos = []; v.done = false; v.capturedAt = Net.nowIso(); Y.stamp(v, ['capturedAt'], v.capturedAt); } // scanned again after being deleted
      cur = v; return commit(v, null);
    }).then((v) => {
      cur = v; show('sVeh'); renderVehicle(); startPhotoCamera();
      if (!(cur.decoded && cur.decoded.make)) decodeInto(vin).then(() => { if (cur && cur.vin === vin) S.getVeh(vin).then((f) => { if (f) { cur = Object.assign({}, cur, { decoded: f.decoded }); renderVehicle(); } }); }).catch(() => { if (cur && cur.vin === vin) renderVehicle(); });
    });
  }
  let camState = 'off';
  function startPhotoCamera() {
    $('photoHint').textContent = ''; camState = 'starting'; $('photoCam').hidden = false;
    startCamera($('photoVideo')).then(() => { camState = 'ready'; $('photoCam').hidden = false; $('shutter').disabled = false; $('pickBtn').hidden = false; $('photoHint').textContent = 'Tap the button for each photo'; })
      .catch(() => { camState = 'failed'; $('photoCam').hidden = true; $('shutter').disabled = false; $('pickBtn').hidden = false; });
  }
  function renderVehicle() {
    if (!cur) return;
    const d = cur.decoded;
    $('vehTitle').textContent = title(cur) || 'New vehicle'; $('vehVin').textContent = cur.vin;
    const f = d ? [['Year', d.year], ['Make', d.make], ['Model', d.model], ['Trim', d.trim], ['Body', d.bodyClass], ['Drive', d.driveType], ['Engine', [d.cylinders && d.cylinders + ' cyl', d.displacementL && (+d.displacementL).toFixed(1) + 'L'].filter(Boolean).join(' ')], ['Fuel', d.fuel]].filter((x) => x[1]) : [];
    $('vehDecoded').innerHTML = f.map((x) => '<div><span>' + x[0] + '</span>' + esc(x[1]) + '</div>').join('');
    const msgs = [];
    if (!d) msgs.push('Looking up vehicle details… (if you are offline they are filled in automatically later)');
    else if (!d.make) msgs.push('The VIN database found no match. Check the VIN: ' + (d.errorText || ''));
    if (!C39.vinCheckOk(cur.vin) && cur.vin.length === 17) msgs.push('VIN check digit does not match — double-check the number.');
    $('vehWarn').hidden = !msgs.length; $('vehWarn').textContent = msgs.join(' ');
    $('locIn').value = cur.lotLocation || ''; $('noteIn').value = cur.notes || '';
    renderStrip();
  }
  function renderStrip() {
    urls.forEach((u) => URL.revokeObjectURL(u)); urls = [];
    const strip = $('strip'); strip.innerHTML = '';
    $('photoCount').textContent = cur.photos.length + (cur.photos.length === 1 ? ' photo' : ' photos');
    cur.photos.forEach((p) => {
      const box = document.createElement('div'); box.className = 'ph';
      const x = () => { const b = document.createElement('button'); b.className = 'x'; b.textContent = '×'; b.setAttribute('aria-label', 'Delete photo'); b.onclick = () => removePhoto(p.id); box.appendChild(b); };
      S.getPhoto(p.id).then((rec) => {
        if (rec && rec.blob) { const u = URL.createObjectURL(rec.blob); urls.push(u); box.innerHTML = '<img src="' + u + '" alt="">'; } else box.innerHTML = '<div class="small" style="padding:10px 4px;text-align:center">on another device</div>';
        x();
      });
      strip.appendChild(box);
    });
    strip.scrollLeft = strip.scrollWidth;
  }
  function removePhoto(id) {
    if (!cur) return;
    cur.photos = cur.photos.filter((q) => q.id !== id); cur.removed = Array.from(new Set((cur.removed || []).concat(id)));
    S.delPhoto(id); commit(cur, null).then(renderStrip);
  }
  function savePhotoBlob(blob) {
    const veh = cur; if (!veh) return Promise.resolve(); const id = rid();
    return S.putPhoto({ id, vin: veh.vin, blob }).then(() => { veh.photos.push({ id, takenAt: Net.nowIso() }); veh.u = Net.nowIso(); return commit(veh, null); }).then(() => { if (cur && cur.vin === veh.vin) renderStrip(); });
  }
  function fileToJpeg(f) {
    return createImageBitmap(f).then((bmp) => {
      const k = Math.min(1, 1920 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    });
  }
  function addFiles(files) {
    return files.filter((f) => /^image\//.test(f.type)).reduce((p, f) => p.then(() => fileToJpeg(f).then((b) => b && savePhotoBlob(b))), Promise.resolve()).catch(() => toast('Could not add that photo'));
  }
  $('shutter').onclick = () => {
    const v = $('photoVideo');
    if (camState === 'starting' || (camState === 'ready' && v.readyState < 2)) { toast('Camera starting…'); return; }
    if (camState === 'ready' && stream) { const c = frameToCanvas(v, 1920); if (!c) return; c.toBlob((b) => { if (b) { beep(); savePhotoBlob(b); } }, 'image/jpeg', 0.85); }
    else { $('fileIn').value = ''; $('fileIn').click(); }
  };
  $('pickBtn').onclick = () => { $('fileIn').value = ''; $('fileIn').click(); };
  $('fileIn').onchange = function () { addFiles(Array.from(this.files || [])); };
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => { if (current === 'sVeh') { e.preventDefault(); $('sVeh').classList.add('drop'); } }));
  ['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => { if (current === 'sVeh') { e.preventDefault(); $('sVeh').classList.remove('drop'); if (ev === 'drop' && e.dataTransfer) addFiles(Array.from(e.dataTransfer.files || [])); } }));
  function saveText() {
    if (!cur) return Promise.resolve(); const fields = [];
    const loc = $('locIn').value.trim(), notes = $('noteIn').value.trim();
    if (loc !== (cur.lotLocation || '')) { cur.lotLocation = loc; fields.push('lotLocation'); }
    if (notes !== (cur.notes || '')) { cur.notes = notes; fields.push('notes'); }
    return fields.length ? commit(cur, fields) : Promise.resolve();
  }
  function leaveVehicle() { stopCamera(); return S.getVeh(cur.vin).then((f) => { if (f) { f.done = true; return commit(Object.assign(f, { photos: f.photos }), null); } }); }
  $('vehDone').onclick = () => {
    if (!cur.photos.length && !confirm('No photos taken for this vehicle. Continue anyway?')) return;
    const vin = cur.vin;
    saveText().then(leaveVehicle).then(() => { toast('Saved ' + vin.slice(-6)); ignore = { vin, until: Date.now() + 20000 }; cur = null; Net.kickSoon(); openScan(); });
  };
  $('vehBack').onclick = () => { saveText().then(leaveVehicle).then(() => { cur = null; Net.kickSoon(); goHome(); }); };
  $('vehDel').onclick = () => {
    if (!confirm('Delete this vehicle and its photos from all your devices?')) return;
    const v = cur, t = Net.nowIso(); stopCamera();
    Promise.all(v.photos.map((p) => S.delPhoto(p.id))).then(() => {
      v.deleted = true; v.deletedAt = t; v.photos = []; v.done = true;
      return commit(v, null);
    }).then(() => { cur = null; Net.kickSoon(); goHome(); });
  };

  /* ---------------------------------------------------------------- home */
  let thumbUrls = [], searchText = '';
  function matches(v, q) {
    if (!q) return true; const d = v.decoded || {};
    const hay = [v.vin, d.year, d.make, d.model, d.trim, d.bodyClass, v.lotLocation, v.notes].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.indexOf(w) >= 0);
  }
  function refreshHome() {
    return S.allVeh().then((all) => {
      const list = all.filter(live); list.sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
      const shown = list.filter((v) => matches(v, searchText));
      const wrap = $('list'); wrap.innerHTML = ''; thumbUrls.forEach((u) => URL.revokeObjectURL(u)); thumbUrls = [];
      shown.forEach((v) => {
        const b = document.createElement('button'); b.className = 'vcard card';
        const synced = !v.dirty, status = !v.done ? ['Capturing', 'wait'] : !Net.relayConfigured() ? ['On this device', ''] : !synced ? ['Waiting to sync', 'wait'] : ['Synced ✓', 'ok'];
        b.innerHTML = '<img class="th" alt=""><div class="t"><b>' + esc(title(v) || 'Details pending') + '</b><span class="small mono">' + esc(v.vin) + '</span><div class="small">' + v.photos.length + ' photos' + (v.lotLocation ? ' · ' + esc(v.lotLocation) : '') + '</div></div><span class="chip ' + status[1] + '">' + status[0] + '</span>';
        const first = v.photos[0];
        if (first) S.getPhoto(first.id).then((r) => { if (r && r.blob) { const u = URL.createObjectURL(r.blob); thumbUrls.push(u); b.querySelector('img').src = u; } });
        b.onclick = () => openVehicle(v.vin); wrap.appendChild(b);
      });
      $('emptyMsg').hidden = shown.length > 0; $('emptyMsg').innerHTML = list.length ? 'No vehicle matches that search.' : 'No vehicles yet. Tap <b>Scan next vehicle</b>, or import a list of VINs below.';
      renderDesk(list);
      const pend = list.filter((v) => v.done && v.dirty).length;
      $('pendTxt').textContent = list.length + (list.length === 1 ? ' vehicle' : ' vehicles') + (pend && Net.relayConfigured() ? ' · ' + pend + ' waiting to sync' : '');
      return pend;
    });
  }
  function goHome() { closeScan(); stopCamera(); if (!Net.account()) { showAuth(); return; } show('sHome'); refreshHome(); renderConn(); }
  $('newVeh').onclick = openScan;
  $('q').addEventListener('input', function () { searchText = this.value.trim(); refreshHome(); });
  $('syncNow').onclick = () => { if (!Net.relayConfigured()) { toast('Syncing between devices is not turned on in this copy yet'); return; } Net.syncNow().then(() => toast('Checked for changes')); };
  $('connPill').onclick = openSettings; $('setBtn').onclick = openSettings;
  function csvEscape(v) { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportList(list, name) {
    const rows = [['VIN', 'Year', 'Make', 'Model', 'Trim', 'Body', 'Drive', 'Cylinders', 'Fuel', 'Lot location', 'Notes', 'Photos', 'Captured'].join(',')];
    list.forEach((v) => { const d = v.decoded || {}; rows.push([v.vin, d.year, d.make, d.model, d.trim, d.bodyClass, d.driveType, d.cylinders, d.fuel, v.lotLocation, v.notes, v.photos.length, v.capturedAt].map(csvEscape).join(',')); });
    const blob = new Blob(['\ufeff' + rows.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name || 'rowskan-inventory.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const newestFirst = (a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || ''));
  $('exportBtn').onclick = () => S.allVeh().then((all) => exportList(all.filter(live).sort(newestFirst)));
  $('importBtn').onclick = () => { $('importFile').value = ''; $('importFile').click(); };
  function parseCsv(txt) {
    const rows = []; let row = [], f = '', q = false; txt = txt.replace(/^\ufeff/, '');
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i];
      if (q) { if (c === '"') { if (txt[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
      else if (c === '"') q = true; else if (c === ',' || c === '\t' || c === ';') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
  }
  const cleanVin = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const validVin = (x) => /^[A-HJ-NPR-Z0-9]{17}$/.test(x);
  function addVins(items) { // items: [{vin, lot, notes}] - creates or updates, then looks up details in the background
    return items.reduce((p, it) => p.then(() => S.getVeh(it.vin).then((ex) => {
      const fresh = !ex || ex.deleted, v = fresh ? newRecord(it.vin) : ex, fields = [];
      if (fresh) { v.photos = fresh && ex ? [] : v.photos; v.capturedAt = Net.nowIso(); fields.push('capturedAt'); }
      if (it.lot != null && it.lot !== '' && it.lot !== v.lotLocation) { v.lotLocation = it.lot; fields.push('lotLocation'); }
      if (it.notes != null && it.notes !== '' && it.notes !== v.notes) { v.notes = it.notes; fields.push('notes'); }
      if (!fresh && !fields.length) return;
      delete v.deleted; v.done = true; return commit(v, fields);
    })), Promise.resolve()).then(() => { refreshHome(); Net.kickSoon(); toast(items.length + ' vehicles imported — looking up details…'); decodePending(); });
  }
  let mapRows = null;
  function openMap(rows) {
    mapRows = rows; const head = rows[0].map((h, i) => (String(h).trim() || 'Column ' + (i + 1)));
    const guess = (re, skip) => { const i = head.findIndex((h, j) => re.test(h) && j !== skip); return i; };
    let vinI = guess(/vin/i); if (vinI < 0) { vinI = 0; let best = -1; for (let c = 0; c < head.length; c++) { const n = rows.slice(1, 40).filter((r) => validVin(cleanVin(r[c]))).length; if (n > best) { best = n; vinI = c; } } }
    const lotI = guess(/lot|location|spot|row/i, vinI), noteI = guess(/note|comment|memo|desc/i, vinI);
    [0, 1, 2].forEach((k) => { const sel = $('mCol' + k); sel.innerHTML = (k ? '<option value="-1">(none)</option>' : '') + head.map((h, i) => '<option value="' + i + '">' + esc(h) + '</option>').join(''); sel.value = String(k === 0 ? vinI : k === 1 ? lotI : noteI); });
    $('mapInfo').textContent = (rows.length - 1) + ' rows found. Choose which column holds each piece of information.';
    mapPreview(); $('mapDlg').classList.add('on');
  }
  function mapRowsToItems() {
    const vi = +$('mCol0').value, li = +$('mCol1').value, ni = +$('mCol2').value, seen = new Set(), out = []; let bad = 0;
    mapRows.slice(1).forEach((r) => { const vin = cleanVin(r[vi]); if (!validVin(vin)) { bad++; return; } if (seen.has(vin)) return; seen.add(vin); out.push({ vin, lot: li >= 0 ? String(r[li] || '').trim().slice(0, 40) : '', notes: ni >= 0 ? String(r[ni] || '').trim().slice(0, 300) : '' }); });
    return { out, bad };
  }
  function mapPreview() { const r = mapRowsToItems(); $('mapPrev').textContent = r.out.length + ' valid VINs will be imported' + (r.bad ? ' · ' + r.bad + ' rows skipped (no valid 17-character VIN)' : '') + '.'; $('mapGo').disabled = !r.out.length; }
  ['mCol0', 'mCol1', 'mCol2'].forEach((id) => $(id).addEventListener('change', mapPreview));
  $('mapNo').onclick = () => { $('mapDlg').classList.remove('on'); mapRows = null; };
  $('mapGo').onclick = () => { const r = mapRowsToItems(); $('mapDlg').classList.remove('on'); mapRows = null; addVins(r.out); };
  $('importFile').onchange = function () {
    const f = this.files && this.files[0]; if (!f) return;
    f.text().then((txt) => {
      const rows = parseCsv(txt);
      if (rows.length > 1 && rows[0].length > 1 && !validVin(cleanVin(rows[0][0]))) return openMap(rows);
      const vins = Array.from(new Set((txt.toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || [])));
      if (!vins.length) { toast('No VINs found in that file'); return; }
      addVins(vins.map((vin) => ({ vin })));
    });
  };

  /* ---------------------------------------------------------------- desktop table */
  const sortBy = { k: 'date', d: true }, sel = new Set(); let sideVin = null, lastShown = [];
  const keyOf = (v, k) => { const d = v.decoded || {}; return k === 'vin' ? v.vin : k === 'year' ? +d.year || 0 : k === 'make' ? d.make || '' : k === 'model' ? d.model || '' : k === 'trim' ? d.trim || '' : k === 'lot' ? v.lotLocation || '' : k === 'photos' ? v.photos.length : k === 'status' ? (v.done ? (v.dirty ? 1 : 2) : 0) : v.capturedAt || ''; };
  const statusOf = (v) => !v.done ? ['Capturing', 'wait'] : !Net.relayConfigured() ? ['On this device', ''] : v.dirty ? ['Waiting to sync', 'wait'] : ['Synced ✓', 'ok'];
  function fillSelect(id, vals, label) { const el = $(id), keep = el.value; el.innerHTML = '<option value="">' + label + '</option>' + vals.map((x) => '<option>' + esc(x) + '</option>').join(''); if (vals.indexOf(keep) >= 0) el.value = keep; }
  function renderDesk(list) {
    if (!window.matchMedia('(min-width:900px)').matches) return;
    const d = (v) => v.decoded || {};
    fillSelect('fMake', Array.from(new Set(list.map((v) => d(v).make).filter(Boolean))).sort(), 'All makes');
    fillSelect('fYear', Array.from(new Set(list.map((v) => d(v).year).filter(Boolean))).sort().reverse(), 'All years');
    fillSelect('fLot', Array.from(new Set(list.map((v) => v.lotLocation).filter(Boolean))).sort(), 'All lot locations');
    const fm = $('fMake').value, fy = $('fYear').value, fl = $('fLot').value, fs = $('fStat').value;
    let shown = list.filter((v) => matches(v, searchText) && (!fm || d(v).make === fm) && (!fy || d(v).year === fy) && (!fl || v.lotLocation === fl)
      && (!fs || (fs === 'nophoto' ? !v.photos.length : fs === 'nodetail' ? !d(v).make : (v.done && v.dirty))));
    shown.sort((a, b) => { const x = keyOf(a, sortBy.k), y = keyOf(b, sortBy.k), c = (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })); return sortBy.d ? -c : c; });
    lastShown = shown; Array.from(sel).forEach((vin) => { if (!list.some((v) => v.vin === vin)) sel.delete(vin); });
    document.querySelectorAll('.dt th[data-k]').forEach((th) => { th.classList.toggle('s', th.dataset.k === sortBy.k); th.classList.toggle('d', th.dataset.k === sortBy.k && sortBy.d); });
    const tb = $('tb'); tb.innerHTML = '';
    shown.forEach((v) => {
      const tr = document.createElement('tr'), st = statusOf(v), dd = d(v); tr.className = 'row2' + (sel.has(v.vin) ? ' sel' : '') + (v.vin === sideVin ? ' sel' : '');
      tr.innerHTML = '<td><input type="checkbox"' + (sel.has(v.vin) ? ' checked' : '') + ' aria-label="Select"></td><td><img class="th2" alt=""></td><td class="mono">' + esc(v.vin) + '</td><td>' + esc(dd.year || '') + '</td><td>' + esc(dd.make || '') + '</td><td>' + esc(dd.model || '') + '</td><td>' + esc(dd.trim || '') + '</td><td>' + esc(v.lotLocation || '') + '</td><td>' + v.photos.length + '</td><td>' + esc(String(v.capturedAt || '').slice(0, 10)) + '</td><td><span class="chip ' + st[1] + '">' + st[0] + '</span></td>';
      if (v.photos[0]) S.getPhoto(v.photos[0].id).then((r) => { if (r && r.blob) { const u = URL.createObjectURL(r.blob); thumbUrls.push(u); tr.querySelector('img').src = u; } });
      tr.querySelector('input').onclick = (e) => { e.stopPropagation(); if (e.target.checked) sel.add(v.vin); else sel.delete(v.vin); tr.classList.toggle('sel', e.target.checked); bulkRender(); };
      tr.onclick = () => openSide(v.vin); tb.appendChild(tr);
    });
    $('dCount').textContent = shown.length + ' of ' + list.length + ' vehicles'; $('selAll').checked = shown.length > 0 && shown.every((v) => sel.has(v.vin));
    bulkRender(); if (sideVin) { if (list.some((v) => v.vin === sideVin)) { if (!sideEditing()) fillSide(); } else closeSide(); }
  }
  document.querySelectorAll('.dt th[data-k]').forEach((th) => { th.onclick = () => { const k = th.dataset.k; sortBy.d = sortBy.k === k ? !sortBy.d : (k === 'date' || k === 'photos'); sortBy.k = k; refreshHome(); }; });
  ['fMake', 'fYear', 'fLot', 'fStat'].forEach((id) => $(id).addEventListener('change', refreshHome));
  window.addEventListener('resize', () => { if (current === 'sHome') refreshHome(); });
  $('selAll').onclick = function () { lastShown.forEach((v) => { if (this.checked) sel.add(v.vin); else sel.delete(v.vin); }); refreshHome(); };
  function bulkRender() { $('bulkBar').hidden = sel.size === 0; $('bulkN').textContent = sel.size + ' selected'; }
  const selVeh = () => Promise.all(Array.from(sel).map((vin) => S.getVeh(vin))).then((l) => l.filter((v) => v && live(v)));
  $('bulkClr').onclick = () => { sel.clear(); refreshHome(); };
  $('bulkSet').onclick = () => { const loc = $('bulkLot').value.trim().slice(0, 40); selVeh().then((l) => l.reduce((p, v) => p.then(() => { v.lotLocation = loc; return commit(v, ['lotLocation']); }), Promise.resolve()).then(() => { toast('Location set for ' + l.length + ' vehicles'); Net.kickSoon(); refreshHome(); })); };
  $('bulkExp').onclick = () => selVeh().then((l) => exportList(l.sort(newestFirst), 'rowskan-selected.csv'));
  $('bulkDel').onclick = () => {
    if (!confirm('Delete ' + sel.size + ' vehicles and their photos from all your devices?')) return;
    selVeh().then((l) => l.reduce((p, v) => p.then(() => Promise.all(v.photos.map((ph) => S.delPhoto(ph.id))).then(() => { v.deleted = true; v.deletedAt = Net.nowIso(); v.photos = []; v.done = true; return commit(v, null); })), Promise.resolve()).then(() => { sel.clear(); closeSide(); Net.kickSoon(); refreshHome(); toast('Deleted'); }));
  };
  $('dExport').onclick = () => exportList(lastShown, 'rowskan-inventory.csv'); $('dImport').onclick = $('importBtn').onclick; $('dPrint').onclick = () => window.print();
  function sideEditing() { const a = document.activeElement; return a === $('sLot') || a === $('sNote'); }
  function openSide(vin) { sideVin = vin; $('side').hidden = false; fillSide(); refreshHome(); }
  function closeSide() { sideVin = null; $('side').hidden = true; }
  let sideUrls = [];
  function fillSide() {
    S.getVeh(sideVin).then((v) => {
      if (!v || v.deleted) return closeSide(); const dd = v.decoded || {};
      $('sTitle').textContent = title(v) || 'Details pending'; $('sVin').textContent = v.vin;
      $('sDec').innerHTML = [['Body', dd.bodyClass], ['Drive', dd.driveType], ['Engine', [dd.cylinders && dd.cylinders + ' cyl', dd.displacementL && (+dd.displacementL).toFixed(1) + 'L'].filter(Boolean).join(' ')], ['Fuel', dd.fuel], ['Trim', dd.trim]].filter((x) => x[1]).map((x) => '<div><span>' + x[0] + '</span>' + esc(x[1]) + '</div>').join('');
      if (document.activeElement !== $('sLot')) $('sLot').value = v.lotLocation || ''; if (document.activeElement !== $('sNote')) $('sNote').value = v.notes || '';
      sideUrls.forEach((u) => URL.revokeObjectURL(u)); sideUrls = []; const box = $('sPh'); box.innerHTML = ''; $('sPhN').textContent = v.photos.length + (v.photos.length === 1 ? ' photo' : ' photos');
      v.photos.forEach((p) => S.getPhoto(p.id).then((r) => { if (r && r.blob) { const u = URL.createObjectURL(r.blob); sideUrls.push(u); const im = document.createElement('img'); im.src = u; im.alt = ''; im.onclick = () => { $('lb').querySelector('img').src = u; $('lb').classList.add('on'); }; box.appendChild(im); } }));
    });
  }
  $('lbX').onclick = () => $('lb').classList.remove('on'); $('lb').onclick = (e) => { if (e.target === $('lb')) $('lb').classList.remove('on'); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('lb').classList.remove('on'); $('mapDlg').classList.remove('on'); } });
  $('sClose').onclick = () => { closeSide(); refreshHome(); };
  $('sSave').onclick = () => S.getVeh(sideVin).then((v) => { if (!v) return; const f = [], loc = $('sLot').value.trim(), nt = $('sNote').value.trim(); if (loc !== (v.lotLocation || '')) { v.lotLocation = loc; f.push('lotLocation'); } if (nt !== (v.notes || '')) { v.notes = nt; f.push('notes'); } return (f.length ? commit(v, f) : Promise.resolve()).then(() => { toast('Saved'); Net.kickSoon(); refreshHome(); }); });
  $('sOpen').onclick = () => openVehicle(sideVin);
  $('sDel').onclick = () => { if (!confirm('Delete this vehicle and its photos from all your devices?')) return; S.getVeh(sideVin).then((v) => Promise.all(v.photos.map((p) => S.delPhoto(p.id))).then(() => { v.deleted = true; v.deletedAt = Net.nowIso(); v.photos = []; v.done = true; return commit(v, null); })).then(() => { sel.delete(sideVin); closeSide(); Net.kickSoon(); refreshHome(); }); };

  /* ---------------------------------------------------------------- connection pill */
  function renderConn() {
    const s = Net.status(), dot = $('connDot'), txt = $('connTxt');
    const map = { ok: ['on', 'Synced'], syncing: ['on', 'Syncing…'], offline: ['', 'Offline — will sync later'], needslink: ['bad', 'Link this device'], unconfigured: ['', 'On this device'], error: ['bad', 'Sync problem'], idle: ['', 'Starting…'] };
    const m = map[s.state] || map.idle; dot.className = 'dot' + (m[0] ? ' ' + m[0] : ''); txt.textContent = m[1];
    $('syncMsg').textContent = s.state === 'error' ? s.error : s.state === 'unconfigured' ? 'Syncing between devices is not turned on in this copy yet. Everything is saved on this device.' : s.state === 'ok' ? 'Changes are shared with your other devices automatically.' : s.state === 'offline' ? 'No connection. Everything is saved here and sends itself when you are back online.' : '';
  }
  Net.on('status', (s) => { renderConn(); if (s.state === 'ok') decodePending(); if (s.state === 'needslink' && current === 'sHome') showLink('needkey'); if (current === 'sHome') refreshHome(); });
  Net.on('vehicle', (e) => {
    if (current === 'sHome') refreshHome();
    if (current === 'sVeh' && cur && cur.vin === e.vin) S.getVeh(e.vin).then((db) => { if (!db || db.deleted) { toast('This vehicle was deleted on another device'); cur = null; goHome(); return; } const m = Y.mergeRecords(wire(db), wire(cur)); cur = Object.assign({}, cur, m); renderStrip(); });
  });
  Net.on('signedout', (msg) => { closeScan(); stopCamera(); showAuth(msg); });

  /* ---------------------------------------------------------------- sign in / register */
  let authMode = 'in';
  function showAuth(msg) {
    show('sAuth'); $('authForm').hidden = false; $('resetForm').hidden = true; setMode('in'); showErr($('authErr'), '');
    $('authNote').hidden = !msg; $('authNote').textContent = msg || ''; $('authPw').value = '';
  }
  function setMode(m) {
    authMode = m; $('tabIn').classList.toggle('on', m === 'in'); $('tabUp').classList.toggle('on', m === 'up');
    $('authGo').textContent = m === 'up' ? 'Create account' : 'Sign in'; $('authForgot').hidden = (m === 'up'); $('authHint').hidden = (m !== 'up');
    $('authPw').autocomplete = m === 'up' ? 'new-password' : 'current-password'; showErr($('authErr'), '');
  }
  $('tabIn').onclick = () => setMode('in'); $('tabUp').onclick = () => setMode('up');
  function authGo() {
    const em = $('authEmail').value.trim(), pw = $('authPw').value; showErr($('authErr'), '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) return showErr($('authErr'), 'Enter a valid email address.');
    if (authMode === 'up') { const p = Net.passwordProblem(pw); if (p) return showErr($('authErr'), p); } else if (!pw) return showErr($('authErr'), 'Enter your password.');
    $('authGo').disabled = true;
    (authMode === 'up' ? Net.signUp(em, pw) : Net.signIn(em, pw)).then(() => { $('authPw').value = ''; afterAuth(); })
      .catch((e) => showErr($('authErr'), e.message)).then(() => { $('authGo').disabled = false; });
  }
  $('authGo').onclick = authGo; ['authEmail', 'authPw'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') authGo(); }));
  $('authForgot').onclick = () => { $('authForm').hidden = true; $('resetForm').hidden = false; $('rsSent').hidden = true; $('rsEmail').value = $('authEmail').value; $('rsEmail').focus(); };
  $('rsBack').onclick = () => { $('resetForm').hidden = true; $('authForm').hidden = false; };
  $('rsSend').onclick = () => {
    const em = $('rsEmail').value.trim(); showErr($('rsErr'), ''); $('rsSent').hidden = true;
    if (!em) return showErr($('rsErr'), 'Enter your email address.');
    $('rsSend').disabled = true; Net.sendReset(em).then(() => { $('rsSent').hidden = false; }).catch((e) => showErr($('rsErr'), e.message)).then(() => { $('rsSend').disabled = false; });
  };
  $('authScanLink').onclick = () => showLink('signin');
  function afterAuth() {
    Net.start();
    if (pendingApproval && Net.hasKey()) { startApprove(pendingApproval); pendingApproval = null; return; }
    goHome();
  }

  /* ---------------------------------------------------------------- link this device */
  let linkToken = 0;
  function showLink(mode) { // mode: 'signin' (not signed in) | 'needkey' (signed in, other devices hold the key)
    show('sLink'); const my = ++linkToken; showErr($('linkErr'), ''); $('linkQr').innerHTML = ''; $('linkTxt').value = '';
    if (!Net.relayConfigured()) { showErr($('linkErr'), 'Syncing between devices is not turned on in this copy yet.'); return; }
    $('linkWait').textContent = 'Waiting for approval…';
    Net.startLinkRequest().then((req) => {
      if (my !== linkToken) return;
      $('linkQr').innerHTML = window.RowSkanQR.svg(req.text); $('linkTxt').value = req.text;
      return Net.awaitLink(req, () => my !== linkToken).then((r) => {
        if (!r || my !== linkToken) return;
        $('linkWait').textContent = 'Approved ✓'; Net.start(); toast('Device linked'); goHome();
      });
    }).catch((e) => { if (my === linkToken) showErr($('linkErr'), e.message); });
  }
  $('linkBack').onclick = () => { linkToken++; if (Net.account()) { goHome(); } else showAuth(); };
  $('linkCopy').onclick = () => { $('linkTxt').select(); (navigator.clipboard ? navigator.clipboard.writeText($('linkTxt').value) : Promise.reject()).then(() => toast('Copied'), () => { try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Select the text and copy it'); } }); };

  /* ---------------------------------------------------------------- approve a new device */
  let pendingApproval = null, apReq = null, apScanning = false;
  function openApprove() { show('sApprove'); $('apAsk').hidden = false; $('apConfirm').hidden = true; showErr($('apErr'), ''); $('apPaste').value = ''; apReq = null; startApScan(); }
  function startApScan() {
    $('apNote').hidden = true; $('apCam').hidden = false;
    const det = ('BarcodeDetector' in window) ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    if (!det) { $('apCam').hidden = true; $('apNote').hidden = false; $('apNote').textContent = 'This device cannot scan codes in the app. Open the link from the new device here, or paste it below.'; return; }
    startCamera($('apVideo')).then(() => {
      apScanning = true;
      (function loop() {
        if (!apScanning) return;
        det.detect($('apVideo')).then((cs) => { const r = cs.length && Net.parseLink(cs[0].rawValue); if (r) { stopApScan(); startApprove(r); } else setTimeout(loop, 250); }).catch(() => setTimeout(loop, 400));
      })();
    }).catch(() => { $('apCam').hidden = true; $('apNote').hidden = false; $('apNote').textContent = 'Camera not available. Paste the link from the new device below.'; });
  }
  function stopApScan() { apScanning = false; stopCamera(); }
  function startApprove(req) { apReq = req; show('sApprove'); stopApScan(); $('apAsk').hidden = true; $('apConfirm').hidden = false; $('apName').textContent = req.name; showErr($('apErr'), ''); }
  $('apUse').onclick = () => { const r = Net.parseLink($('apPaste').value); if (!r) return showErr($('apErr'), 'That does not look like a RowSkan link.'); startApprove(r); };
  $('apNo').onclick = () => { apReq = null; openSettings(); };
  $('apYes').onclick = () => { $('apYes').disabled = true; Net.approveLink(apReq).then(() => { toast('Device approved'); apReq = null; openSettings(); }).catch((e) => showErr($('apErr'), e.status === 409 ? 'That code was already used. Ask for a new one.' : e.message)).then(() => { $('apYes').disabled = false; }); };
  $('apBack').onclick = () => { stopApScan(); openSettings(); };

  /* ---------------------------------------------------------------- settings */
  function openSettings() {
    closeScan(); stopApScan(); show('sSet'); const a = Net.account();
    $('setAcct').textContent = a ? a.email : ''; $('devName').value = Net.deviceName();
    S.allVeh().then((l) => { const live1 = l.filter(live); let n = 0; live1.forEach((v) => { n += v.photos.length; }); $('setStore').textContent = live1.length + ' vehicles · ' + n + ' photos stored on this device'; });
    const box = $('devList'); box.textContent = Net.relayConfigured() ? 'Loading…' : 'Syncing between devices is not turned on in this copy yet.';
    $('addDev').disabled = !Net.relayConfigured() || !Net.hasKey();
    if (Net.relayConfigured()) Net.listDevices().then((r) => {
      box.innerHTML = '';
      r.devices.forEach((d) => {
        const row = document.createElement('div'); row.className = 'dev'; const me = d.deviceId === r.me;
        row.innerHTML = '<div><b>' + esc(d.name || d.kind) + '</b>' + (me ? ' <span class="chip ok">this device</span>' : '') + '<div class="small">' + esc(d.kind) + ' · added ' + new Date(d.addedAt).toLocaleDateString() + '</div></div>';
        if (!me) { const b = document.createElement('button'); b.textContent = 'Remove'; b.style.minHeight = '40px'; b.onclick = () => { if (confirm('Remove ' + (d.name || d.kind) + '? It keeps its own copy but stops syncing until it is linked again.')) Net.removeDevice(d.deviceId).then(openSettings).catch((e) => toast(e.message)); }; row.appendChild(b); }
        box.appendChild(row);
      });
      if (!r.devices.length) box.textContent = 'No devices yet.';
    }).catch((e) => { box.textContent = e.offline ? 'Offline — device list unavailable.' : (e.message || 'Could not load devices.'); });
  }
  $('setBack').onclick = goHome; $('addDev').onclick = openApprove;
  $('devName').addEventListener('change', function () { Net.setName(this.value.trim()); });
  $('signOut').onclick = () => { if (confirm('Sign out and remove all inventory from THIS device? Your other devices keep their copies.')) Net.signOut(true); };
  $('delAcct').onclick = () => {
    if (!confirm('Delete your account?\n\nThis erases your sign-in account, anything waiting on the sync server, and the inventory on this device. Other devices keep their copies until you sign out there.')) return;
    if ((prompt('Type DELETE to confirm') || '').trim().toUpperCase() !== 'DELETE') return;
    Net.deleteAccount().catch((e) => toast(e.message));
  };

  /* ---------------------------------------------------------------- start */
  function readLinkHash() { const r = Net.parseLink(location.hash); if (r) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ } } return r; }
  function boot() {
    pendingApproval = readLinkHash();
    return Net.loadMeta().then((a) => {
      if (!a) { showAuth(); return; }
      Net.start();
      if (pendingApproval && Net.hasKey()) { startApprove(pendingApproval); pendingApproval = null; return; }
      goHome();
    });
  }
  window.addEventListener('hashchange', () => { const r = readLinkHash(); if (!r) return; if (Net.account() && Net.hasKey()) startApprove(r); else pendingApproval = r; });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => { });
  S.ready.then(boot).catch(() => { document.body.innerHTML = '<p style="padding:20px">This browser blocked on-device storage (private mode?). Open RowSkan in a normal tab.</p>'; });
  window.__rowskan = { openVehicle, allVeh: S.allVeh, net: Net, S, Y, refreshHome };
})();
