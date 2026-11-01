/*
 * Tiny Code 39 + VIN helpers (no dependencies) - part of RowSkan, a product of LIT America.
 * Used as a fallback on phones whose browser has no built-in BarcodeDetector (e.g. iPhone Safari).
 * Pattern table generated from the ReportLab reference implementation (n = narrow, w = wide;
 * element order: bar, space, bar, space, bar, space, bar, space, bar).
 */
(function (root) {
  'use strict';
  var TABLE = {"0":"nnnwwnwnn","1":"wnnwnnnnw","2":"nnwwnnnnw","3":"wnwwnnnnn","4":"nnnwwnnnw","5":"wnnwwnnnn","6":"nnwwwnnnn","7":"nnnwnnwnw","8":"wnnwnnwnn","9":"nnwwnnwnn","A":"wnnnnwnnw","B":"nnwnnwnnw","C":"wnwnnwnnn","D":"nnnnwwnnw","E":"wnnnwwnnn","F":"nnwnwwnnn","G":"nnnnnwwnw","H":"wnnnnwwnn","I":"nnwnnwwnn","J":"nnnnwwwnn","K":"wnnnnnnww","L":"nnwnnnnww","M":"wnwnnnnwn","N":"nnnnwnnww","O":"wnnnwnnwn","P":"nnwnwnnwn","Q":"nnnnnnwww","R":"wnnnnnwwn","S":"nnwnnnwwn","T":"nnnnwnwwn","U":"wwnnnnnnw","V":"nwwnnnnnw","W":"wwwnnnnnn","X":"nwnnwnnnw","Y":"wwnnwnnnn","Z":"nwwnwnnnn","-":"nwnnnnwnw",".":"wwnnnnwnn"," ":"nwwnnnwnn","*":"nwnnwnwnn","$":"nwnwnwnnn","/":"nwnwnnnwn","+":"nwnnnwnwn","%":"nnnwnwnwn"};
  var LOOKUP = {};
  Object.keys(TABLE).forEach(function (ch) { LOOKUP[TABLE[ch]] = ch; });

  var VIN_VAL = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
  var VIN_W = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  function vinCheckOk(vin) {
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
    var sum = 0;
    for (var i = 0; i < 17; i++) { var c = vin.charAt(i); sum += (/\d/.test(c) ? +c : VIN_VAL[c]) * VIN_W[i]; }
    var r = sum % 11;
    return vin.charAt(8) === (r === 10 ? 'X' : String(r));
  }
  // Find a VIN inside scanned text. Prefers one whose check digit is valid.
  function extractVin(text) {
    if (!text) return null;
    var t = String(text).toUpperCase();
    var re = /[A-HJ-NPR-Z0-9]{17}/g, m, first = null;
    // scan every window so we also find a VIN glued to a prefix such as "I" or a stock number
    for (var i = 0; i + 17 <= t.length; i++) {
      var w = t.substr(i, 17);
      if (/^[A-HJ-NPR-Z0-9]{17}$/.test(w)) { if (vinCheckOk(w)) return w; if (!first) first = w; }
    }
    return first;
  }

  // ---- Code 39 decoding from one row of gray values (0..255) ----
  function runsFromRow(row) {
    var n = row.length, win = Math.max(15, (n / 8) | 0), half = win >> 1;
    // sliding-window mean threshold (copes with uneven lighting)
    var pre = new Float64Array(n + 1);
    for (var i = 0; i < n; i++) pre[i + 1] = pre[i] + row[i];
    var runs = [], cur = null, len = 0;
    for (var x = 0; x < n; x++) {
      var a = Math.max(0, x - half), b = Math.min(n, x + half + 1);
      var mean = (pre[b] - pre[a]) / (b - a);
      var dark = row[x] < mean - 6; // small bias keeps flat areas "light"
      if (cur === null) { cur = dark; len = 1; }
      else if (dark === cur) len++;
      else { runs.push([cur, len]); cur = dark; len = 1; }
    }
    if (cur !== null) runs.push([cur, len]);
    return runs;
  }
  function classify(widths) { // widths: 9 numbers -> 'nnwwn...' or null
    var idx = widths.map(function (w, i) { return i; }).sort(function (a, b) { return widths[b] - widths[a]; });
    var wide = {}; idx.slice(0, 3).forEach(function (i) { wide[i] = 1; });
    var minWide = Math.min(widths[idx[0]], widths[idx[1]], widths[idx[2]]);
    var maxNarrow = Math.max.apply(null, idx.slice(3).map(function (i) { return widths[i]; }));
    if (minWide < maxNarrow * 1.35) return null; // not clearly wide vs narrow
    var s = ''; for (var i = 0; i < 9; i++) s += wide[i] ? 'w' : 'n';
    return s;
  }
  function decodeRuns(runs) {
    var best = null;
    for (var start = 0; start < runs.length - 12; start++) {
      if (!runs[start][0]) continue; // must start with a bar
      var out = '', pos = start, ok = true, narrowRef = 0;
      while (pos + 9 <= runs.length) {
        var w = []; for (var k = 0; k < 9; k++) { if (runs[pos + k][0] !== (k % 2 === 0)) { ok = false; break; } w.push(runs[pos + k][1]); }
        if (!ok) break;
        var pat = classify(w); if (!pat) { ok = false; break; }
        var ch = LOOKUP[pat]; if (!ch) { ok = false; break; }
        if (out.length === 0) { if (ch !== '*') { ok = false; break; } }
        var nar = []; for (var j = 0; j < 9; j++) if (pat.charAt(j) === 'n') nar.push(w[j]);
        var nAvg = nar.reduce(function (a, b) { return a + b; }, 0) / nar.length;
        if (narrowRef && (nAvg > narrowRef * 1.8 || nAvg < narrowRef / 1.8)) { ok = false; break; }
        narrowRef = narrowRef ? (narrowRef * 0.7 + nAvg * 0.3) : nAvg;
        out += ch; pos += 9;
        if (out.length > 1 && ch === '*') { best = out.slice(1, -1); return best; }
        if (pos >= runs.length) { ok = false; break; }
        var gap = runs[pos]; // inter-character gap must be a narrow space
        if (gap[0] || gap[1] > narrowRef * 2.6) { ok = false; break; }
        pos += 1;
        if (out.length > 40) { ok = false; break; }
      }
    }
    return best;
  }
  function decodeRow(row) {
    var r = decodeRuns(runsFromRow(row));
    if (r) return r;
    var rev = Array.prototype.slice.call(row).reverse(); // upside-down barcode
    return decodeRuns(runsFromRow(rev));
  }
  // gray: Uint8 array width*height. Returns decoded string or null.
  function decodeImage(gray, width, height, opts) {
    opts = opts || {};
    var rows = opts.rows || 21, y0 = opts.top === undefined ? 0.15 : opts.top, y1 = opts.bottom === undefined ? 0.85 : opts.bottom;
    for (var r = 0; r < rows; r++) {
      var y = Math.floor((y0 + (y1 - y0) * (r / (rows - 1))) * (height - 1));
      var row = gray.subarray ? gray.subarray(y * width, (y + 1) * width) : gray.slice(y * width, (y + 1) * width);
      var s = decodeRow(row);
      if (s && s.length >= 5) return s;
    }
    return null;
  }

  var api = { decodeRow: decodeRow, decodeImage: decodeImage, extractVin: extractVin, vinCheckOk: vinCheckOk, TABLE: TABLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LotCode39 = api;
})(typeof self !== 'undefined' ? self : this);
