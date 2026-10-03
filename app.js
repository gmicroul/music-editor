/* 音乐混剪网页版：工程JSON + WebAudio试听 + Offline导出 */

let audioCtx = null;
let tracks = [];
let uid = 1;

const playSession = { id: 0, sources: [], raf: 0, startCtxTime: 0, totalDur: 0, timeline: [], playing: false };

const $ = (id) => document.getElementById(id);
const clipListEl = () => $('clipList');

function ensureCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function fmt(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return m > 0 ? `${m}:${sec.padStart(4, '0')}` : `${sec}s`;
}
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

/* ---------- 添加歌曲：原生解码优先，APE等用 ffmpeg.wasm(0.12单线程) 自动转 ---------- */
async function transcodeToWavWithFFmpeg(file) {
  if (!window.__ffmpegTranscode) {
    throw new Error('转码模块还没就绪，请联网刷新一次（module脚本需加载）');
  }
  $('nowPlaying').textContent = '首次转码需下载解码器（约30MB）…';
  return await window.__ffmpegTranscode(file);
}

/* 浏览器原生解不了的格式，直接走 ffmpeg，不先试原生（省一次失败解码） */
const FFMPEG_ONLY = /\.(ape|wma)$/i;

async function decodeFileSmart(file) {
  const ctx = ensureCtx();
  if (FFMPEG_ONLY.test(file.name)) {
    $('nowPlaying').textContent = `${file.name} 用 ffmpeg 转码中…`;
    const wavU8 = await transcodeToWavWithFFmpeg(file);
    return await ctx.decodeAudioData(wavU8.buffer);
  }
  const ab = await file.arrayBuffer();
  // 1) 先试浏览器原生（mp3/wav/flac/m4a最快，不耗流量）
  try {
    return await ctx.decodeAudioData(ab.slice(0));
  } catch (e1) {
    // 2) 原生失败 → ffmpeg 转 wav 再解（info 级别，不算异常）
    console.info('原生解码失败，转 ffmpeg:', file.name);
    $('nowPlaying').textContent = `${file.name} 原生解不了，用 ffmpeg 转码中…`;
    const wavU8 = await transcodeToWavWithFFmpeg(file);
    return await ctx.decodeAudioData(wavU8.buffer);
  }
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith('audio') && !/\.(mp3|wav|m4a|ogg|flac|aac|opus|webm|ape|wma)$/i.test(file.name)) {
      alert(`跳过不支持的文件：${file.name}`);
      continue;
    }
    if (file.size > 400 * 1024 * 1024) {
      alert(`${file.name} 太大了（>400MB），浏览器内存吃不消，先用 ffmpeg 截一段再剪`);
      continue;
    }
    try {
      $('nowPlaying').textContent = `正在读取 ${file.name}…`;
      const buf = await decodeFileSmart(file);
      addTrackFromBuffer(file.name.replace(/\.\w+$/, ''), buf);
      $('nowPlaying').textContent = `已添加 ${file.name}`;
    } catch (e) {
      console.error(e);
      alert(`解码失败：${file.name}（${e.message || e}），可先转成 FLAC/WAV 再试`);
      $('nowPlaying').textContent = '未播放';
    }
  }
}

function addTrackFromBuffer(name, buffer) {
  const dur = buffer.duration;
  tracks.push({
    id: uid++,
    name,
    buffer,
    duration: dur,
    start: 0,
    end: Math.min(dur, 10),
    gain: 1.0,
  });
  renderList();
}

/* 示例歌曲：本地合成，免找文件 */
function makeDemoBuffer(ctx, baseFreq, pattern) {
  const dur = 30, sr = ctx.sampleRate;
  const buf = ctx.createBuffer(2, Math.floor(dur * sr), sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const noteLen = 0.32;
  for (let i = 0; i < L.length; i++) {
    const t = i / sr;
    const idx = Math.floor(t / noteLen) % pattern.length;
    const f = baseFreq * Math.pow(2, pattern[idx] / 12);
    const nt = t % noteLen;
    const env = Math.exp(-nt * 5);
    let v = (Math.sin(2 * Math.PI * f * t) * 0.5 + Math.sin(4 * Math.PI * f * t) * 0.18) * env;
    // 底鼓每0.64s一下
    const bt = t % 0.64;
    if (bt < 0.12) v += Math.sin(2 * Math.PI * 58 * bt) * Math.exp(-bt * 30) * 0.7;
    L[i] = v * 0.8;
    R[i] = v * 0.8;
  }
  return buf;
}
function addDemoSongs() {
  const ctx = ensureCtx();
  const b1 = makeDemoBuffer(ctx, 220, [0, 4, 7, 12, 7, 4, 2, 0]);
  const b2 = makeDemoBuffer(ctx, 174.6, [0, 3, 5, 7, 10, 7, 5, 3]);
  const b3 = makeDemoBuffer(ctx, 196, [0, 0, 7, 7, 9, 9, 7, 5, 4, 2]);
  tracks.push({ id: uid++, name: '示例-欢快', buffer: b1, duration: b1.duration, start: 5, end: 10, gain: 1 });
  tracks.push({ id: uid++, name: '示例-抒情', buffer: b2, duration: b2.duration, start: 19, end: Math.min(29, b2.duration), gain: 1 });
  tracks.push({ id: uid++, name: '示例-动感', buffer: b3, duration: b3.duration, start: 0, end: 8, gain: 1 });
  renderList();
}

/* ---------- 列表渲染 ---------- */
function renderList() {
  const list = clipListEl();
  list.innerHTML = '';
  $('emptyTip').style.display = tracks.length ? 'none' : 'block';

  tracks.forEach((t, idx) => {
    const card = document.createElement('div');
    card.className = 'clip';
    card.dataset.id = t.id;
    card.innerHTML = `
      <div class="clip-head">
        <span class="drag-handle" title="按住拖动排序">⠿</span>
        <span class="badge">${idx + 1}</span>
        <span class="clip-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        <span class="clip-meta meta"></span>
        <div class="clip-actions">
          <button class="btn small ghost btn-up" title="上移">↑</button>
          <button class="btn small ghost btn-down" title="下移">↓</button>
          <button class="btn small ghost btn-play">▶本段</button>
          <button class="btn small ghost btn-loop" title="循环播放本段，边听边卡点">循环关</button>
          <button class="btn small ghost danger btn-del">删</button>
        </div>
      </div>
      <canvas class="wave"></canvas>
      <div class="ctl-grid">
        <div class="ctl">
          <label>开始(秒) <input class="in-start" type="number" step="0.1" min="0" /></label>
          <input class="rg-start" type="range" step="0.1" min="0" />
        </div>
        <div class="ctl">
          <label>结束(秒) <input class="in-end" type="number" step="0.1" min="0" /></label>
          <input class="rg-end" type="range" step="0.1" min="0" />
        </div>
      </div>
      <div class="row">
        <div class="ctl" style="flex:1">
          <label>音量 <span class="gain-label">100%</span></label>
          <input class="rg-gain" type="range" min="0" max="150" value="100" />
        </div>
        <button class="btn small ghost q5">前5秒</button>
        <button class="btn small ghost q10">前10秒</button>
        <button class="btn small ghost qall">整首</button>
      </div>`;

    const canvas = card.querySelector('.wave');
    const inS = card.querySelector('.in-start');
    const inE = card.querySelector('.in-end');
    const rgS = card.querySelector('.rg-start');
    const rgE = card.querySelector('.rg-end');
    const rgG = card.querySelector('.rg-gain');

    rgS.max = t.duration.toFixed(1); rgE.max = t.duration.toFixed(1);
    inS.max = t.duration.toFixed(1); inE.max = t.duration.toFixed(1);
    rgG.value = Math.round(t.gain * 100);

    const refreshInputs = () => {
      inS.value = t.start.toFixed(1); inE.value = t.end.toFixed(1);
      rgS.value = t.start; rgE.value = t.end;
      card.querySelector('.meta').textContent =
        `原长${fmt(t.duration)} · 截取${fmt(t.end - t.start)} (${t.start.toFixed(1)}~${t.end.toFixed(1)}s)`;
      card.querySelector('.gain-label').textContent = Math.round(t.gain * 100) + '%';
    };
    refreshInputs();
    card._refresh = refreshInputs;

    inS.onchange = () => setTimes(t.id, parseFloat(inS.value), t.end);
    inE.onchange = () => setTimes(t.id, t.start, parseFloat(inE.value));
    rgS.oninput = () => setTimes(t.id, parseFloat(rgS.value), t.end, true);
    rgE.oninput = () => setTimes(t.id, t.start, parseFloat(rgE.value), true);
    rgG.oninput = () => { t.gain = parseInt(rgG.value, 10) / 100; card.querySelector('.gain-label').textContent = rgG.value + '%'; };

    card.querySelector('.btn-up').onclick = () => move(t.id, -1);
    card.querySelector('.btn-down').onclick = () => move(t.id, 1);
    card.querySelector('.btn-del').onclick = () => { stopPlayback(); tracks = tracks.filter(x => x.id !== t.id); renderList(); };
    card.querySelector('.btn-play').onclick = () => playSingle(t.id);
    const loopBtn = card.querySelector('.btn-loop');
    const paintLoop = () => { loopBtn.textContent = t.loop ? '循环开' : '循环关'; };
    paintLoop();
    loopBtn.onclick = () => {
      t.loop = !t.loop; paintLoop();
      const playing = document.querySelector(`.clip[data-id="${t.id}"]`)?.classList.contains('playing');
      if (playing) playSingle(t.id);
    };
    card.querySelector('.q5').onclick = () => setTimes(t.id, 0, Math.min(5, t.duration));
    card.querySelector('.q10').onclick = () => setTimes(t.id, 0, Math.min(10, t.duration));
    card.querySelector('.qall').onclick = () => setTimes(t.id, 0, t.duration);

    bindCardDrag(card, t);
    bindWave(canvas, t, card);
    list.appendChild(card);
    requestAnimationFrame(() => drawWave(canvas, t));
  });

  updateMixInfo();
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function setTimes(id, s, e, live = false) {
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  s = isNaN(s) ? t.start : clamp(s, 0, t.duration);
  e = isNaN(e) ? t.end : clamp(e, 0, t.duration);
  if (e - s < 0.1) {
    if (live) { /* 拖动中允许临时交叉，松手再修 */ }
    else {
      // 保证最小0.5s
      if (s + 0.5 <= t.duration) e = s + 0.5; else s = Math.max(0, e - 0.5);
    }
  }
  if (e < s) [s, e] = [e, s];
  t.start = Math.round(s * 10) / 10;
  t.end = Math.round(e * 10) / 10;
  const card = clipListEl().querySelector(`.clip[data-id="${id}"]`);
  if (card) {
    card._refresh();
    drawWave(card.querySelector('.wave'), t);
  }
  if (!live) updateMixInfo();
  else updateMixInfo(true);
}

function move(id, dir) {
  const i = tracks.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= tracks.length) return;
  stopPlayback();
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  renderList();
}

/* 自由拖动排序：按住 ⠿ 拖到任意位置（桌面端）；手机端用 ↑↓ */
let dragSrcId = null;
function bindCardDrag(card, t) {
  const handle = card.querySelector('.drag-handle');
  card.draggable = false;
  // 只有按住手柄才允许拖，避免和波形选段/滑杆冲突
  handle.addEventListener('pointerdown', () => { card.draggable = true; });
  handle.addEventListener('pointerup', () => { card.draggable = false; });
  card.addEventListener('dragstart', (e) => {
    dragSrcId = t.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(t.id)); } catch (_) {}
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    card.draggable = false;
    document.querySelectorAll('.clip.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  card.addEventListener('dragover', (e) => {
    if (dragSrcId == null || dragSrcId === t.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    if (dragSrcId == null || dragSrcId === t.id) return;
    const from = tracks.findIndex(x => x.id === dragSrcId);
    const to = tracks.findIndex(x => x.id === t.id);
    if (from < 0 || to < 0) return;
    stopPlayback();
    const [m] = tracks.splice(from, 1);
    tracks.splice(to, 0, m);
    dragSrcId = null;
    renderList();
  });
}

/* ---------- 波形（峰值缓存 + 可选播放头） ---------- */
const PEAK_N = 900;
function getPeaksCached(t) {
  if (!t._peaks || t._peaksBuf !== t.buffer) {
    const buffer = t.buffer, n = PEAK_N;
    const ch = buffer.getChannelData(0);
    const peaks = new Float32Array(n);
    const block = Math.max(1, Math.floor(ch.length / n));
    for (let i = 0; i < n; i++) {
      let m = 0;
      const s = i * block;
      for (let j = s; j < Math.min(s + block, ch.length); j += 7) {
        const v = Math.abs(ch[j]);
        if (v > m) m = v;
      }
      peaks[i] = m;
    }
    t._peaks = peaks; t._peaksBuf = buffer;
  }
  return t._peaks;
}

function drawWave(canvas, t, playTime = null) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600, h = 90;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = '#1e2433'; c.fillRect(0, 0, w, h);

  const N = PEAK_N;
  const peaks = getPeaksCached(t);
  const bw = w / N;
  // 底波形
  c.fillStyle = '#5f6b8a';
  peaks.forEach((p, i) => {
    const bh = Math.max(2, p * h * 0.92);
    c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw * 0.7), bh);
  });
  // 选中段高亮覆盖
  const sx = (t.start / t.duration) * w, ex = (t.end / t.duration) * w;
  c.fillStyle = 'rgba(0,0,0,0.62)';
  c.fillRect(0, 0, sx, h); c.fillRect(ex, 0, w - ex, h);
  // 选中段内再画一层青色
  c.fillStyle = '#00e6c3';
  peaks.forEach((p, i) => {
    const x = i * bw;
    if (x >= sx && x <= ex) {
      const bh = Math.max(2, p * h * 0.92);
      c.fillRect(x, (h - bh) / 2, Math.max(1, bw * 0.7), bh);
    }
  });
  // 起止线
  c.fillStyle = '#ffd32a';
  c.fillRect(sx - 1, 0, 2.5, h); c.fillRect(ex - 1, 0, 2.5, h);
  // 播放头（单段试听时红色竖线）
  if (playTime != null && playTime >= t.start && playTime <= t.end) {
    const px = (playTime / t.duration) * w;
    c.fillStyle = '#ff4757';
    c.fillRect(px - 1, 0, 2.5, h);
    c.beginPath();
    c.moveTo(px - 5, 0); c.lineTo(px + 5, 0); c.lineTo(px, 8); c.closePath();
    c.fill();
  }
  c.font = '11px sans-serif';
  c.fillText(t.start.toFixed(1) + 's', clamp(sx + 4, 0, w - 40), 14);
  c.fillText(t.end.toFixed(1) + 's', clamp(ex - 36, 0, w - 40), 14);
  c.fillStyle = 'rgba(255,255,255,.55)';
  c.fillText('在波形上按住拖拉即可选段', 8, h - 8);
}

function bindWave(canvas, t, card) {
  let dragging = false, anchor = 0;
  const toTime = (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = clamp((ev.clientX - r.left), 0, r.width);
    return (x / r.width) * t.duration;
  };
  canvas.addEventListener('pointerdown', (ev) => {
    ensureCtx();
    dragging = true; canvas.setPointerCapture(ev.pointerId);
    anchor = toTime(ev);
    setTimes(t.id, anchor, anchor, true);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    setTimes(t.id, anchor, toTime(ev), true);
  });
  const up = () => {
    if (!dragging) return;
    dragging = false;
    // 修最小长度
    if (t.end - t.start < 0.2) setTimes(t.id, Math.max(0, t.start - 0.25), Math.min(t.duration, t.start + 0.45));
    else { setTimes(t.id, t.start, t.end); }
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

/* ---------- 拼接信息条 ---------- */
function mixTotal() { return tracks.reduce((a, t) => a + Math.max(0, t.end - t.start), 0); }

function updateMixInfo(light = false) {
  const total = mixTotal();
  const wavMb = (total * 44100 * 2 * 2 / 1048576).toFixed(1);
  const kbps = parseInt($('mp3Rate')?.value || '192', 10);
  const mp3Mb = (total * kbps / 8 / 1024).toFixed(1);
  $('mixInfo').textContent = `共 ${tracks.length} 段，总长 ${total.toFixed(1)} 秒 · WAV约${wavMb}MB / MP3(${kbps}k)约${mp3Mb}MB`;
  if (light) return;
  const bar = $('mixBar'); bar.innerHTML = '';
  const palette = [206, 160, 340, 20, 140, 260, 0, 100];
  tracks.forEach((t, i) => {
    const d = Math.max(0, t.end - t.start);
    const seg = document.createElement('div');
    seg.className = 'mix-seg';
    seg.style.flexGrow = Math.max(1, d * 10);
    seg.style.background = `hsl(${palette[i % palette.length]} 70% 45%)`;
    seg.textContent = `${i + 1}. ${t.name} ${d.toFixed(1)}s`;
    seg.title = '点击从这一段开始试听';
    seg.onclick = () => playAll(i);
    bar.appendChild(seg);
  });
  if (!tracks.length) bar.innerHTML = '<span class="small">还没有片段</span>';
}

/* ---------- 播放引擎：无缝连播 ---------- */
function clearPlayingUI() {
  document.querySelectorAll('.clip.playing').forEach(el => el.classList.remove('playing'));
  document.querySelectorAll('.mix-seg').forEach(el => el.style.outline = '');
}
function stopPlayback() {
  playSession.id++;
  playSession.sources.forEach(s => { try { s.stop(); } catch (_) {} });
  playSession.sources = [];
  playSession.playing = false;
  playSession.single = null;
  cancelAnimationFrame(playSession.raf);
  // 清掉单段试听留下的红色播放头
  document.querySelectorAll('.clip.playing').forEach(el => {
    const tr = tracks.find(x => x.id == el.dataset.id);
    if (tr) drawWave(el.querySelector('.wave'), tr);
  });
  clearPlayingUI();
  $('playProgress').style.width = '0%';
  $('nowPlaying').textContent = '已停止';
}

function applyFade(gainNode, when, dur, vol) {
  const f = Math.min(0.03, dur / 4);
  const g = gainNode.gain;
  g.setValueAtTime(0.0001, when);
  g.linearRampToValueAtTime(Math.max(0.0001, vol), when + f);
  g.setValueAtTime(Math.max(0.0001, vol), Math.max(when + f, when + dur - f));
  g.linearRampToValueAtTime(0.0001, when + dur);
}

function playSingle(id) {
  const t = tracks.find(x => x.id === id);
  if (!t) return;
  const dur = t.end - t.start;
  if (dur <= 0.05) return alert('这段太短了，先拖大一点');
  const ctx = ensureCtx();
  stopPlayback();
  const myId = ++playSession.id;
  const loop = !!t.loop;
  const src = ctx.createBufferSource(); src.buffer = t.buffer;
  const g = ctx.createGain(); src.connect(g); g.connect(ctx.destination);
  const when = ctx.currentTime + 0.05;
  if (loop) {
    // 循环模式：固定音量一直播，边听边拖起止点卡点
    src.loop = true; src.loopStart = t.start; src.loopEnd = t.end;
    g.gain.value = t.gain;
    src.start(when, t.start);
  } else {
    applyFade(g, when, dur, t.gain);
    src.start(when, t.start, dur);
  }
  playSession.sources = [src];
  playSession.playing = true;
  playSession.single = { trackId: id, when, dur, loop };
  document.querySelector(`.clip[data-id="${id}"]`)?.classList.add('playing');
  $('nowPlaying').textContent = `单段试听：${t.name} ${t.start.toFixed(1)}~${t.end.toFixed(1)}s`;
  if (!loop) src.onended = () => { if (playSession.id === myId) stopPlayback(); };
  tickSingle(myId, t, when, dur, loop);
}

function tickSingle(myId, t, when, dur, loop) {
  if (playSession.id !== myId || !playSession.playing) return;
  const el0 = audioCtx.currentTime - when;
  if (!loop && el0 >= dur) return; // 等 onended 收尾
  const pos = loop ? (el0 < 0 ? 0 : el0 % dur) : Math.min(Math.max(0, el0), dur);
  if (el0 >= 0) {
    $('playProgress').style.width = (pos / dur * 100).toFixed(1) + '%';
    $('nowPlaying').textContent =
      `单段试听：${t.name} ${t.start.toFixed(1)}~${t.end.toFixed(1)}s · ` +
      `${pos.toFixed(1)}/${dur.toFixed(1)}s${loop ? ' · 循环中（点停止结束）' : ''}`;
    const card = document.querySelector(`.clip[data-id="${t.id}"]`);
    if (card) drawWave(card.querySelector('.wave'), t, t.start + pos);
  }
  playSession.raf = requestAnimationFrame(() => tickSingle(myId, t, when, dur, loop));
}

function playAll(fromIdx = 0) {
  if (!tracks.length) return alert('先添加歌曲');
  const ctx = ensureCtx();
  stopPlayback();
  const myId = ++playSession.id;
  let when = ctx.currentTime + 0.15;
  let total = 0;
  const timeline = [];
  const sources = [];
  for (let i = fromIdx; i < tracks.length; i++) {
    const t = tracks[i];
    const dur = t.end - t.start;
    if (dur <= 0.05) continue;
    const src = ctx.createBufferSource(); src.buffer = t.buffer;
    const g = ctx.createGain(); src.connect(g); g.connect(ctx.destination);
    applyFade(g, when, dur, t.gain);
    try { src.start(when, t.start, dur); } catch (e) { console.error(e); continue; }
    sources.push(src);
    timeline.push({ track: t, idx: i, mixOffset: total, dur, ctxWhen: when });
    when += dur; total += dur;
  }
  if (!timeline.length) return alert('每段都太短');
  playSession.sources = sources;
  playSession.timeline = timeline;
  playSession.startCtxTime = timeline[0].ctxWhen;
  playSession.totalDur = total;
  playSession.playing = true;
  $('nowPlaying').textContent = `拼接试听中… 共${total.toFixed(1)}s`;
  // 最后一个播完自动停
  sources[sources.length - 1].onended = () => { if (playSession.id === myId) stopPlayback(); };
  tick(myId);
}

function tick(myId) {
  if (playSession.id !== myId || !playSession.playing) return;
  const ctx = audioCtx;
  const el = ctx.currentTime - playSession.startCtxTime;
  const total = playSession.totalDur;
  if (el >= total) return; // 等onended收尾
  if (el >= 0) {
    $('playProgress').style.width = (el / total * 100).toFixed(1) + '%';
    const cur = playSession.timeline.find(s => el >= s.mixOffset && el < s.mixOffset + s.dur);
    if (cur) {
      clearPlayingUI();
      document.querySelector(`.clip[data-id="${cur.track.id}"]`)?.classList.add('playing');
      $('nowPlaying').textContent =
        `正在播 第${cur.idx + 1}首 ${cur.track.name} ` +
        `${(el - cur.mixOffset).toFixed(1)}/${cur.dur.toFixed(1)}s · 总 ${el.toFixed(1)}/${total.toFixed(1)}s`;
    }
  }
  playSession.raf = requestAnimationFrame(() => tick(myId));
}

/* ---------- 导出：先渲染成 PCM，再转 WAV / MP3 ---------- */
async function renderMixBuffer() {
  const total = mixTotal();
  if (total < 0.2) throw new Error('总长太短');
  if (total > 600) throw new Error('太长了（>10分钟），先缩短再导出，浏览器内存吃不消');
  const sr = 44100, nCh = 2;
  const off = new OfflineAudioContext(nCh, Math.ceil(total * sr), sr);
  let t0 = 0;
  for (const t of tracks) {
    const dur = t.end - t.start;
    if (dur <= 0.05) continue;
    const src = off.createBufferSource(); src.buffer = t.buffer;
    const g = off.createGain(); src.connect(g); g.connect(off.destination);
    const f = Math.min(0.03, dur / 4);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, t.gain), t0 + f);
    g.gain.setValueAtTime(Math.max(0.0001, t.gain), Math.max(t0 + f, t0 + dur - f));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.start(t0, t.start, dur);
    t0 += dur;
  }
  return { rendered: await off.startRendering(), total };
}
function encodeWAV(audioBuffer) {
  const nCh = Math.min(2, audioBuffer.numberOfChannels);
  const sr = audioBuffer.sampleRate;
  const len = audioBuffer.length;
  const bytes = 44 + len * nCh * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nCh * 2, true); v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  wstr(36, 'data'); v.setUint32(40, len * nCh * 2, true);
  const chs = [];
  for (let c = 0; c < nCh; c++) chs.push(audioBuffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nCh; c++) {
      const s = clamp(chs[c][i], -1, 1);
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

async function exportWav() {
  if (!tracks.length) return alert('先添加歌曲');
  const btn = $('exportBtn');
  btn.disabled = true; btn.textContent = '渲染中…';
  try {
    const { rendered, total } = await renderMixBuffer();
    const blob = encodeWAV(rendered);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `混剪_${total.toFixed(1)}s.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('nowPlaying').textContent = `已导出 ${total.toFixed(1)}s WAV`;
  } catch (e) {
    console.error(e);
    alert('导出失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '⬇ 导出 WAV';
  }
}

/* MP3：Float32 -> Int16 -> lamejs 分块编码 */
function floatTo16(stride, len, chData) {
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    const s = clamp(chData[stride + i], -1, 1);
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out;
}
function encodeMP3(audioBuffer, kbps) {
  const sr = audioBuffer.sampleRate;
  const nCh = audioBuffer.numberOfChannels;
  // lamejs 只支持单/双声道，统一按立体声处理（单声道就复制一份）
  const left = audioBuffer.getChannelData(0);
  const right = nCh > 1 ? audioBuffer.getChannelData(1) : left;
  const encoder = new lamejs.Mp3Encoder(nCh === 1 ? 1 : 2, sr, kbps);
  const maxSamples = 1152;
  const data = [];
  for (let i = 0; i < left.length; i += maxSamples) {
    const len = Math.min(maxSamples, left.length - i);
    const l = floatTo16(i, len, left);
    let chunk;
    if (nCh === 1) {
      chunk = encoder.encodeBuffer(l);
    } else {
      const r = floatTo16(i, len, right);
      chunk = encoder.encodeBuffer(l, r);
    }
    if (chunk.length) data.push(chunk);
  }
  const end = encoder.flush();
  if (end.length) data.push(end);
  return new Blob(data, { type: 'audio/mp3' });
}

async function exportMp3() {
  if (!tracks.length) return alert('先添加歌曲');
  if (typeof lamejs === 'undefined') {
    return alert('MP3编码器还没加载出来（需要联网加载一次 lamejs），请联网刷新后再试，或先用 WAV 导出');
  }
  const kbps = parseInt($('mp3Rate').value, 10) || 192;
  const btn = $('exportMp3Btn');
  btn.disabled = true; btn.textContent = 'MP3编码中…';
  try {
    const { rendered, total } = await renderMixBuffer();
    $('nowPlaying').textContent = `PCM已合成，正在转MP3 (${kbps}kbps)…`;
    // 让UI先刷出来，避免长编码卡住
    await new Promise(r => setTimeout(r, 30));
    const blob = encodeMP3(rendered, kbps);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `混剪_${total.toFixed(1)}s_${kbps}k.mp3`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    $('nowPlaying').textContent = `已导出 ${total.toFixed(1)}s MP3 (${kbps}kbps, ${(blob.size / 1024).toFixed(0)}KB)`;
  } catch (e) {
    console.error(e);
    alert('导出失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '⬇ 导出 MP3';
  }
}

/* ---------- 事件 ---------- */
$('fileInput').addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; });
$('demoBtn').onclick = addDemoSongs;
$('clearBtn').onclick = () => { if (confirm('清空全部歌曲？')) { stopPlayback(); tracks = []; renderList(); } };
$('playAllBtn').onclick = () => playAll(0);
$('stopBtn').onclick = stopPlayback;
$('exportBtn').onclick = exportWav;
$('exportMp3Btn').onclick = exportMp3;
$('mp3Rate').onchange = () => updateMixInfo();

const dz = $('dropzone');
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.background = '#eee8ff'; }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.style.background = ''; }));
dz.addEventListener('drop', (e) => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });

let rsz;
window.addEventListener('resize', () => {
  clearTimeout(rsz);
  rsz = setTimeout(() => document.querySelectorAll('.clip').forEach(card => {
    const t = tracks.find(x => x.id == card.dataset.id);
    if (t) drawWave(card.querySelector('.wave'), t);
  }), 200);
});

renderList();
