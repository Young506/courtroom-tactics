/* Local-only MP4 export, recording and narration. No network upload is used. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const E = window.CourtEngine, V = window.CourtVideoModel, Voice = window.CourtVoice;
  const dialog = $('video-dialog');
  const canvas = $('video-preview-canvas');
  const RATE = 16000;
  let snapshot, previewRenderer, previewVersion = 0, busy = false, controller, resultBlob, resultURL;
  let recordURL, ttsURL, recorder, recordingStream, recordingChunks, recordStarted, recordClock;
  let dbPromise, mediaPromise, closeAfterCancel = false, settingsDisabled, recordAttempt = 0, recordPending = false, recordSaving = false;
  const memoryRecordings = new Map();
  const status = message => { $('video-status').textContent = message; };
  const check = signal => { if (signal?.aborted) throw signal.reason || new DOMException('已取消视频导出。', 'AbortError'); };
  const yieldUI = () => new Promise(resolve => setTimeout(resolve, 0));

  function db() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('当前浏览器不能持久保存录音。'));
      const request = indexedDB.open('courtroom-audio-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('recordings', { keyPath: 'key' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }
  const recordingKey = (step, tacticId = snapshot.tactic.id) => tacticId + ':' + step.id;
  async function readRecording(step) {
    const key = recordingKey(step);
    if (memoryRecordings.has(key)) return memoryRecordings.get(key);
    try {
      const database = await db();
      const result = await new Promise((resolve, reject) => {
        const request = database.transaction('recordings').objectStore('recordings').get(key);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (result) memoryRecordings.set(key, result);
      return result;
    } catch { return null; }
  }
  async function saveRecording(step, blob, duration, tacticId = snapshot.tactic.id) {
    const value = { key: recordingKey(step, tacticId), blob, duration, updatedAt: Date.now() };
    memoryRecordings.set(value.key, value);
    try {
      const database = await db();
      await new Promise((resolve, reject) => {
        const tx = database.transaction('recordings', 'readwrite');
        tx.objectStore('recordings').put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch { return false; }
  }
  async function deleteRecording(step) {
    const key = recordingKey(step);
    memoryRecordings.delete(key);
    try {
      const database = await db();
      await new Promise((resolve, reject) => {
        const tx = database.transaction('recordings', 'readwrite'); tx.objectStore('recordings').delete(key);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } catch { /* The in-memory recording was removed. */ }
  }
  async function decode(blob) {
    const Context = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Context) throw new Error('此浏览器不能解码录音，请使用新版浏览器。');
    return new Context(1, 1, RATE).decodeAudioData(await blob.arrayBuffer());
  }
  function wav(buffer) {
    const samples = buffer.getChannelData(0), bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
    return new Blob([bytes], { type: 'audio/wav' });
  }
  function chosenRecordingStep() { return snapshot.tactic.steps[Number($('record-step').value) || 0]; }
  async function showRecording() {
    if (!snapshot) return;
    const step = chosenRecordingStep(), tacticId = snapshot.tactic.id;
    $('record-script').textContent = step.title + '\n' + (step.notes || '此步骤尚未填写讲解。');
    const saved = await readRecording(step);
    if (!dialog.open || snapshot.tactic.id !== tacticId || chosenRecordingStep().id !== step.id) return;
    if (recordURL) URL.revokeObjectURL(recordURL);
    $('record-preview').hidden = !saved;
    $('record-delete').hidden = !saved;
    if (saved) {
      recordURL = URL.createObjectURL(saved.blob); $('record-preview').src = recordURL;
      $('record-status').textContent = `已保存此步骤录音 · ${saved.duration.toFixed(1)} 秒。录音保存在当前浏览器，JSON 备份不包含录音。`;
    } else $('record-status').textContent = '此步骤尚无录音。录音只保存在当前浏览器。';
  }
  function selected() {
    const current = $('video-range').value === 'current';
    return current ? { steps: [snapshot.tactic.steps[snapshot.idx]], indices: [snapshot.idx] } : { steps: snapshot.tactic.steps, indices: snapshot.tactic.steps.map((_, i) => i) };
  }
  function options() {
    return { view: $('video-view').value, orientation: $('video-orientation').value, quality: Number($('video-quality').value), audio: $('video-audio').value };
  }
  function audioPanels() {
    const value = $('video-audio').value;
    $('record-panel').hidden = value !== 'record'; $('tts-panel').hidden = value !== 'tts';
    if (value === 'record') showRecording();
  }
  function roundRect(ctx, x, y, w, h, r, color) {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
  }
  function svgImage(svg) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })), image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画板图片生成失败，请重试。')); }; image.src = url;
    });
  }

  class FrameRenderer {
    constructor(source, settings, target) {
      this.snapshot = source; this.settings = settings; this.canvas = target;
      this.layout = V.layout(settings.orientation, settings.quality);
      target.width = this.layout.width; target.height = this.layout.height;
      this.ctx = target.getContext('2d', { alpha: false }); this.backgroundId = null;
    }
    async init() {
      if (this.settings.view === '3d') {
        this.host = document.createElement('div'); this.host.className = 'video-offscreen';
        Object.assign(this.host.style, { width: this.layout.board.w + 'px', height: this.layout.board.h + 'px' });
        document.body.append(this.host);
        try {
          this.scene = await window.Courtroom3D.create(this.host, { exportMode: true });
          const step = this.snapshot.tactic.steps[0];
          this.scene.update({ tactic: this.snapshot.tactic, step, frame: E.sampled(step, 0), progress: 0, playing: false });
          if (this.snapshot.camera) this.scene.setCameraState(this.snapshot.camera);
          this.scene.setSize(this.layout.board.w, this.layout.board.h);
        } catch (err) { this.host.remove(); throw err; }
      }
      return this;
    }
    text(step) {
      const { ctx, layout: L } = this;
      ctx.font = `600 ${L.stepFont}px "Microsoft YaHei","PingFang SC",sans-serif`;
      const headings = V.wrapText(step.title, L.notes.w, s => ctx.measureText(s).width);
      ctx.font = `${L.bodyFont}px "Microsoft YaHei","PingFang SC",sans-serif`;
      const lines = V.wrapText(step.notes || '观察球员跑位与配合时机。', L.notes.w, s => ctx.measureText(s).width);
      const bodyY = L.notes.y + 38 * L.scale + headings.length * (L.stepFont * 1.4) + 24 * L.scale;
      const count = Math.max(2, Math.floor((L.notes.y + L.notes.h - bodyY) / L.lineHeight));
      return { headings, pages: V.paginate(lines, count), bodyY };
    }
    async draw(info, textData) {
      const { canvas, ctx, layout: L } = this, { item, progress, fraction } = info, step = item.step;
      ctx.fillStyle = '#142b22'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      ctx.fillStyle = '#9db88b'; ctx.font = `${13 * L.scale}px sans-serif`;
      ctx.fillText('COURTROOM  /  战术室', 30 * L.scale, 22 * L.scale);
      ctx.fillStyle = '#e4efd9'; ctx.font = `600 ${L.titleFont}px "Microsoft YaHei","PingFang SC",sans-serif`;
      const titles = V.wrapText(this.snapshot.tactic.title, L.width - 60 * L.scale, s => ctx.measureText(s).width);
      titles.forEach((line, i) => ctx.fillText(line, 30 * L.scale, 51 * L.scale + i * L.titleFont * 1.15));
      const frame = E.sampled(step, progress);
      const b = L.board;
      if (this.scene) {
        this.scene.update({ tactic: this.snapshot.tactic, step, frame, progress, playing: false });
        ctx.save(); ctx.beginPath(); ctx.roundRect(b.x, b.y, b.w, b.h, 10 * L.scale); ctx.clip();
        ctx.drawImage(this.scene.canvas, b.x, b.y, b.w, b.h); ctx.restore();
      } else {
        if (this.backgroundId !== step.id) {
          this.background = await svgImage(window.CourtroomApp.backgroundSvg(this.snapshot.tactic, step)); this.backgroundId = step.id;
        }
        roundRect(ctx, b.x, b.y, b.w, b.h, 10 * L.scale, '#f0e7d3');
        const h = E.HEIGHT[this.snapshot.tactic.court], scale = Math.min((b.w - 12 * L.scale) / 1000, (b.h - 12 * L.scale) / h);
        const x = b.x + (b.w - 1000 * scale) / 2, y = b.y + (b.h - h * scale) / 2;
        ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale); ctx.drawImage(this.background, 0, 0, 1000, h);
        for (const p of frame.players) {
          if (p.team === 'defense' && !this.snapshot.tactic.showDefense) continue;
          ctx.beginPath(); ctx.arc(p.x, p.y, 30, 0, Math.PI * 2); ctx.fillStyle = p.team === 'attack' ? '#286451' : '#c67a62'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#fff6df80'; ctx.stroke();
          ctx.fillStyle = '#fff8e6'; ctx.font = '600 30px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.number, p.x, p.y + 1);
        }
        if (frame.ball) {
          ctx.beginPath(); ctx.arc(frame.ball.x, frame.ball.y, 13, 0, Math.PI * 2); ctx.fillStyle = '#e3a24c'; ctx.fill(); ctx.strokeStyle = '#815d32'; ctx.lineWidth = 2; ctx.stroke();
          ctx.beginPath(); ctx.moveTo(frame.ball.x - 12, frame.ball.y); ctx.lineTo(frame.ball.x + 12, frame.ball.y); ctx.moveTo(frame.ball.x, frame.ball.y - 12); ctx.lineTo(frame.ball.x, frame.ball.y + 12); ctx.stroke();
        }
        ctx.restore();
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#adc493'; ctx.font = `${15 * L.scale}px sans-serif`;
      ctx.fillText(`步骤 ${String(item.originalIndex + 1).padStart(2, '0')} / ${String(this.snapshot.tactic.steps.length).padStart(2, '0')}`, L.notes.x, L.notes.y);
      ctx.fillStyle = '#e2edd6'; ctx.font = `600 ${L.stepFont}px "Microsoft YaHei","PingFang SC",sans-serif`;
      textData.headings.forEach((line, i) => ctx.fillText(line, L.notes.x, L.notes.y + 38 * L.scale + i * L.stepFont * 1.4));
      ctx.fillStyle = '#b8cda6'; ctx.font = `${L.bodyFont}px "Microsoft YaHei","PingFang SC",sans-serif`;
      const page = Math.min(textData.pages.length - 1, Math.floor(fraction * textData.pages.length));
      textData.pages[page].forEach((line, i) => ctx.fillText(line, L.notes.x, textData.bodyY + i * L.lineHeight));
      ctx.fillStyle = '#708964'; ctx.font = `${12 * L.scale}px sans-serif`;
      if (textData.pages.length > 1) ctx.fillText(`说明 ${page + 1} / ${textData.pages.length}`, L.notes.x, L.notes.y + L.notes.h + 5 * L.scale);
      ctx.fillText(`${this.settings.view.toUpperCase()} 战术演示  ·  30 FPS`, 30 * L.scale, L.height - 29 * L.scale);
    }
    dispose() { this.scene?.dispose(); this.host?.remove(); this.background = null; }
  }

  async function preview() {
    if (busy || !snapshot || !dialog.open) return;
    const version = ++previewVersion, settings = options(), { steps, indices } = selected();
    $('video-error').hidden = true; $('video-result').hidden = true; canvas.hidden = false;
    let renderer;
    try {
      if (previewRenderer) { previewRenderer.dispose(); previewRenderer = null; }
      renderer = await new FrameRenderer(snapshot, settings, canvas).init();
      if (version !== previewVersion || busy || !dialog.open) { renderer.dispose(); return; }
      previewRenderer = renderer;
      const texts = steps.map(s => renderer.text(s)), plan = V.timeline(steps, [], texts.map(t => t.pages.length), 30, indices);
      await renderer.draw(V.at(plan, 0), texts[0]);
      $('video-summary').textContent = `${settings.view.toUpperCase()} · ${canvas.width} × ${canvas.height} · 30 帧/秒 · ${steps.length} 个步骤${settings.audio === 'mute' ? ` · 约 ${plan.duration.toFixed(1)} 秒` : ' · 时长根据配音调整'}`;
    } catch (err) { renderer?.dispose(); error(err); }
  }
  function error(err) {
    $('video-error').hidden = false;
    const name = err?.name || '';
    $('video-error').textContent = name === 'QuotaExceededError' || name === 'RangeError' ? '设备内存不足，请选择 720p 或按当前步骤导出。' : err?.message || '生成失败，请稍后重试。';
  }
  function setBusy(value) {
    busy = value; document.body.classList.toggle('video-exporting', value);
    $('video-generate').disabled = value; $('video-cancel').hidden = !value;
    if (value) {
      settingsDisabled = [...dialog.querySelectorAll('.video-settings input,.video-settings select,.video-settings button')].map(el => [el, el.disabled]);
      for (const [el] of settingsDisabled) el.disabled = true;
    } else if (settingsDisabled) for (const [el, disabled] of settingsDisabled) el.disabled = disabled;
  }
  async function loadMedia() { mediaPromise ||= import('./mediabunny.mjs'); return mediaPromise; }
  async function audioFor(steps, indices, setting, signal) {
    if (setting === 'mute') return steps.map(() => null);
    const buffers = [];
    for (let i = 0; i < steps.length; i++) {
      check(signal); status(`准备配音 ${i + 1} / ${steps.length}…`);
      if (setting === 'tts') {
        const text = `第${indices[i] + 1}步，${steps[i].title}。${steps[i].notes || ''}`;
        buffers.push(await Voice.synthesize(text, status));
      } else {
        const saved = await readRecording(steps[i]);
        if (!saved) throw new Error(`第 ${indices[i] + 1} 步还没有录音。请先录制或上传该步骤录音，或选择无声 / 自动朗读。`);
        buffers.push(await decode(saved.blob));
      }
      check(signal); await yieldUI();
    }
    return buffers;
  }
  function paddedAudio(buffer, seconds) {
    const out = new AudioBuffer({ numberOfChannels: 1, length: Math.round(seconds * RATE), sampleRate: RATE });
    if (buffer) {
      const data = out.getChannelData(0), channels = buffer.numberOfChannels;
      for (let c = 0; c < channels; c++) {
        const input = buffer.getChannelData(c);
        for (let i = 0; i < Math.min(data.length, input.length); i++) data[i] += input[i] / channels;
      }
    }
    return out;
  }
  async function webCodecsExport(M, renderer, plan, texts, audios, signal, bitrate) {
    const video = new M.CanvasSource(canvas, { codec: 'avc', quality: new M.Quality({ bitrate }), keyFrameInterval: 2 });
    const output = new M.Output({ format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new M.BufferTarget() });
    output.addVideoTrack(video, { frameRate: plan.fps });
    const audio = audios.some(Boolean) ? new M.AudioBufferSource({ codec: 'aac', quality: new M.Quality({ bitrate: 96000 }) }) : null;
    if (audio) output.addAudioTrack(audio, { languageCode: 'zho', name: '战术讲解' });
    try {
      await output.start(); let audioIndex = -1;
      for (let f = 0; f < plan.frames; f++) {
        check(signal); const info = V.at(plan, f);
        if (audio && info.item.index !== audioIndex) {
          audioIndex = info.item.index; await audio.add(paddedAudio(audios[audioIndex], info.item.duration));
        }
        await renderer.draw(info, texts[info.item.index]);
        await video.add(f / plan.fps, 1 / plan.fps);
        if (f % 5 === 0 || f === plan.frames - 1) {
          $('video-progress').value = Math.round((f + 1) / plan.frames * 95);
          status(`正在生成视频 ${Math.round((f + 1) / plan.frames * 100)}% · 步骤 ${info.item.originalIndex + 1} / ${snapshot.tactic.steps.length}`);
          await yieldUI();
        }
      }
      video.close(); audio?.close(); check(signal); status('正在封装 MP4…'); await output.finalize();
      return new Blob([output.target.buffer], { type: 'video/mp4' });
    } catch (err) { if (!['finalized', 'canceled'].includes(output.state)) await output.cancel().catch(() => {}); throw err; }
  }
  function mp4RecordingType() {
    if (!globalThis.MediaRecorder) return null;
    return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'].find(t => MediaRecorder.isTypeSupported(t));
  }
  async function recorderExport(renderer, plan, texts, audios, signal, bitrate, context) {
    const mimeType = mp4RecordingType();
    if (!mimeType || !canvas.captureStream) throw new Error('此浏览器暂不支持 MP4 视频编码。请使用最新版 Chrome、Edge 或 Safari，或换一台设备导出。');
    status('使用兼容模式，按视频实际时长生成。请保持页面在前台…');
    await renderer.draw(V.at(plan, 0), texts[0]);
    const stream = canvas.captureStream(30), sources = [];
    let destination;
    if (audios.some(Boolean)) {
      await context.resume(); destination = context.createMediaStreamDestination();
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
    }
    let rec;
    const chunks = []; let raf = 0, drawError;
    try {
      rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate, audioBitsPerSecond: 96000 });
      return await new Promise((resolve, reject) => {
        const abort = () => { drawError = signal.reason || new DOMException('已取消视频导出。', 'AbortError'); if (rec.state !== 'inactive') rec.stop(); };
        signal.addEventListener('abort', abort, { once: true });
        rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        rec.onerror = () => { drawError = new Error('当前浏览器录制失败，请重试或选择 720p。'); if (rec.state !== 'inactive') rec.stop(); else reject(drawError); };
        rec.onstop = () => { signal.removeEventListener('abort', abort); cancelAnimationFrame(raf); if (drawError) reject(drawError); else resolve(new Blob(chunks, { type: 'video/mp4' })); };
        rec.start(1000);
        const start = performance.now();
        if (destination) for (let i = 0; i < audios.length; i++) {
          if (!audios[i]) continue; const source = context.createBufferSource(); source.buffer = audios[i]; source.connect(destination);
          source.start(context.currentTime + plan.steps[i].start); sources.push(source);
        }
        const frame = async now => {
          if (signal.aborted || rec.state === 'inactive') return;
          try {
            const elapsed = (now - start) / 1000, index = Math.min(plan.frames - 1, Math.floor(elapsed * 30)), info = V.at(plan, index);
            await renderer.draw(info, texts[info.item.index]);
            $('video-progress').value = Math.min(95, elapsed / plan.duration * 95);
            status(`兼容模式：${Math.min(elapsed, plan.duration).toFixed(1)} / ${plan.duration.toFixed(1)} 秒`);
            if (elapsed >= plan.duration) rec.stop(); else raf = requestAnimationFrame(frame);
          } catch (err) { drawError = err; if (rec.state !== 'inactive') rec.stop(); }
        };
        raf = requestAnimationFrame(frame);
      });
    } finally {
      cancelAnimationFrame(raf); sources.forEach(s => { try { s.stop(); } catch {} s.disconnect(); });
      stream.getTracks().forEach(t => t.stop()); destination?.disconnect();
    }
  }

  async function generate() {
    if (busy || !snapshot) return;
    if (recordPending || recorder?.state === 'recording') return error(new Error('请先停止并保存录音。'));
    let renderer, wake, audioContext;
    controller = new AbortController(); const signal = controller.signal;
    setBusy(true); ++previewVersion; if (previewRenderer) { previewRenderer.dispose(); previewRenderer = null; }
    $('video-error').hidden = true; $('video-progress-panel').hidden = false; $('video-progress').value = 0;
    $('video-result-actions').hidden = true; $('video-result').pause(); $('video-result').hidden = true; canvas.hidden = false;
    status('准备导出…');
    const settings = options(), { steps, indices } = selected();
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    try {
      // Unlock the audio context directly within the user's click, before async work.
      if (settings.audio !== 'mute' && Context) { audioContext = new Context(); await audioContext.resume(); }
      try { wake = await navigator.wakeLock?.request('screen'); } catch { /* Optional enhancement. */ }
      const audios = await audioFor(steps, indices, settings.audio, signal); check(signal);
      renderer = await new FrameRenderer(snapshot, settings, canvas).init(); check(signal);
      const texts = steps.map(s => renderer.text(s));
      const plan = V.timeline(steps, audios.map(b => b?.duration || 0), texts.map(t => t.pages.length), 30, indices);
      if (plan.duration > 600) throw new Error('本次视频超过 10 分钟。为避免手机内存不足，请选择「当前步骤」分段导出，或缩短讲解后重试。');
      $('video-summary').textContent = `${settings.view.toUpperCase()} · ${canvas.width} × ${canvas.height} · 30 帧/秒 · ${plan.duration.toFixed(1)} 秒`;
      const M = await loadMedia(), bitrate = settings.quality === 1080 ? 6500000 : 3500000;
      check(signal);
      const canVideo = await M.canEncodeVideo('avc', { width: canvas.width, height: canvas.height, frameRate: 30, quality: new M.Quality({ bitrate }) });
      const canAudio = !audios.some(Boolean) || await M.canEncodeAudio('aac', { numberOfChannels: 1, sampleRate: RATE, quality: new M.Quality({ bitrate: 96000 }) });
      $('video-codec-status').textContent = canVideo && canAudio ? '本机逐帧生成 · MP4 / H.264' : '兼容录制模式 · MP4 / H.264';
      resultBlob = canVideo && canAudio ? await webCodecsExport(M, renderer, plan, texts, audios, signal, bitrate) : await recorderExport(renderer, plan, texts, audios, signal, bitrate, audioContext);
      check(signal);
      if (!V.isMp4(await resultBlob.slice(0, 16).arrayBuffer())) throw new Error('浏览器未生成有效的 MP4 文件，请换用最新版浏览器重试。');
      if (resultURL) URL.revokeObjectURL(resultURL); resultURL = URL.createObjectURL(resultBlob);
      const name = `${V.filename(snapshot.tactic.title)}_${settings.view.toUpperCase()}_${settings.orientation === 'portrait' ? '竖屏' : '横屏'}_${settings.quality}p.mp4`;
      $('video-download').href = resultURL; $('video-download').download = name;
      $('video-result').src = resultURL; $('video-result').hidden = false; canvas.hidden = true;
      $('video-result-actions').hidden = false; $('video-progress').value = 100;
      status(`生成完成 · ${(resultBlob.size / 1024 / 1024).toFixed(1)} MB。可以播放检查，再下载或保存。`);
    } catch (err) {
      if (signal.aborted) status(signal.reason?.message || '已取消导出，可调整设置后重试。'); else { error(err); status('未生成文件，原战术与录音均已保留。'); }
    } finally {
      renderer?.dispose(); await audioContext?.close().catch(() => {}); await wake?.release().catch(() => {}); setBusy(false);
      if (closeAfterCancel) { closeAfterCancel = false; dialog.close(); }
    }
  }

  $('video-export-open').onclick = () => {
    snapshot = window.CourtroomApp.snapshot(); $('export-menu').hidden = true;
    $('video-view').value = snapshot.viewMode; $('video-quality').value = matchMedia('(max-width:700px)').matches ? '720' : '1080';
    $('video-orientation').value = matchMedia('(max-width:700px)').matches ? 'portrait' : 'landscape';
    $('record-step').replaceChildren(...snapshot.tactic.steps.map((s, i) => { const option = document.createElement('option'); option.value = i; option.textContent = `${i + 1}. ${s.title}`; return option; }));
    $('record-step').value = snapshot.idx;
    if (!recordPending) { $('record-start').disabled = false; $('record-stop').disabled = true; $('record-step').disabled = false; $('record-upload').disabled = false; $('video-generate').disabled = false; }
    $('video-error').hidden = true; $('video-progress-panel').hidden = true; $('video-result-actions').hidden = true;
    dialog.showModal(); audioPanels(); preview();
  };
  for (const id of ['video-view', 'video-range', 'video-orientation', 'video-quality']) $(id).onchange = preview;
  $('video-audio').onchange = () => { audioPanels(); preview(); };
  $('video-generate').onclick = generate;
  $('video-cancel').onclick = () => controller?.abort(new DOMException('已取消导出，可调整设置后重试。', 'AbortError'));
  function close() {
    ++recordAttempt;
    if (!recordSaving && recorder?.state !== 'recording') recordPending = false;
    if (busy) { closeAfterCancel = true; controller?.abort(new DOMException('已取消视频导出。', 'AbortError')); return; }
    if (recorder?.state === 'recording') { recorder.stop(); }
    ++previewVersion; previewRenderer?.dispose(); previewRenderer = null; $('tts-preview').pause(); $('record-preview').pause(); dialog.close();
  }
  $('video-close').onclick = close; dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
  $('record-step').onchange = showRecording;
  $('record-start').onclick = async () => {
    if (recordPending || recorder?.state === 'recording') return;
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) return error(new Error('当前页面无法使用麦克风。请通过 HTTPS 或本机 localhost 打开；也可上传已有录音。'));
    const step = chosenRecordingStep(), tacticId = snapshot.tactic.id, attempt = ++recordAttempt;
    recordPending = true; $('record-start').disabled = true; $('video-generate').disabled = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (attempt !== recordAttempt || !dialog.open) { stream.getTracks().forEach(t => t.stop()); return; }
      recordingStream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t));
      const localRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined), chunks = [];
      recorder = localRecorder;
      localRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      localRecorder.onstop = async () => {
        recordSaving = true;
        clearInterval(recordClock); stream.getTracks().forEach(t => t.stop()); dialog.classList.remove('recording');
        $('record-stop').disabled = true;
        try {
          const blob = new Blob(chunks, { type: localRecorder.mimeType || 'audio/webm' });
          const decoded = await decode(blob);
          if (decoded.duration < .2) throw new Error('录音太短，请重新录制。');
          const saved = await saveRecording(step, blob, decoded.duration, tacticId);
          if (dialog.open && snapshot.tactic.id === tacticId) { await showRecording(); if (!saved) $('record-status').textContent = '当前浏览器不能持久保存录音，本次页面内可正常导出。'; }
        } catch (err) { if (dialog.open && snapshot.tactic.id === tacticId) error(err); }
        finally { recordSaving = false; recordPending = false; $('record-start').disabled = false; $('record-step').disabled = false; $('record-upload').disabled = false; $('video-generate').disabled = false; }
      };
      recorder.onerror = () => { if (recorder.state !== 'inactive') recorder.stop(); error(new Error('录音中断，请检查麦克风后重试。')); };
      recorder.start(1000); recordStarted = Date.now(); dialog.classList.add('recording');
      $('record-start').disabled = true; $('record-stop').disabled = false; $('record-step').disabled = true; $('record-upload').disabled = true; $('video-generate').disabled = true;
      recordClock = setInterval(() => $('record-status').textContent = `正在录音 · ${((Date.now() - recordStarted) / 1000).toFixed(0)} 秒，点击「停止」保存。`, 250);
    } catch (err) {
      stream?.getTracks().forEach(t => t.stop());
      if (attempt === recordAttempt) {
        if (dialog.open) error(new Error(err.name === 'NotAllowedError' ? '麦克风权限未开启。请在浏览器允许录音，或上传已有录音文件。' : '无法开始录音，请检查麦克风，或上传录音文件。'));
        recordPending = false; $('record-start').disabled = false; $('video-generate').disabled = false;
      }
    }
  };
  $('record-stop').onclick = () => { if (recorder?.state === 'recording') recorder.stop(); };
  $('record-upload').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const step = chosenRecordingStep(), tacticId = snapshot.tactic.id;
    recordPending = true; recordSaving = true;
    for (const id of ['record-start','record-step','record-upload','video-generate']) $(id).disabled = true;
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('请选择 25 MB 以内的录音文件。');
      const decoded = await decode(file); await saveRecording(step, file, decoded.duration, tacticId);
      if (dialog.open && snapshot.tactic.id === tacticId) { await showRecording(); $('video-error').hidden = true; }
    } catch { error(new Error('无法读取这段录音。请选择可播放的 MP3、M4A、WAV 或 WebM 文件。')); }
    finally { recordPending = false; recordSaving = false; for (const id of ['record-start','record-step','record-upload','video-generate']) $(id).disabled = false; }
    e.target.value = '';
  };
  $('record-delete').onclick = async () => { await deleteRecording(chosenRecordingStep()); await showRecording(); };
  $('tts-preview-button').onclick = async () => {
    $('tts-preview-button').disabled = true; $('video-error').hidden = true;
    try {
      const step = snapshot.tactic.steps[snapshot.idx];
      const buffer = await Voice.synthesize(`第${snapshot.idx + 1}步，${step.title}。${step.notes || ''}`, s => $('tts-status').textContent = s);
      if (ttsURL) URL.revokeObjectURL(ttsURL); ttsURL = URL.createObjectURL(wav(buffer));
      $('tts-preview').src = ttsURL; $('tts-preview').hidden = false; $('tts-status').textContent = `试听已生成 · ${buffer.duration.toFixed(1)} 秒，点击播放即可试听。`;
    } catch (err) { error(err); } finally { $('tts-preview-button').disabled = false; }
  };
  $('video-share').onclick = async () => {
    if (!resultBlob) return;
    const file = new File([resultBlob], $('video-download').download, { type: 'video/mp4' });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: snapshot.tactic.title });
      else { $('video-download').click(); window.CourtroomApp.notify('已开始下载。如需发送给队友，可在手机文件中选择此 MP4。'); }
    } catch (err) { if (err.name !== 'AbortError') error(new Error('暂时无法分享，请使用「下载 MP4」保存后再发送。')); }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && busy) controller?.abort(new DOMException('页面切到后台，已停止本次导出。请保持页面在前台后重新生成。', 'AbortError'));
    if (document.hidden && recorder?.state === 'recording') recorder.stop();
  });
})();
