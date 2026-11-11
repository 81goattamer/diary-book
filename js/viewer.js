/* 閲覧用アプリ「diary book」 */
(function () {
  'use strict';

  var D = DiaryDate;
  var $ = function (id) { return document.getElementById(id); };

  var DB_NAME = 'diarybook-viewer';
  /**
   * 確認用モード（作成用アプリの「本番環境で確認」から iframe で開く。URL に ?preview=1）。
   * データは作成用アプリから postMessage で受け取り、端末には保存しない。
   * パスワードなし・アニメーションなし（めくりは一瞬で切り替える）。
   */
  var PREVIEW = /[?&]preview=1(&|$)/.test(location.search) && window.parent !== window;
  var FLIP_MS = 650;          // 通常のページめくり
  var COVER_MS = 1000;        // 本の開閉
  var PARA_MS = 150;          // パラパラめくり1枚あたり
  var PARA_TOTAL_MS = 2000;   // パラパラめくり全体の上限
  var EASE = 'cubic-bezier(.42,.08,.3,1)';
  var EASE_IN = 'cubic-bezier(.45,0,1,1)';   // 表紙を開いてそのままめくりに続けるとき（最後に減速しない）
  var EASE_OUT = 'cubic-bezier(0,0,.3,1)';   // パラパラめくりの最後の1枚（ゆっくり止まる）
  var OPEN_INTO_FLIP_MS = 700;                // パラパラめくりに続くときの表紙の開き
  var LAST_FLIP_MS = 300;                     // パラパラめくりの最後の1枚

  var TEXT = {
    choose: '日付を選んでください',
    wrongPw: 'パスワードが違います',
    confirmReplace: '今のデータを置き換えます。よろしいですか？',
    confirmDelete: 'すべてのデータを削除します。よろしいですか？',
    saveFailed: 'データを保存できませんでした。端末の空き容量を確認してください。'
  };

  var el = {
    book: $('book'),
    inner: $('bookInner'),
    left: $('slotLeft'),
    right: $('slotRight'),
    loadPanel: $('loadPanel'),
    dropzone: $('dropzone'),
    loadInput: $('loadInput'),
    loadError: $('loadError'),
    pwPanel: $('pwPanel'),
    pwInput: $('pwInput'),
    pwError: $('pwError'),
    prev: $('prevBtn'),
    next: $('nextBtn'),
    sound: $('soundBtn'),
    reimport: $('reimportInput')
  };

  var state = {
    db: null,
    data: null,          // { setting, entries, byDate, tags, urls }
    authed: false,       // 認証状態は保存しない（再読み込みで未認証に戻る）
    showPw: false,
    spreads: [{ kind: 'cover' }],
    index: 0,
    busy: false,
    selected: null,      // 右ページに表示している日（YYYYMMDD）
    photoIdx: 0,
    tagFilter: [],
    popover: null,       // 'month' | 'tag' | null
    settingMsg: '',
    bh: 560              // 本の高さ（px）。layout() で決める
  };

  /* ---------- 紙・革の質感を画像にしておく ----------
   * 質感は CSS 変数の SVG（feTurbulence のフィルタ）で描いている。SVG のままだと、ページを作るたび・
   * めくるたびにフィルタを計算し直して重い（特に iPad）。起動時に1回だけ画像（PNG）に焼いて差し替える。
   * 焼けないときは SVG のまま使う。 */

  function bakeTextures() {
    var root = document.documentElement;
    var cs = getComputedStyle(root);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    // 細かい粒（タイル）は画面の解像度で、ぼんやりした模様（引き伸ばす）は等倍で焼く
    [['--grain-leather', dpr], ['--grain-paper', dpr], ['--mottle-leather', 1], ['--stain-paper', 1]].forEach(function (v) {
      var m = /url\("(data:image\/svg\+xml,[^"]*)"\)/.exec(cs.getPropertyValue(v[0]));
      if (!m) return;
      var src = m[1];
      var size = /width='(\d+)'/.exec(decodeURIComponent(src));
      if (!size) return;
      var px = Math.round(Number(size[1]) * v[1]);
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = px;
          c.height = px;
          c.getContext('2d').drawImage(img, 0, 0, px, px);
          c.toBlob(function (blob) {
            if (blob) root.style.setProperty(v[0], 'url("' + URL.createObjectURL(blob) + '")');
          }, 'image/png');
        } catch (e) { /* SVG のまま */ }
      };
      img.src = src;
    });
  }

  /* ---------- 小さな DOM ヘルパー ---------- */

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') e.className = v;
        else e.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(e, arguments[i]);
    return e;
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(parent, c); }); return; }
    parent.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }

  function setChild(slot, node) {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    if (node) slot.appendChild(node);
  }

  /* ---------- データ ---------- */

  function buildData(setting, entries, images) {
    var urls = {};
    Object.keys(images).forEach(function (name) {
      if (images[name] instanceof Blob) urls[name] = URL.createObjectURL(images[name]);
    });
    var byDate = {};
    var tags = [];
    entries.forEach(function (e) {
      byDate[e.date] = e;
      e.tags.forEach(function (t) { if (tags.indexOf(t) === -1) tags.push(t); });
    });
    return { setting: setting, entries: entries, byDate: byDate, tags: tags, urls: urls };
  }

  function setData(data) {
    if (state.data) Object.keys(state.data.urls).forEach(function (k) { URL.revokeObjectURL(state.data.urls[k]); });
    state.data = data;
    state.authed = false;
    state.showPw = false;
    state.tagFilter = [];
    state.popover = null;
    state.settingMsg = '';
    buildSpreads();
  }

  /** 月ページの範囲（4.1） */
  function monthList() {
    var todayM = D.monthOf(D.today());
    var es = state.data.entries;
    if (!es.length) return [todayM];
    var start = D.monthOf(es[0].date);
    var end = D.monthOf(es[es.length - 1].date);
    if (start > todayM) start = todayM;
    if (end < todayM) end = todayM;
    return D.monthRange(start, end);
  }

  function buildSpreads() {
    state.spreads = [{ kind: 'cover' }];
    if (!state.data) return;
    monthList().forEach(function (ym) { state.spreads.push({ kind: 'month', ym: ym }); });
    state.spreads.push({ kind: 'message' }, { kind: 'settings' });
  }

  function indexOfMonth(ym) {
    for (var i = 0; i < state.spreads.length; i++) {
      if (state.spreads[i].kind === 'month' && state.spreads[i].ym === ym) return i;
    }
    return -1;
  }

  function firstDiaryDay(ym) {
    var es = state.data.entries;
    for (var i = 0; i < es.length; i++) if (D.monthOf(es[i].date) === ym) return es[i].date;
    return null;
  }

  /** 画像は「YYYYMMDD/ファイル名」で探す。前の形式で保存したデータ（ファイル名だけ）も見る */
  function photosOf(entry) {
    var urls = state.data.urls;
    return entry.images.map(function (n) { return urls[DiaryZip.imageKey(entry.date, n)] || urls[n]; })
      .filter(function (u) { return !!u; });
  }

  function matchesFilter(entry) {
    if (!state.tagFilter.length) return true;
    return entry.tags.some(function (t) { return state.tagFilter.indexOf(t) !== -1; });
  }

  /** 日付を選ぶ。日記がない日は選ばない（何も選んでいない状態にする） */
  function select(date) {
    state.selected = date && state.data.byDate[date] ? date : null;
    state.photoIdx = 0;
  }

  /** 見開きを表示する前の準備。月ページは selectDate（省略時はその月で日記がある最初の日）を選ぶ */
  function prepare(index, selectDate) {
    var sp = state.spreads[index];
    state.popover = null;
    state.settingMsg = '';
    if (sp.kind === 'month') select(selectDate !== undefined ? selectDate : firstDiaryDay(sp.ym));
  }

  /* ---------- 描画 ---------- */

  function half(side, content) {
    return h('div', { class: 'half half-' + side }, h('div', { class: 'paper' }, content));
  }

  /** 見開きを作る。only（'left' / 'right'）を指定したときは、その側だけ作る */
  function render(sp, only) {
    var L = only !== 'right';
    var R = only !== 'left';
    switch (sp.kind) {
      case 'cover': return { left: null, right: R ? renderCover() : null };
      case 'month': return { left: L ? half('left', renderCalendar(sp.ym)) : null, right: R ? half('right', renderDiary()) : null };
      case 'message': return { left: L ? half('left', renderMessage()) : null, right: R ? half('right', renderMessage()) : null };
      default: return { left: L ? half('left', renderSettingsLeft()) : null, right: R ? half('right', renderSettingsRight()) : null };
    }
  }

  function renderCover() {
    var name = state.data && state.data.setting.name ? state.data.setting.name : 'diary book';
    return h('div', { class: 'half half-right cover', 'data-action': 'cover' },
      h('div', { class: 'cover-frame' },
        h('div', { class: 'cover-title' }, name),
        h('div', { class: 'cover-rule' })));
  }

  function renderCalendar(ym) {
    var p = D.parse(ym);
    var n = state.tagFilter.length;
    var inner = h('div', { class: 'page-inner cal' },
      h('div', { class: 'cal-head' },
        h('button', { class: 'cal-month', type: 'button', 'data-action': 'month-picker' },
          D.formatMonth(ym), h('span', { class: 'caret' }, '▼')),
        h('button', { class: 'chip-btn' + (n ? ' active' : ''), type: 'button', 'data-action': 'tag-picker' },
          n ? 'タグ選択（' + n + '）' : 'タグ選択')),
      h('div', { class: 'cal-week' }, D.WEEK.map(function (w) { return h('span', null, w); })));

    var grid = h('div', { class: 'cal-grid' });
    var first = D.firstWeekday(p.y, p.m);
    for (var b = 0; b < first; b++) grid.appendChild(h('span'));
    var days = D.daysInMonth(p.y, p.m);
    for (var d = 1; d <= days; d++) {
      var date = D.ymd(p.y, p.m, d);
      var entry = state.data.byDate[date];
      var on = !!entry && matchesFilter(entry);
      grid.appendChild(h('button', {
        class: 'day ' + (on ? 'on' : 'off') + (entry ? '' : ' none') + (date === state.selected ? ' selected' : ''),
        type: 'button', 'data-action': 'day', 'data-date': date
      }, d));
    }
    inner.appendChild(grid);

    if (state.popover === 'month') inner.appendChild(renderMonthPopover(ym));
    if (state.popover === 'tag') inner.appendChild(renderTagPopover());
    return inner;
  }

  function renderMonthPopover(current) {
    var months = state.spreads.filter(function (s) { return s.kind === 'month'; }).map(function (s) { return s.ym; });
    return h('div', { class: 'popover' },
      h('p', { class: 'popover-title' }, '月を選ぶ'),
      h('div', { class: 'month-list' }, months.map(function (ym) {
        return h('button', { class: 'chip-btn' + (ym === current ? ' active' : ''), type: 'button', 'data-action': 'goto-month', 'data-ym': ym }, D.formatMonth(ym));
      })),
      h('div', { class: 'popover-foot' }, h('button', { class: 'chip-btn', type: 'button', 'data-action': 'close-popover' }, '閉じる')));
  }

  function renderTagPopover() {
    var tags = state.data.tags;
    return h('div', { class: 'popover' },
      h('p', { class: 'popover-title' }, 'タグを選ぶ（複数選べます）'),
      tags.length
        ? h('div', { class: 'tag-list' }, tags.map(function (t) {
          var on = state.tagFilter.indexOf(t) !== -1;
          return h('button', { class: 'chip-btn' + (on ? ' active' : ''), type: 'button', 'data-action': 'toggle-tag', 'data-tag': t }, t);
        }))
        : h('p', { class: 'popover-empty' }, 'タグはありません'),
      h('div', { class: 'popover-foot' }, h('button', { class: 'chip-btn', type: 'button', 'data-action': 'close-popover' }, '閉じる')));
  }

  function renderDiary() {
    var inner = h('div', { class: 'page-inner diary' });
    var date = state.selected;
    if (!date) {
      inner.appendChild(h('div', { class: 'diary-empty' }, h('p', { class: 'diary-note' }, TEXT.choose)));
      return inner;
    }
    var entry = state.data.byDate[date];
    var scroll = h('div', { class: 'diary-scroll' }, h('div', { class: 'diary-date' }, D.formatDate(date)));
    if (entry.title) scroll.appendChild(h('h2', { class: 'diary-title' }, entry.title));
    if (entry.tags.length) scroll.appendChild(h('div', { class: 'diary-tags' }, entry.tags.map(function (t) { return h('span', { class: 'tag' }, t); })));
    var photos = photosOf(entry);
    if (photos.length) {
      var idx = Math.min(state.photoIdx, photos.length - 1);
      var box = h('div', { class: 'photo' }, h('img', { src: photos[idx], alt: '', draggable: 'false', decoding: 'async' }));
      if (photos.length > 1) {
        box.appendChild(h('button', { class: 'photo-nav photo-prev', type: 'button', 'data-action': 'photo-prev', 'aria-label': '前の写真' }, '‹'));
        box.appendChild(h('button', { class: 'photo-nav photo-next', type: 'button', 'data-action': 'photo-next', 'aria-label': '次の写真' }, '›'));
      }
      // 右下の拡大ボタン：その日の写真を画面いっぱいで見る
      var zoom = h('button', { class: 'photo-zoom', type: 'button', 'data-action': 'photo-zoom', 'aria-label': '写真を拡大', title: '写真を拡大' });
      zoom.innerHTML = ZOOM_ICON;
      box.appendChild(zoom);
      scroll.appendChild(box);
    }
    if (entry.contents) scroll.appendChild(h('div', { class: 'diary-body' }, entry.contents));
    inner.appendChild(scroll);
    return inner;
  }

  function renderMessage() {
    return h('div', { class: 'spread-wide' }, h('div', { class: 'message-text' }, state.data.setting.message || ''));
  }

  function soundLabel() { return DiarySound.isOn() ? 'ON' : 'OFF'; }

  function renderSettingsLeft() {
    return h('div', { class: 'page-inner' },
      h('h2', { class: 'settings-title' }, '設定'),
      h('div', { class: 'setting-row' },
        h('h3', null, '効果音'),
        h('p', null, 'ページをめくるときに音を鳴らします。'),
        h('button', { class: 'chip-btn' + (DiarySound.isOn() ? ' active' : ''), type: 'button', 'data-action': 'sound' }, '効果音：' + soundLabel())));
  }

  function renderSettingsRight() {
    return h('div', { class: 'page-inner' },
      h('div', { class: 'setting-row' },
        h('h3', null, 'データの再インポート'),
        h('p', null, '新しい日記データの ZIP を読み込み、今のデータと置き換えます。'),
        h('button', { class: 'btn', type: 'button', 'data-action': 'reimport' }, 'ZIP を選ぶ')),
      h('div', { class: 'setting-row' },
        h('h3', null, 'データの削除'),
        h('p', null, 'この端末に保存した日記データをすべて削除します。'),
        h('button', { class: 'btn btn-danger', type: 'button', 'data-action': 'delete' }, '削除する')),
      state.settingMsg ? h('p', { class: 'setting-msg' }, state.settingMsg) : null);
  }

  /** 今の見開きをアニメーションなしで描き直す */
  function show(index) {
    state.index = index;
    var r = render(state.spreads[index]);
    setChild(el.left, r.left);
    setChild(el.right, r.right);
    el.inner.classList.toggle('closed', state.spreads[index].kind === 'cover');
    updateChrome();
  }

  function refreshSide(side) {
    var r = render(state.spreads[state.index], side);
    if (side !== 'right') setChild(el.left, r.left);
    if (side !== 'left') setChild(el.right, r.right);
  }

  function updateChrome() {
    var kind = state.spreads[state.index].kind;
    el.prev.hidden = kind === 'cover';
    el.next.hidden = kind === 'cover' || kind === 'settings';
    var loadHidden = !(kind === 'cover' && !state.data);
    if (el.loadPanel.hidden !== loadHidden) {
      el.loadPanel.hidden = loadHidden;
      layout(); // 読み込み欄の有無で本の大きさが変わる
    }
    el.pwPanel.hidden = !(kind === 'cover' && state.data && !state.authed && state.showPw);
    el.sound.textContent = '♪ 音 ' + soundLabel();
    el.sound.setAttribute('aria-pressed', DiarySound.isOn() ? 'true' : 'false');
  }

  /* ---------- ページめくり ---------- */

  /**
   * target の見開きへ1枚めくる。表紙が絡むときは本の開閉になる。
   * opt: { duration, easing, sound(秒), select(YYYYMMDD) }
   */
  function flip(target, opt) {
    opt = opt || {};
    if (PREVIEW) {
      // 確認用モードはアニメーション・効果音なしで切り替える
      prepare(target, opt.select);
      show(target);
      return Promise.resolve();
    }
    var from = state.index;
    var dir = target > from ? 1 : -1;
    var coverFrom = state.spreads[from].kind === 'cover';
    var coverTo = state.spreads[target].kind === 'cover';
    var withCover = coverFrom || coverTo;
    var dur = opt.duration || (withCover ? COVER_MS : FLIP_MS);

    prepare(target, opt.select);
    var next = render(state.spreads[target]);

    // 右ページをめくる（次へ）：表は今の右ページ、裏は次の左ページ。下からは次の右ページが見え、葉は左に着く。
    // 左ページを戻す（前へ）：表は今の左ページ、裏は前の右ページ。下からは前の左ページが見え、葉は右に着く。
    var turning = dir > 0 ? el.right : el.left;       // めくれるページがある側
    var landing = dir > 0 ? el.left : el.right;       // 葉が着く側
    var under = dir > 0 ? next.right : next.left;     // めくると下から見えるページ
    var landed = dir > 0 ? next.left : next.right;    // 葉の裏に出て、最後に着くページ

    // 葉には今のページ・次のページの「写し」を貼る。本物のページは、葉の描画が済んでから入れ替える。
    // 同じ瞬間に入れ替えると、iPad では葉の描画が1コマ遅れて下のページが一瞬見える（点滅する）
    var front = h('div', { class: 'face face-front' });
    var back = h('div', { class: 'face face-back' });
    var current = turning.firstElementChild;
    if (current) front.appendChild(copyPage(current));
    if (landed) back.appendChild(copyPage(landed));
    var leaf = h('div', { class: 'leaf ' + (dir > 0 ? 'leaf-right' : 'leaf-left') }, front, back);
    el.inner.appendChild(leaf);
    copyScroll(current, front.firstElementChild);
    state.index = target;

    var anims = [];
    return whenPainted(leaf).then(function () {
      setChild(turning, under); // 葉に隠れているので、ここで入れ替えても見えない
      if (!withCover) DiarySound.flip(opt.sound || 0.4);

      var persp = state.bh * 4; // 本の高さは layout() で決めた値を使う（DOM から読むと、作ったばかりのページの計算を待つことになる）
      var timing = { duration: dur, easing: opt.easing || EASE, fill: 'forwards' };
      anims.push(leaf.animate([
        { transform: 'perspective(' + persp + 'px) rotateY(0deg)' },
        { transform: 'perspective(' + persp + 'px) rotateY(' + (dir > 0 ? -180 : 180) + 'deg)' }
      ], timing));
      // 表と裏は、回転がちょうど半分（90°）になったところで切り替える。
      // Safari では backface-visibility が一瞬効かず、裏の面が左右反転して見えることがあるため、CSS だけに任せない
      anims.push(front.animate([{ visibility: 'visible' }, { visibility: 'hidden' }], timing));
      anims.push(back.animate([{ visibility: 'hidden' }, { visibility: 'visible' }], timing));

      if (withCover) {
        // 閉じた本は右半分（表紙）が画面中央に来るよう左へずらしてある
        el.inner.classList.remove('closed');
        anims.push(el.inner.animate([
          { transform: coverFrom ? 'translateX(-25%)' : 'translateX(0)' },
          { transform: coverTo ? 'translateX(-25%)' : 'translateX(0)' }
        ], timing));
      }
      return Promise.all(anims.map(function (a) { return a.finished; }));
    }).then(function () {
      // 着いた葉の下に本物のページを置き、描画が済んでから葉を外す
      setChild(landing, landed);
      return whenPainted(landing);
    }).then(function () {
      leaf.remove();
      el.inner.classList.toggle('closed', coverTo);
      anims.forEach(function (a) { a.cancel(); });
      updateChrome();
    });
  }

  /** めくる葉に貼るページの写し */
  function copyPage(page) {
    return page.cloneNode(true);
  }

  /** 写しの日記の文章を、元のページと同じスクロール位置にする（写しが画面に入ってから呼ぶ） */
  function copyScroll(page, copy) {
    if (!page || !copy) return;
    var from = page.querySelectorAll('.diary-scroll');
    var to = copy.querySelectorAll('.diary-scroll');
    for (var i = 0; i < to.length && i < from.length; i++) {
      if (from[i].scrollTop) to[i].scrollTop = from[i].scrollTop;
    }
  }

  /** node の中の写真が読み込まれ、画面に2回描かれる（＝描画が済む）まで待つ。止まらないよう 300ms で打ち切る */
  function whenPainted(node) {
    var imgs = node ? Array.prototype.slice.call(node.querySelectorAll('img')) : [];
    var decoded = Promise.all(imgs.map(function (img) {
      return img.decode ? img.decode().catch(function () {}) : null;
    }));
    var painted = decoded.then(function () {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(resolve); });
      });
    });
    var limit = new Promise(function (resolve) { setTimeout(resolve, 300); });
    return Promise.race([painted, limit]);
  }

  /** めくっている途中の操作は無視する */
  function run(task) {
    if (state.busy) return;
    state.busy = true;
    updateChrome();
    Promise.resolve().then(task).catch(function (e) { console.error(e); }).then(function () {
      state.busy = false;
      updateChrome();
    });
  }

  /**
   * パスワード入力後：本を開き、止まらずにそのまま開始月から今日の月までパラパラとめくる。
   * 表紙は加速しながら開き（最後に減速しない）、めくりは一定の速さ、今日の月の1枚だけ減速して止まる。
   */
  function openWithFlipThrough() {
    var today = D.today();
    var todayIdx = indexOfMonth(D.monthOf(today));
    var count = todayIdx - 1;
    if (count <= 0) return flip(1, { select: today });

    var per = Math.min(PARA_MS, PARA_TOTAL_MS / count);
    var chain = flip(1, { duration: OPEN_INTO_FLIP_MS, easing: EASE_IN });
    for (var i = 2; i <= todayIdx; i++) {
      (function (i) {
        var last = i === todayIdx;
        chain = chain.then(function () {
          return flip(i, {
            duration: last ? Math.max(per, LAST_FLIP_MS) : per,
            easing: last ? EASE_OUT : 'linear',
            sound: Math.max(0.05, per / 1000),
            select: last ? today : undefined
          });
        });
      })(i);
    }
    return chain;
  }

  /* ---------- 操作 ---------- */

  var actions = {
    cover: function () {
      if (!state.data) return;
      if (state.authed) { run(function () { return flip(1); }); return; }
      state.showPw = true;
      el.pwError.hidden = true;
      updateChrome();
      el.pwInput.focus();
    },
    'month-picker': function () {
      state.popover = state.popover === 'month' ? null : 'month';
      refreshSide('left');
    },
    'tag-picker': function () {
      state.popover = state.popover === 'tag' ? null : 'tag';
      refreshSide('left');
    },
    'close-popover': function () {
      state.popover = null;
      refreshSide('left');
    },
    'toggle-tag': function (t) {
      var tag = t.getAttribute('data-tag');
      var i = state.tagFilter.indexOf(tag);
      if (i === -1) state.tagFilter.push(tag); else state.tagFilter.splice(i, 1);
      refreshSide('left');
    },
    'goto-month': function (t) {
      var target = indexOfMonth(t.getAttribute('data-ym'));
      state.popover = null;
      if (target === -1 || target === state.index) { refreshSide('left'); return; }
      run(function () { return flip(target); });
    },
    day: function (t) {
      var date = t.getAttribute('data-date');
      if (!state.data.byDate[date]) return; // 日記がない日は押しても何もしない
      select(date);
      // カレンダーは作り直さず、選んだ日の枠だけ付け替える。右ページ（日記）だけ描き直す
      Array.prototype.forEach.call(el.left.querySelectorAll('.day.selected'), function (b) { b.classList.remove('selected'); });
      t.classList.add('selected');
      refreshSide('right');
    },
    'photo-prev': function () { stepPhoto(-1); },
    'photo-next': function () { stepPhoto(1); },
    'photo-zoom': function () { openLightbox(); },
    sound: function () { DiarySound.toggle(); },
    reimport: function () { el.reimport.value = ''; el.reimport.click(); },
    delete: function () {
      if (!window.confirm(TEXT.confirmDelete)) return;
      var job = state.db ? state.db.clearAll() : Promise.resolve();
      job.then(function () {
        setData(null);
        show(0);
      }).catch(function () {
        state.settingMsg = 'データを削除できませんでした。';
        refreshSide('right');
      });
    }
  };

  function stepPhoto(step) {
    var entry = state.data.byDate[state.selected];
    if (!entry) return;
    var photos = photosOf(entry);
    if (photos.length < 2) return;
    state.photoIdx = (state.photoIdx + step + photos.length) % photos.length;
    var img = el.right.querySelector('.photo img');
    if (img) img.src = photos[state.photoIdx];
  }

  /* ---------- 写真の拡大表示 ---------- */

  var ZOOM_ICON = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

  var lb = null; // { root, img, count, photos, idx }

  /** 今表示している日の写真を、今の写真から画面いっぱいで表示する */
  function openLightbox() {
    var entry = state.data && state.data.byDate[state.selected];
    if (!entry || lb) return;
    var photos = photosOf(entry);
    if (!photos.length) return;
    var img = h('img', { class: 'lightbox-img', alt: '', draggable: 'false' });
    var count = h('div', { class: 'lightbox-count' });
    var root = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '写真の拡大表示' },
      img, count,
      h('button', { class: 'lightbox-close', type: 'button', 'data-lb': 'close', 'aria-label': '閉じる' }, '×'));
    if (photos.length > 1) {
      root.appendChild(h('button', { class: 'lightbox-nav lightbox-prev', type: 'button', 'data-lb': 'prev', 'aria-label': '前の写真' }, '‹'));
      root.appendChild(h('button', { class: 'lightbox-nav lightbox-next', type: 'button', 'data-lb': 'next', 'aria-label': '次の写真' }, '›'));
    }
    lb = { root: root, img: img, count: count, photos: photos, idx: Math.min(state.photoIdx, photos.length - 1), sx: null };
    showLightboxPhoto();

    root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-lb]');
      if (t) {
        var a = t.getAttribute('data-lb');
        if (a === 'close') closeLightbox();
        else stepLightbox(a === 'next' ? 1 : -1);
        return;
      }
      if (e.target === root) closeLightbox(); // 写真の外（暗いところ）を押したら閉じる
    });
    // 左右にスワイプしても前後の写真へ
    root.addEventListener('pointerdown', function (e) { lb.sx = e.clientX; });
    root.addEventListener('pointerup', function (e) {
      if (lb.sx === null) return;
      var dx = e.clientX - lb.sx;
      lb.sx = null;
      if (Math.abs(dx) > 50 && lb.photos.length > 1) stepLightbox(dx < 0 ? 1 : -1);
    });
    document.body.appendChild(root);
    root.querySelector('.lightbox-close').focus();
  }

  function showLightboxPhoto() {
    lb.img.src = lb.photos[lb.idx];
    lb.count.textContent = lb.photos.length > 1 ? (lb.idx + 1) + ' / ' + lb.photos.length : '';
  }

  function stepLightbox(step) {
    if (lb.photos.length < 2) return;
    lb.idx = (lb.idx + step + lb.photos.length) % lb.photos.length;
    showLightboxPhoto();
  }

  /** 閉じたら、本の写真も拡大で最後に見ていた写真にそろえる */
  function closeLightbox() {
    if (!lb) return;
    state.photoIdx = lb.idx;
    var img = el.right.querySelector('.photo img');
    if (img) img.src = lb.photos[lb.idx];
    lb.root.remove();
    lb = null;
  }

  document.addEventListener('keydown', function (e) {
    if (!lb) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowRight') stepLightbox(1);
    else if (e.key === 'ArrowLeft') stepLightbox(-1);
  });

  /* ---------- めくる操作：矢印ボタン・ページの端を押す・長押ししてスライド ---------- */

  var EDGE = 0.1;            // 本の左右それぞれ幅の 10% を「ページの端」とする
  var HOLD_MS = 300;         // 長押しと判定するまでの時間
  var HOLD_SLOP = 10;        // 長押し中に動いてもよい距離（px）
  var SWIPE_PX = 40;         // 長押し後、この距離だけ横に動かしたらめくる

  function canPrev() { return !state.busy && state.index > 0; }
  function canNext() { return !state.busy && state.index > 0 && state.index < state.spreads.length - 1; }
  function goPrev() { if (canPrev()) run(function () { return flip(state.index - 1); }); }
  function goNext() { if (canNext()) run(function () { return flip(state.index + 1); }); }

  /** 本の中での横位置（0〜1） */
  function bookX(clientX) {
    var r = el.book.getBoundingClientRect();
    return (clientX - r.left) / r.width;
  }

  var drag = null;          // 長押しスライドの状態 { id, x, y, timer, held, done }
  var suppressClick = false; // 長押しスライドの直後のクリックは無視する

  el.inner.addEventListener('click', function (e) {
    if (suppressClick) { suppressClick = false; return; }
    var t = e.target.closest('[data-action]');
    if (t) {
      if (state.busy) return;
      var fn = actions[t.getAttribute('data-action')];
      if (fn) fn(t);
      return;
    }
    // ボタンなどがない場所で、ページの左端・右端を押したらめくる
    if (state.spreads[state.index].kind === 'cover') return;
    if (e.target.closest('button, input, textarea, a, .popover')) return;
    var x = bookX(e.clientX);
    if (x < EDGE) goPrev();
    else if (x > 1 - EDGE) goNext();
  });

  el.inner.addEventListener('pointerdown', function (e) {
    if (drag || state.busy || state.spreads[state.index].kind === 'cover') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, held: false, swipe: false, done: false };
    drag.timer = setTimeout(function () {
      if (!drag) return;
      drag.held = true;
      el.book.classList.add('holding');
    }, HOLD_MS);
  });

  el.inner.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id || drag.done) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.held && !drag.swipe) {
      if (Math.abs(dx) <= HOLD_SLOP && Math.abs(dy) <= HOLD_SLOP) return;
      // 長押しの前に動いたとき：指（タッチ・ペン）で横向きに動かしたらスワイプとしてめくる。
      // 縦向き（スクロール）やマウスでのドラッグ（文字の選択など）はめくらない
      if (e.pointerType !== 'mouse' && Math.abs(dx) > Math.abs(dy)) {
        clearTimeout(drag.timer);
        drag.swipe = true;
      } else {
        endDrag();
        return;
      }
    }
    e.preventDefault();
    if (Math.abs(dx) < SWIPE_PX) return;
    if (drag.swipe && Math.abs(dx) < Math.abs(dy) * 1.5) { endDrag(); return; } // 斜めすぎるものはめくらない
    drag.done = true;
    suppressClick = true;
    el.book.classList.remove('holding');
    if (dx < 0) goNext(); else goPrev(); // 左へスライドで次へ、右へスライドで前へ
  });

  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.held || drag.swipe) suppressClick = true; // 長押し・スワイプしただけで離したときも、クリック扱いにしない
    drag = null;
    el.book.classList.remove('holding');
    setTimeout(function () { suppressClick = false; }, 0);
  }

  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
    el.inner.addEventListener(t, function (e) { if (drag && e.pointerId === drag.id) endDrag(); });
  });

  // マウスでページの端に乗ったら、押せることが分かるよう指のカーソルにする
  el.inner.addEventListener('mousemove', function (e) {
    var edge = false;
    if (state.spreads[state.index].kind !== 'cover' && !e.target.closest('button, input, textarea, a, .popover')) {
      var x = bookX(e.clientX);
      edge = (x < EDGE && state.index > 0) || (x > 1 - EDGE && state.index < state.spreads.length - 1);
    }
    el.inner.style.cursor = edge ? 'pointer' : '';
  });

  // 長押し中に文字選択やメニューが出ないようにする
  el.inner.addEventListener('contextmenu', function (e) { if (drag) e.preventDefault(); });
  el.inner.addEventListener('selectstart', function (e) { if (drag && drag.held) e.preventDefault(); });

  el.prev.addEventListener('click', goPrev);
  el.next.addEventListener('click', goNext);

  el.sound.addEventListener('click', function () { DiarySound.toggle(); });

  DiarySound.onChange(function () {
    updateChrome();
    if (state.spreads[state.index].kind === 'settings' && !state.busy) refreshSide('left');
  });

  el.pwPanel.addEventListener('submit', function (e) {
    e.preventDefault();
    if (state.busy || !state.data) return;
    if (el.pwInput.value === state.data.setting.password) {
      el.pwInput.value = '';
      el.pwInput.blur();
      el.pwError.hidden = true;
      state.authed = true;
      state.showPw = false;
      run(openWithFlipThrough);
    } else {
      el.pwError.textContent = TEXT.wrongPw;
      el.pwError.hidden = false;
      el.pwInput.value = '';
      el.pwInput.focus();
    }
  });

  /* ---------- ZIP の読み込み ---------- */

  /** ZIP を読んで保存する。失敗時はメッセージ付きで reject（保存はしない） */
  function importZip(file) {
    return DiaryZip.read(file).then(function (parsed) {
      var images = {};
      Object.keys(parsed.images).forEach(function (k) { if (parsed.images[k] instanceof Blob) images[k] = parsed.images[k]; });
      parsed.images = images;
      return parsed;
    });
  }

  function persist(parsed) {
    if (!state.db) return Promise.resolve();
    return state.db.replaceAll({
      kv: { setting: parsed.setting, entries: parsed.entries },
      images: parsed.images
    }).then(function () { DiaryStorage.requestPersist(); }, function () { throw new Error(TEXT.saveFailed); });
  }

  function errorText(e) {
    return e && e.name === 'DiaryFormatError' ? e.message : (e && e.message) || 'ZIP を読み込めませんでした';
  }

  function loadFromCover(file) {
    if (!file || state.busy) return;
    el.loadError.hidden = true;
    importZip(file).then(function (parsed) {
      return persist(parsed).then(function () {
        setData(buildData(parsed.setting, parsed.entries, parsed.images));
        state.showPw = true;
        show(0);
        el.pwError.hidden = true;
        el.pwInput.focus();
      });
    }).catch(function (e) {
      el.loadError.textContent = errorText(e);
      el.loadError.hidden = false;
    });
  }

  el.loadInput.addEventListener('change', function () {
    loadFromCover(el.loadInput.files[0]);
    el.loadInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (t) {
    el.dropzone.addEventListener(t, function (e) { e.preventDefault(); el.dropzone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    el.dropzone.addEventListener(t, function () { el.dropzone.classList.remove('dragover'); });
  });
  el.dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) loadFromCover(e.dataTransfer.files[0]);
  });
  // ドロップ欄の外に落としたときにブラウザが ZIP を開かないようにする
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  el.reimport.addEventListener('change', function () {
    var file = el.reimport.files[0];
    el.reimport.value = '';
    if (!file) return;
    importZip(file).then(function (parsed) {
      if (!window.confirm(TEXT.confirmReplace)) return;
      return persist(parsed).then(function () {
        setData(buildData(parsed.setting, parsed.entries, parsed.images));
        show(0);
      });
    }).catch(function (e) {
      state.settingMsg = errorText(e);
      if (state.spreads[state.index].kind === 'settings') refreshSide('right');
    });
  });

  /* ---------- 画面サイズ ---------- */

  function layout() {
    var W = window.innerWidth;
    var H = window.innerHeight;
    var bh, top;
    if (!el.loadPanel.hidden) {
      // 表紙の下に ZIP の読み込み欄を出すときは、その分だけ本を小さくして上に寄せる
      bh = Math.floor(Math.min(H * 0.76, (W - 130) / 1.44));
      top = Math.max(8, Math.round((H - bh) / 2 - H * 0.07));
    } else {
      // 画面いっぱいに、上下中央に置く（左右は矢印、上は「音」ボタンの分だけ空ける）
      bh = Math.floor(Math.min(H - 120, (W - 130) / 1.44));
      top = Math.round((H - bh) / 2);
    }
    state.bh = bh;
    document.documentElement.style.setProperty('--bh', bh + 'px');
    document.documentElement.style.setProperty('--book-top', top + 'px');
  }

  window.addEventListener('resize', layout);

  /* ---------- 起動 ---------- */

  function loadSaved(db) {
    return Promise.all([db.get('kv', 'setting'), db.get('kv', 'entries'), db.getAllKeys('images'), db.getAll('images')])
      .then(function (r) {
        if (!r[0] || !r[1]) return null;
        var images = {};
        r[2].forEach(function (k, i) { images[k] = r[3][i]; });
        return buildData(r[0], r[1], images);
      });
  }

  bakeTextures();
  layout();
  updateChrome();
  show(0);

  if (PREVIEW) {
    document.documentElement.classList.add('preview');
    window.addEventListener('message', function (e) {
      if (e.source !== window.parent || !e.data || e.data.type !== 'diary-preview') return;
      var d = e.data;
      setData(buildData(d.setting, d.entries, d.images));
      state.authed = true; // パスワードなし
      // 作成用で見ていた日付の月を、その日を選んだ状態で開く。
      // 指定がない・月の範囲外なら今日の月、それも範囲外なら開始月
      var day = d.date && D.isValid(d.date) ? d.date : D.today();
      var idx = indexOfMonth(D.monthOf(day));
      if (idx === -1) {
        day = D.today();
        idx = indexOfMonth(D.monthOf(day));
      }
      if (idx === -1) { idx = state.spreads.length > 1 ? 1 : 0; day = undefined; }
      prepare(idx, day);
      show(idx);
    });
    window.parent.postMessage({ type: 'diary-preview-ready' }, '*');
    return; // 確認用モードでは端末のデータを読み書きしない
  }

  DiaryStorage.open(DB_NAME, ['kv', 'images'])
    .then(function (db) {
      state.db = db;
      return loadSaved(db).catch(function () { return null; });
    }, function () { return null; })
    .then(function (data) {
      if (data) setData(data);
      show(0);
    });
})();
