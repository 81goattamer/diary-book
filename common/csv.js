/* 両アプリ共通：CSV の読み書き（PapaParse を使用）
 * 書き出し：UTF-8 BOM付き・CRLF・全項目をダブルクォートで囲む（RFC 4180）
 * 読み込み：BOM の有無、CRLF / LF のどちらにも対応 */
(function () {
  'use strict';

  var SETTING_FILE = 'DIARY_BOOK_SETTING.csv';
  var MST_FILE = 'DIARY_BOOK_MST.csv';
  var MST_HEADER = ['date', 'tag', 'title', 'contents', 'image'];

  function FormatError(message) {
    var e = new Error(message);
    e.name = 'DiaryFormatError';
    return e;
  }

  /** テキスト → 2次元配列。改行はすべて LF にそろえる（値の中の改行も LF になる） */
  function parseRows(text) {
    text = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var result = Papa.parse(text, { header: false, dynamicTyping: false, skipEmptyLines: true, newline: '\n' });
    var fatal = result.errors.filter(function (e) { return e.type === 'Quotes'; });
    if (fatal.length) throw FormatError('CSV の形式が正しくありません（ダブルクォートの対応が取れていません）');
    return result.data;
  }

  /** 2次元配列 → CSV テキスト（BOM付き・CRLF・全項目クォート） */
  function stringifyRows(rows) {
    return '﻿' + Papa.unparse(rows, { quotes: true, newline: '\r\n', header: false }) + '\r\n';
  }

  /** 'a;b;;c' → ['a','b','c']（前後の空白を除き、空要素は捨てる） */
  function splitList(s) {
    if (!s) return [];
    return String(s).split(';').map(function (v) { return v.trim(); }).filter(function (v) { return v !== ''; });
  }

  function joinList(list) { return (list || []).join(';'); }

  /** SETTING → { password, name, message }。前の形式（4列目にランダム文章）も読めるよう、4列なら4列目を捨てる */
  function parseSetting(text) {
    var rows = parseRows(text);
    if (rows.length < 1 || (rows[0].length !== 3 && rows[0].length !== 4)) {
      throw FormatError(SETTING_FILE + ' の形式が正しくありません（1行3列ではありません）');
    }
    var r = rows[0];
    return { password: r[0], name: r[1], message: r[2] };
  }

  function buildSetting(s) {
    return stringifyRows([[s.password || '', s.name || '', s.message || '']]);
  }

  /** MST → [{ date, tags[], title, contents, images[] }]（日付の昇順） */
  function parseMst(text) {
    var rows = parseRows(text);
    if (rows.length < 1) throw FormatError(MST_FILE + ' にヘッダー行がありません');
    var head = rows[0].map(function (v) { return String(v).trim(); });
    if (head.join(',') !== MST_HEADER.join(',')) {
      throw FormatError(MST_FILE + ' のヘッダー行が「' + MST_HEADER.join(',') + '」ではありません');
    }
    var seen = {};
    var entries = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (r.length !== 5) throw FormatError(MST_FILE + ' の ' + (i + 1) + ' 行目の列数が5ではありません');
      var date = String(r[0]).trim();
      if (!DiaryDate.isValid(date)) throw FormatError(MST_FILE + ' の ' + (i + 1) + ' 行目の日付「' + date + '」が YYYYMMDD 形式ではありません');
      if (seen[date]) throw FormatError(MST_FILE + ' で日付 ' + date + ' が重複しています');
      seen[date] = true;
      entries.push({ date: date, tags: splitList(r[1]), title: r[2], contents: r[3], images: splitList(r[4]) });
    }
    entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return entries;
  }

  /** entries（images はファイル名の配列）→ MST テキスト */
  function buildMst(entries) {
    var rows = [MST_HEADER.slice()];
    entries.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (e) {
      rows.push([e.date, joinList(e.tags), e.title || '', e.contents || '', joinList(e.images)]);
    });
    return stringifyRows(rows);
  }

  /**
   * CSV ファイル（File / Blob）をテキストにする。
   * UTF-8 として読めなければ Shift-JIS として読む（Excel で保存した CSV のため）。
   */
  function readText(file) {
    return file.arrayBuffer().then(function (buf) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (e) {
        try {
          return new TextDecoder('shift_jis').decode(buf);
        } catch (e2) {
          throw FormatError('CSV の文字コードを読み取れません（UTF-8 で保存してください）');
        }
      }
    });
  }

  window.DiaryCsv = {
    SETTING_FILE: SETTING_FILE,
    readText: readText,
    MST_FILE: MST_FILE,
    parseRows: parseRows,
    stringifyRows: stringifyRows,
    splitList: splitList,
    parseSetting: parseSetting,
    buildSetting: buildSetting,
    parseMst: parseMst,
    buildMst: buildMst,
    FormatError: FormatError
  };
})();
