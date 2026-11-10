/* 閲覧用アプリ「diary book」 */
(function () {
  'use strict';

  var D = DiaryDate;
  var $ = function (id) { return document.getElementById(id); };

  var DB_NAME = 'diarybook-viewer';
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
    settingMsg: ''
  };

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

  function render(sp) {
    switch (sp.kind) {
      case 'cover': return { left: null, right: renderCover() };
      case 'month': return { left: half('left', renderCalendar(sp.ym)), right: half('right', renderDiary()) };
      case 'message': return { left: half('left', renderMessage()), right: half('right', renderMessage()) };
      default: return { left: half('left', renderSettingsLeft()), right: half('right', renderSettingsRight()) };
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
      var box = h('div', { class: 'photo' }, h('img', { src: photos[idx], alt: '', draggable: 'false' }));
      if (photos.length > 1) {
        box.appendChild(h('button', { class: 'photo-nav photo-prev', type: 'button', 'data-action': 'photo-prev', 'aria-label': '前の写真' }, '‹'));
        box.appendChild(h('button', { class: 'photo-nav photo-next', type: 'button', 'data-action': 'photo-next', 'aria-label': '次の写真' }, '›'));
      }
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
    var r = render(state.spreads[state.index]);
    if (side !== 'right') setChild(el.left, r.left);
    if (side !== 'left') setChild(el.right, r.right);
  }

  function updateChrome() {
    var kind = state.spreads[state.index].kind;
    el.prev.hidden = kind === 'cover';
    el.next.hidden = kind === 'cover' || kind === 'settings';
    el.loadPanel.hidden = !(kind === 'cover' && !state.data);
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
    var from = state.index;
    var dir = target > from ? 1 : -1;
    var coverFrom = state.spreads[from].kind === 'cover';
    var coverTo = state.spreads[target].kind === 'cover';
    var withCover = coverFrom || coverTo;
    var dur = opt.duration || (withCover ? COVER_MS : FLIP_MS);

    prepare(target, opt.select);
    var next = render(state.spreads[target]);

    var front = h('div', { class: 'face face-front' });
    var back = h('div', { class: 'face face-back' });
    var leaf = h('div', { class: 'leaf ' + (dir > 0 ? 'leaf-right' : 'leaf-left') }, front, back);

    if (dir > 0) {
      // 右ページをめくる：表は今の右ページ、裏は次の左ページ。下からは次の右ページが見える
      if (el.right.firstElementChild) front.appendChild(el.right.firstElementChild);
      if (next.left) back.appendChild(next.left);
      setChild(el.right, next.right);
    } else {
      // 左ページを戻す：表は今の左ページ、裏は前の右ページ。下からは前の左ページが見える
      if (el.left.firstElementChild) front.appendChild(el.left.firstElementChild);
      back.appendChild(next.right);
      setChild(el.left, next.left);
    }
    el.inner.appendChild(leaf);
    state.index = target;

    if (!withCover) DiarySound.flip(opt.sound || 0.4);

    var persp = Math.round(el.book.clientHeight * 4);
    var anims = [leaf.animate([
      { transform: 'perspective(' + persp + 'px) rotateY(0deg)' },
      { transform: 'perspective(' + persp + 'px) rotateY(' + (dir > 0 ? -180 : 180) + 'deg)' }
    ], { duration: dur, easing: opt.easing || EASE, fill: 'forwards' })];

    if (withCover) {
      // 閉じた本は右半分（表紙）が画面中央に来るよう左へずらしてある
      el.inner.classList.remove('closed');
      anims.push(el.inner.animate([
        { transform: coverFrom ? 'translateX(-25%)' : 'translateX(0)' },
        { transform: coverTo ? 'translateX(-25%)' : 'translateX(0)' }
      ], { duration: dur, easing: opt.easing || EASE, fill: 'forwards' }));
    }

    return Promise.all(anims.map(function (a) { return a.finished; })).then(function () {
      if (dir > 0) setChild(el.left, next.left);
      else setChild(el.right, next.right);
      leaf.remove();
      el.inner.classList.toggle('closed', coverTo);
      anims.forEach(function (a) { a.cancel(); });
      updateChrome();
    });
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
      refreshSide();
    },
    'photo-prev': function () { stepPhoto(-1); },
    'photo-next': function () { stepPhoto(1); },
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

  el.inner.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t || state.busy) return;
    var fn = actions[t.getAttribute('data-action')];
    if (fn) fn(t);
  });

  el.prev.addEventListener('click', function () {
    if (state.busy || state.index === 0) return;
    run(function () { return flip(state.index - 1); });
  });

  el.next.addEventListener('click', function () {
    if (state.busy || state.index >= state.spreads.length - 1 || state.index === 0) return;
    run(function () { return flip(state.index + 1); });
  });

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
    var bh = Math.floor(Math.min(H * 0.76, (W - 130) / 1.44));
    var top = Math.max(8, Math.round((H - bh) / 2 - H * 0.07));
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

  layout();
  updateChrome();
  show(0);

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
