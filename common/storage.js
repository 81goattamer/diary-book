/* 両アプリ共通：IndexedDB の保存
 * DiaryStorage.open(dbName, storeNames) で開き、ストアごとに key → value で読み書きする。 */
(function () {
  'use strict';

  var VERSION = 1;

  function req(r) {
    return new Promise(function (resolve, reject) {
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function done(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
    });
  }

  function Store(db) { this.db = db; }

  Store.prototype.get = function (store, key) {
    return req(this.db.transaction(store, 'readonly').objectStore(store).get(key));
  };

  Store.prototype.getAll = function (store) {
    return req(this.db.transaction(store, 'readonly').objectStore(store).getAll());
  };

  Store.prototype.getAllKeys = function (store) {
    return req(this.db.transaction(store, 'readonly').objectStore(store).getAllKeys());
  };

  Store.prototype.put = function (store, key, value) {
    var tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    return done(tx);
  };

  Store.prototype.delete = function (store, key) {
    var tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    return done(tx);
  };

  /** 複数ストアをまとめて置き換える。data = { storeName: { key: value, ... } }（含めたストアは全消去してから書く） */
  Store.prototype.replaceAll = function (data) {
    var names = Object.keys(data);
    var tx = this.db.transaction(names, 'readwrite');
    names.forEach(function (name) {
      var os = tx.objectStore(name);
      os.clear();
      Object.keys(data[name]).forEach(function (key) { os.put(data[name][key], key); });
    });
    return done(tx);
  };

  /** すべてのストアを空にする */
  Store.prototype.clearAll = function () {
    var names = Array.prototype.slice.call(this.db.objectStoreNames);
    var tx = this.db.transaction(names, 'readwrite');
    names.forEach(function (name) { tx.objectStore(name).clear(); });
    return done(tx);
  };

  function open(dbName, storeNames) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      var r;
      try { r = indexedDB.open(dbName, VERSION); } catch (e) { reject(e); return; }
      r.onupgradeneeded = function () {
        storeNames.forEach(function (n) {
          if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n);
        });
      };
      r.onsuccess = function () { resolve(new Store(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.onblocked = function () { reject(new Error('IndexedDB is blocked')); };
    });
  }

  /** ブラウザにデータを消されにくくする（対応ブラウザのみ） */
  function requestPersist() {
    try {
      if (navigator.storage && navigator.storage.persist) return navigator.storage.persist().catch(function () { return false; });
    } catch (e) { /* 何もしない */ }
    return Promise.resolve(false);
  }

  window.DiaryStorage = { open: open, requestPersist: requestPersist };
})();
