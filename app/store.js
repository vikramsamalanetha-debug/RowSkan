/* RowSkan local storage (IndexedDB). Every device keeps its own full copy. A product of LIT America (www.litamerica.net). */
(function () {
  'use strict';
  var dbp = new Promise(function (res, rej) {
    var r = indexedDB.open('rowskan2', 1);
    r.onupgradeneeded = function () { var d = r.result; d.createObjectStore('vehicles', { keyPath: 'vin' }); d.createObjectStore('photos', { keyPath: 'id' }); d.createObjectStore('meta'); };
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
  window.RS_Store = {
    ready: dbp,
    getVeh: function (vin) { return tx('vehicles', 'readonly', function (s) { return s.get(vin); }); },
    putVeh: function (v) { return tx('vehicles', 'readwrite', function (s) { return s.put(v); }); },
    allVeh: function () { return tx('vehicles', 'readonly', function (s) { return s.getAll(); }); },
    delVeh: function (vin) { return tx('vehicles', 'readwrite', function (s) { return s.delete(vin); }); },
    getPhoto: function (id) { return tx('photos', 'readonly', function (s) { return s.get(id); }); },
    putPhoto: function (p) { return tx('photos', 'readwrite', function (s) { return s.put(p); }); },
    delPhoto: function (id) { return tx('photos', 'readwrite', function (s) { return s.delete(id); }); },
    metaGet: function (k) { return tx('meta', 'readonly', function (s) { return s.get(k); }); },
    metaSet: function (k, v) { return tx('meta', 'readwrite', function (s) { return s.put(v, k); }); },
    metaDel: function (k) { return tx('meta', 'readwrite', function (s) { return s.delete(k); }); },
    wipe: function () { return Promise.all(['vehicles', 'photos', 'meta'].map(function (n) { return tx(n, 'readwrite', function (s) { return s.clear(); }); })); }
  };
})();
