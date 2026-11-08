/* 閲覧用：ページめくりの効果音（Web Audio API で紙が擦れるノイズ音を合成） */
(function () {
  'use strict';

  var KEY = 'diarybook-sound';
  var ctx = null;
  var noise = null;
  var listeners = [];

  function readOn() {
    try { return localStorage.getItem(KEY) === 'on'; } catch (e) { return false; }
  }

  var on = readOn();

  function ensureContext() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    // 1秒分のホワイトノイズを作っておく
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    var data = noise.getChannelData(0);
    for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  /** iPad 対策：最初に画面を触ったときに AudioContext を作って resume する */
  function unlock() {
    var c = ensureContext();
    if (!c) return;
    if (c.state !== 'running') c.resume();
    // 無音を1回鳴らして iOS の制限を解く
    var src = c.createBufferSource();
    src.buffer = c.createBuffer(1, 1, c.sampleRate);
    src.connect(c.destination);
    src.start(0);
  }

  function onFirstTouch() {
    unlock();
    ['pointerdown', 'touchend', 'keydown'].forEach(function (t) { window.removeEventListener(t, onFirstTouch, true); });
  }
  ['pointerdown', 'touchend', 'keydown'].forEach(function (t) { window.addEventListener(t, onFirstTouch, true); });

  /**
   * めくり音を鳴らす（ON のときだけ）
   * @param {number} seconds 音の長さ。パラパラめくりでは短くする
   */
  function flip(seconds) {
    if (!on) return;
    var c = ensureContext();
    if (!c) return;
    if (c.state !== 'running') c.resume();
    var dur = Math.max(0.05, seconds || 0.35);
    var t = c.currentTime;

    var src = c.createBufferSource();
    src.buffer = noise;

    var band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(900, t);
    band.frequency.exponentialRampToValueAtTime(3800, t + dur * 0.7);

    var high = c.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 400;

    var gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + Math.min(0.04, dur * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.12, t + dur * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(band);
    band.connect(high);
    high.connect(gain);
    gain.connect(c.destination);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  function setOn(value) {
    on = !!value;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* 保存できなくても動かす */ }
    if (on) unlock();
    listeners.forEach(function (fn) { fn(on); });
  }

  window.DiarySound = {
    isOn: function () { return on; },
    setOn: setOn,
    toggle: function () { setOn(!on); },
    onChange: function (fn) { listeners.push(fn); },
    flip: flip
  };
})();
