/* 両アプリ共通：DIARY_BOOK_DATA.zip の読み書き（JSZip を使用） */
(function () {
  'use strict';

  var ZIP_NAME = 'DIARY_BOOK_DATA.zip';
  var IMAGE_DIR = 'DIARY_BOOK_IMAGE';

  function baseName(path) { return path.split('/').pop(); }

  /** 画像を区別するキー「YYYYMMDD/ファイル名」（画像は日付ごとのフォルダに入れる） */
  function imageKey(date, name) { return date + '/' + name; }

  /** entries の画像のキー一覧（重複なし） */
  function imageKeys(entries) {
    var keys = [];
    entries.forEach(function (e) {
      e.images.forEach(function (n) { var k = imageKey(e.date, n); if (keys.indexOf(k) === -1) keys.push(k); });
    });
    return keys;
  }

  /**
   * ZIP 内の画像を、キー「YYYYMMDD/ファイル名」ごとに探す。
   * まず「YYYYMMDD フォルダの中の同じファイル名」を探し、なければ前の形式（日付フォルダなし）として
   * ファイル名だけで探す。inImageDir が true なら DIARY_BOOK_IMAGE フォルダの中だけを見る。
   * @returns {Object<string, JSZipObject>} 見つかった分だけ
   */
  function matchImages(zip, keys, inImageDir) {
    var wanted = {};
    keys.forEach(function (k) { wanted[k] = true; });
    var exact = {};
    var byName = {};
    zip.forEach(function (path, f) {
      if (f.dir || path.indexOf('__MACOSX/') === 0) return;
      var parts = path.split('/');
      if (inImageDir && parts.indexOf(IMAGE_DIR) === -1) return;
      var name = parts[parts.length - 1];
      var folder = parts.length > 1 ? parts[parts.length - 2] : '';
      var key = imageKey(folder, name);
      if (wanted[key] && !exact[key]) exact[key] = f;
      // ファイル名だけで探すのは、日付フォルダに入っていない（前の形式の）画像に限る
      if (!/^\d{8}$/.test(folder) && !byName[name]) byName[name] = f;
    });
    var found = {};
    keys.forEach(function (k) {
      var f = exact[k] || byName[k.slice(k.indexOf('/') + 1)];
      if (f) found[k] = f;
    });
    return found;
  }

  /** ZIP 内のパスからファイルを探す（フォルダごと圧縮された ZIP にも対応） */
  function findFile(zip, name) {
    var found = null;
    zip.forEach(function (path, file) {
      if (found || file.dir || path.indexOf('__MACOSX/') === 0) return;
      if (baseName(path) === name) found = file;
    });
    return found;
  }

  /**
   * ZIP を読む。
   * @returns {Promise<{setting, entries, images: Object<string, Blob>}>}
   *   images は ZIP 内にあった画像（キー「YYYYMMDD/ファイル名」→ Blob）。MST に書かれていても ZIP にない画像は含まない。
   * 形式が正しくないときは DiaryFormatError を投げる。
   */
  function read(file) {
    return JSZip.loadAsync(file).catch(function () {
      throw DiaryCsv.FormatError('ZIP ファイルを開けませんでした');
    }).then(function (zip) {
      var sf = findFile(zip, DiaryCsv.SETTING_FILE);
      var mf = findFile(zip, DiaryCsv.MST_FILE);
      if (!sf) throw DiaryCsv.FormatError('ZIP の中に ' + DiaryCsv.SETTING_FILE + ' がありません');
      if (!mf) throw DiaryCsv.FormatError('ZIP の中に ' + DiaryCsv.MST_FILE + ' がありません');
      return Promise.all([sf.async('string'), mf.async('string')]).then(function (texts) {
        var setting = DiaryCsv.parseSetting(texts[0]);
        var entries = DiaryCsv.parseMst(texts[1]);
        var found = matchImages(zip, imageKeys(entries), true);
        var images = {};
        var jobs = Object.keys(found).map(function (k) {
          return found[k].async('arraybuffer').then(function (buf) {
            images[k] = new Blob([buf], { type: 'image/jpeg' });
          });
        });
        return Promise.all(jobs).then(function () {
          return { setting: setting, entries: entries, images: images };
        });
      });
    });
  }

  /**
   * ZIP を作る。
   * @param setting { password, name, message }
   * @param entries [{ date, tags[], title, contents, images: [{ name, blob }] }]
   * @returns {Promise<Blob>}
   */
  function write(setting, entries) {
    var zip = new JSZip();
    zip.file(DiaryCsv.SETTING_FILE, DiaryCsv.buildSetting(setting));
    var rows = entries.map(function (e) {
      return { date: e.date, tags: e.tags, title: e.title, contents: e.contents, images: e.images.map(function (i) { return i.name; }) };
    });
    zip.file(DiaryCsv.MST_FILE, DiaryCsv.buildMst(rows));
    var dir = zip.folder(IMAGE_DIR);
    entries.forEach(function (e) {
      if (!e.images.length) return;
      var day = dir.folder(e.date); // 画像は日付ごとのフォルダ「YYYYMMDD」に入れる
      e.images.forEach(function (img) { day.file(img.name, img.blob, { compression: 'STORE' }); });
    });
    return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' });
  }

  /**
   * 画像だけを入れた ZIP から、keys（「YYYYMMDD/ファイル名」）の画像を取り出す。
   * 日付フォルダ「YYYYMMDD」の中を探し、なければファイル名だけで探す（その上のフォルダ構成は問わない）。
   * @returns {Promise<Object<string, Blob>>} 見つかった分だけ
   */
  function readImages(file, keys) {
    return JSZip.loadAsync(file).catch(function () {
      throw DiaryCsv.FormatError('画像 ZIP を開けませんでした');
    }).then(function (zip) {
      var found = matchImages(zip, keys, false);
      var images = {};
      var jobs = Object.keys(found).map(function (k) {
        return found[k].async('blob').then(function (blob) { images[k] = blob; });
      });
      return Promise.all(jobs).then(function () { return images; });
    });
  }

  window.DiaryZip = { ZIP_NAME: ZIP_NAME, read: read, readImages: readImages, write: write, imageKey: imageKey, imageKeys: imageKeys };
})();
