/* 両アプリ共通：DIARY_BOOK_DATA.zip の読み書き（JSZip を使用） */
(function () {
  'use strict';

  var ZIP_NAME = 'DIARY_BOOK_DATA.zip';
  var IMAGE_DIR = 'DIARY_BOOK_IMAGE/';

  function baseName(path) { return path.split('/').pop(); }

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
   *   images は ZIP 内にあった画像（ファイル名 → Blob）。MST に書かれていても ZIP にない画像は含まない。
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
        var wanted = {};
        entries.forEach(function (e) { e.images.forEach(function (n) { wanted[n] = true; }); });
        var jobs = [];
        var images = {};
        zip.forEach(function (path, f) {
          if (f.dir || path.indexOf('__MACOSX/') === 0) return;
          if (path.indexOf(IMAGE_DIR) === -1) return;
          var name = baseName(path);
          if (!wanted[name] || images[name]) return;
          images[name] = true;
          jobs.push(f.async('arraybuffer').then(function (buf) {
            images[name] = new Blob([buf], { type: 'image/jpeg' });
          }));
        });
        return Promise.all(jobs).then(function () {
          return { setting: setting, entries: entries, images: images };
        });
      });
    });
  }

  /**
   * ZIP を作る。
   * @param setting { password, name, message, randoms[] }
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
    var dir = zip.folder('DIARY_BOOK_IMAGE');
    entries.forEach(function (e) {
      e.images.forEach(function (img) { dir.file(img.name, img.blob, { compression: 'STORE' }); });
    });
    return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' });
  }

  window.DiaryZip = { ZIP_NAME: ZIP_NAME, read: read, write: write };
})();
