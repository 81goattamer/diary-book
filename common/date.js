/* 両アプリ共通：日付（YYYYMMDD / YYYYMM 文字列）の処理
 * 日付の比較はすべて文字列で行い、Date はローカル時刻の取得と曜日計算にだけ使う。 */
(function () {
  'use strict';

  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** 年・月・日（数値）→ 'YYYYMMDD' */
  function ymd(y, m, d) { return String(y).padStart(4, '0') + pad2(m) + pad2(d); }

  /** 年・月（数値）→ 'YYYYMM' */
  function ym(y, m) { return String(y).padStart(4, '0') + pad2(m); }

  /** 端末のローカル時刻での今日 'YYYYMMDD' */
  function today() {
    var now = new Date();
    return ymd(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }

  /** 'YYYYMMDD' または 'YYYYMM' → { y, m, d } */
  function parse(s) {
    return { y: parseInt(s.slice(0, 4), 10), m: parseInt(s.slice(4, 6), 10), d: s.length >= 8 ? parseInt(s.slice(6, 8), 10) : 1 };
  }

  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }

  /** その月の1日の曜日（0=日曜） */
  function firstWeekday(y, m) { return new Date(y, m - 1, 1).getDay(); }

  /** 実在する日付の 'YYYYMMDD' か */
  function isValid(s) {
    if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return false;
    var p = parse(s);
    return p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= daysInMonth(p.y, p.m);
  }

  /** 'YYYYMMDD' → 'YYYYMM' */
  function monthOf(s) { return s.slice(0, 6); }

  /** 'YYYYMM' に n か月足す */
  function addMonths(s, n) {
    var p = parse(s);
    var idx = p.y * 12 + (p.m - 1) + n;
    return ym(Math.floor(idx / 12), (idx % 12) + 1);
  }

  /** 'YYYYMM' の from〜to（両端含む）の配列 */
  function monthRange(from, to) {
    var list = [];
    for (var cur = from; cur <= to; cur = addMonths(cur, 1)) list.push(cur);
    return list;
  }

  /** 'YYYYMM' → '2026年5月' */
  function formatMonth(s) {
    var p = parse(s);
    return p.y + '年' + p.m + '月';
  }

  /** 'YYYYMMDD' → '2026年5月6日（水）' */
  function formatDate(s) {
    var p = parse(s);
    var w = WEEK[new Date(p.y, p.m - 1, p.d).getDay()];
    return p.y + '年' + p.m + '月' + p.d + '日（' + w + '）';
  }

  window.DiaryDate = {
    WEEK: WEEK,
    ymd: ymd,
    ym: ym,
    today: today,
    parse: parse,
    daysInMonth: daysInMonth,
    firstWeekday: firstWeekday,
    isValid: isValid,
    monthOf: monthOf,
    addMonths: addMonths,
    monthRange: monthRange,
    formatMonth: formatMonth,
    formatDate: formatDate
  };
})();
