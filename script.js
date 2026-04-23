/* =====================================================================
   CONFIGURATION — audio clips
   ---------------------------------------------------------------------
   Edit this list to add/remove clips. The S3 bucket must allow public
   GetObject and CORS from the origin serving this page.
===================================================================== */
const SAMPLE_CLIPS = [
  { name: "Debussy — Suite bergamasque",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Bergamasque.mp3" },
  { name: "Bernstein — Chichester Psalms (Choir and Orchestra)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Bernstein+-+Chichester+Psalms+(Choir+and+Orchestra).mp3" },
  { name: "Brahms — Op. 78 (viola and piano)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Brahms+-+Op.78+(viola+and+piano).mp3" },
  { name: "Farías — Andean Suite (guitar and string quartet)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Fari%CC%81as+-+Andean+Suite+(guitar+and+string+quartet).mp3" },
  { name: "Fauré — Fantasie (tuba and piano)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Faure%CC%81+-+Fantasie+(tuba+and+piano).mp3" },
  { name: "Prokofiev — Sonata No. 2 Op. 14 (solo piano)",
    url: "https://ysm-assets-for-livestream.s3.us-east-1.amazonaws.com/mp3s/Prokofiev+-+Sonata+No.+2+Op.+14+(solo+piano).mp3" },
];

/* =====================================================================
   CONSTANTS
===================================================================== */
const QUIZ_FREQS = [100, 250, 500, 1000, 2000, 4000, 8000];
const DIFFICULTY = {
  easy:   { gain: 18, Q: 12 },
  medium: { gain: 9, Q: 9 },
  hard:   { gain: 4.5, Q: 6 },
};
let quizDifficulty = "easy";
const FREQ_STOPS = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

/* =====================================================================
   AUDIO ENGINE
===================================================================== */
let ctx = null;
let filter, masterGain, analyser;
// Mono/Stereo graph nodes
let msInput, msSplitter, msMerger, msStereoGain, msMonoGain;
// Stereo vectorscope per-channel analysers
let vizSplitter, leftAnalyser, rightAnalyser;
let currentSource = null;
let isPlaying = false;
let pinkBuffer = null;

// Which top-level tool is active: "eq" or "monoStereo" — drives the audio graph.
let currentTool = "monoStereo";

// Track playback position so we can "pause" (Web Audio sources are one-shot)
let sourceStartTime = 0;   // ctx.currentTime when the source started
let sourceOffset = 0;      // where in the buffer playback is currently at (seconds)
let currentBufferDuration = 0;

// The currently-active UI element (dropzone or sample-btn) that is "playing".
let activeSourceEl = null;

const bufferCache = new Map();

function ensureCtx() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();

  filter = ctx.createBiquadFilter();
  filter.type = "peaking";
  filter.frequency.value = 1000;
  filter.gain.value = 0;
  filter.Q.value = 1;

  masterGain = ctx.createGain();
  masterGain.gain.value = 0.85;

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;

  // --- Mono/Stereo graph (always built; we route through it only when the
  // Mono/Stereo tool is active). The source connects to msInput. msInput fans
  // out to two paths and we crossfade with the two gain nodes:
  //   msInput -> msStereoGain -> masterGain         (stereo path)
  //   msInput -> msSplitter -(L,R)-> msMerger(0) -> msMonoGain -> masterGain
  msInput = ctx.createGain();
  msStereoGain = ctx.createGain();
  msStereoGain.gain.value = 1;
  msMonoGain = ctx.createGain();
  msMonoGain.gain.value = 0;
  msSplitter = ctx.createChannelSplitter(2);
  msMerger = ctx.createChannelMerger(1);

  msInput.connect(msStereoGain);
  msStereoGain.connect(masterGain);

  msInput.connect(msSplitter);
  msSplitter.connect(msMerger, 0, 0);
  msSplitter.connect(msMerger, 1, 0);
  msMerger.connect(msMonoGain);
  msMonoGain.connect(masterGain);

  filter.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(ctx.destination);

  // --- Stereo vectorscope: per-channel analysers tapped off masterGain ---
  vizSplitter = ctx.createChannelSplitter(2);
  leftAnalyser = ctx.createAnalyser();
  leftAnalyser.fftSize = 1024;
  leftAnalyser.smoothingTimeConstant = 0;
  rightAnalyser = ctx.createAnalyser();
  rightAnalyser.fftSize = 1024;
  rightAnalyser.smoothingTimeConstant = 0;
  masterGain.connect(vizSplitter);
  vizSplitter.connect(leftAnalyser, 0);
  vizSplitter.connect(rightAnalyser, 1);

  return ctx;
}

/** Returns the node a buffer source should connect to for the active tool. */
function currentInputNode() {
  ensureCtx();
  return currentTool === "monoStereo" ? msInput : filter;
}

function createPinkNoise(durationSec = 4) {
  ensureCtx();
  const length = ctx.sampleRate * durationSec;
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      // Target ~60% of original perceived loudness — amplitude ~0.4 gives ~-8dB.
      data[i] = pink * 0.4;
    }
  }
  return buf;
}

async function loadUrl(url) {
  if (bufferCache.has(url)) return bufferCache.get(url);
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error("Fetch failed: " + resp.status);
  const arr = await resp.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);
  bufferCache.set(url, buf);
  return buf;
}

async function decodeFile(file) {
  ensureCtx();
  const arr = await file.arrayBuffer();
  return await ctx.decodeAudioData(arr);
}

function stop() {
  if (currentSource) {
    try { currentSource.onended = null; } catch (e) {}
    try { currentSource.stop(); } catch (e) {}
    try { currentSource.disconnect(); } catch (e) {}
    currentSource = null;
  }
  isPlaying = false;
  sourceOffset = 0;
  currentBufferDuration = 0;
  setActiveSourceEl(null);
}

/**
 * Start a buffer playing (always looping for our UI). Optional startOffset to
 * resume from a point.
 */
function playBuffer(buf, startOffset = 0) {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();

  // Kill any previous source without nuking the active-el UI state yet.
  if (currentSource) {
    try { currentSource.onended = null; } catch (e) {}
    try { currentSource.stop(); } catch (e) {}
    try { currentSource.disconnect(); } catch (e) {}
    currentSource = null;
  }

  if (!buf) return;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(currentInputNode());
  src.start(0, startOffset % buf.duration);
  currentSource = src;
  sourceStartTime = ctx.currentTime;
  sourceOffset = startOffset % buf.duration;
  currentBufferDuration = buf.duration;
  isPlaying = true;
}

/* =====================================================================
   PLAY MODE — EQ controls
===================================================================== */
function sliderToFreq(v) {
  const i = Math.max(0, Math.min(FREQ_STOPS.length - 1, Math.round(+v)));
  return FREQ_STOPS[i];
}

const freqSlider = document.getElementById("freqSlider");
const gainSlider = document.getElementById("gainSlider");
const qSlider = document.getElementById("qSlider");
const freqVal = document.getElementById("freqVal");
const gainVal = document.getElementById("gainVal");
const qVal = document.getElementById("qVal");
const bypassBtn = document.getElementById("bypassBtn");

let bypass = false;

function applyEQ() {
  if (!ctx) return;
  const f = sliderToFreq(+freqSlider.value);
  const g = +gainSlider.value;
  const q = +qSlider.value;
  filter.frequency.setTargetAtTime(f, ctx.currentTime, 0.01);
  filter.gain.setTargetAtTime(bypass ? 0 : g, ctx.currentTime, 0.01);
  filter.Q.setTargetAtTime(q, ctx.currentTime, 0.01);
  drawEQ(f, bypass ? 0 : g, q);
}

function updateReadouts() {
  const f = sliderToFreq(+freqSlider.value);
  const unitEl = document.getElementById("freqUnit");
  if (f >= 1000) {
    freqVal.textContent = f / 1000;
    unitEl.textContent = "kHz";
  } else {
    freqVal.textContent = f;
    unitEl.textContent = "Hz";
  }
  const g = +gainSlider.value;
  gainVal.textContent = (g > 0 ? "+" : "") + g;
  qVal.textContent = +qSlider.value;
}

[freqSlider, gainSlider, qSlider].forEach((el) => {
  el.addEventListener("input", () => { updateReadouts(); applyEQ(); });
});

bypassBtn.addEventListener("click", () => {
  bypass = !bypass;
  bypassBtn.classList.toggle("active", bypass);
  bypassBtn.textContent = bypass ? "Bypassed" : "Bypass";
  applyEQ();
});

/* =====================================================================
   PLAY MODE — sources (dropzone + sample-list with integrated play/pause)
===================================================================== */

// Each "source element" (dropzone or sample-btn) has its own buffer. We track
// them via a WeakMap so we don't litter the DOM with data attributes.
const sourceBuffers = new WeakMap();

function setSourceBuffer(el, buffer, filename) {
  sourceBuffers.set(el, { buffer, filename });
}
function getSourceBuffer(el) {
  return sourceBuffers.get(el);
}

/**
 * Toggle playback for a specific source element. If it's currently playing,
 * pause (remember offset for resume). If a different source is playing, stop
 * that and start this one. If this one is paused, resume from offset.
 */
function togglePlayback(el, buffer) {
  if (!buffer) return;
  if (activeSourceEl === el && isPlaying) {
    // Pause — stash offset.
    const elapsed = ctx.currentTime - sourceStartTime;
    const offset = (sourceOffset + elapsed) % buffer.duration;
    if (currentSource) {
      try { currentSource.onended = null; } catch (e) {}
      try { currentSource.stop(); } catch (e) {}
      try { currentSource.disconnect(); } catch (e) {}
      currentSource = null;
    }
    isPlaying = false;
    sourceOffset = offset;
    // Keep activeSourceEl so UI still shows this as "selected" but not playing
    refreshSourceUI();
    return;
  }
  if (activeSourceEl === el && !isPlaying) {
    // Resume
    playBuffer(buffer, sourceOffset);
    refreshSourceUI();
    return;
  }
  // Switching to a new source.
  sourceOffset = 0;
  playBuffer(buffer, 0);
  setActiveSourceEl(el);
}

function setActiveSourceEl(el) {
  activeSourceEl = el;
  refreshSourceUI();
}

function refreshSourceUI() {
  // Reset all sample-btn + dropzone state in both panels.
  document.querySelectorAll(".sample-btn").forEach((b) => {
    b.classList.remove("active");
    b.style.setProperty("--progress", "0%");
    const icon = b.querySelector(".play-icon");
    if (icon) icon.textContent = "▶";
  });
  document.querySelectorAll(".dropzone").forEach((d) => {
    d.classList.remove("playing");
    if (!d.classList.contains("loaded")) {
      d.style.setProperty("--progress", "0%");
    }
  });

  if (!activeSourceEl) return;

  if (activeSourceEl.classList.contains("sample-btn")) {
    activeSourceEl.classList.add("active");
    const icon = activeSourceEl.querySelector(".play-icon");
    if (icon) icon.textContent = isPlaying ? "❚❚" : "▶";
  } else if (activeSourceEl.classList.contains("dropzone")) {
    activeSourceEl.classList.toggle("playing", isPlaying);
    const icon = activeSourceEl.querySelector(".dz-icon");
    if (icon) icon.textContent = isPlaying ? "❚❚" : "▶";
  }
}

// Dropzone (Play Mode)
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const dropzoneIcon = document.getElementById("dropzoneIcon");
const dropzoneTitle = document.getElementById("dropzoneTitle");
const dropzoneHint = document.getElementById("dropzoneHint");

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleFile(file);
  // allow re-choosing the same file
  fileInput.value = "";
});

["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
);
dropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleFile(file);
});

dropzone.addEventListener("click", (e) => {
  // If loaded, clicking toggles play/pause. Otherwise, open the file picker.
  const entry = getSourceBuffer(dropzone);
  if (entry && entry.buffer) {
    togglePlayback(dropzone, entry.buffer);
  } else {
    fileInput.click();
  }
});

async function handleFile(file) {
  try {
    const buf = await decodeFile(file);
    setSourceBuffer(dropzone, buf, file.name);
    markDropzoneLoaded(dropzone, file.name);
    togglePlayback(dropzone, buf);
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

function markDropzoneLoaded(dz, filename) {
  dz.classList.add("loaded");
  const icon = dz.querySelector(".dz-icon");
  const title = dz.querySelector(".dz-title");
  const hint = dz.querySelector(".dz-hint");
  if (icon) icon.textContent = "▶";
  if (title) title.textContent = filename;
  if (hint) hint.textContent = "click to play / pause";
}

// Sample list (Play Mode)
const sampleList = document.getElementById("sampleList");

function buildSampleList() {
  Array.from(sampleList.querySelectorAll("[data-clip]")).forEach((n) => n.remove());
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.source = "clip";
    btn.dataset.clip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => handlePlaySampleBtn(btn, clip));
    sampleList.appendChild(btn);
  });
}

async function handlePlaySampleBtn(btn, clipOrSpecial) {
  ensureCtx();
  // If this btn already has a buffer cached on it, just toggle.
  const existing = getSourceBuffer(btn);
  if (existing && existing.buffer) {
    togglePlayback(btn, existing.buffer);
    return;
  }

  // Loading path — show a spinner in the play icon.
  const icon = btn.querySelector(".play-icon");
  const originalIconText = icon.textContent;
  icon.textContent = "…";

  try {
    let buf;
    if (clipOrSpecial === "pink") {
      if (!pinkBuffer) pinkBuffer = createPinkNoise(4);
      buf = pinkBuffer;
    } else {
      buf = await loadUrl(clipOrSpecial.url);
    }
    setSourceBuffer(btn, buf);
    togglePlayback(btn, buf);
  } catch (err) {
    alert("Could not load clip: " + err.message + "\n\nMake sure the S3 bucket allows CORS GET from this origin.");
    icon.textContent = originalIconText;
  }
}

// Pink noise in Play mode is a sample-btn (first one in the list).
document.querySelector('#sampleList [data-source="pink"]')
  .addEventListener("click", function () {
    handlePlaySampleBtn(this, "pink");
  });

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* =====================================================================
   PROGRESS TICKER
===================================================================== */
function progressTick() {
  if (isPlaying && currentBufferDuration > 0 && activeSourceEl) {
    const elapsed = ctx.currentTime - sourceStartTime;
    const pos = ((sourceOffset + elapsed) % currentBufferDuration) / currentBufferDuration;
    const pct = (pos * 100).toFixed(2) + "%";
    activeSourceEl.style.setProperty("--progress", pct);
  }
  requestAnimationFrame(progressTick);
}
requestAnimationFrame(progressTick);

/* =====================================================================
   EQ CURVE VISUALIZATION
===================================================================== */
const canvas = document.getElementById("eqCanvas");
const cctx = canvas.getContext("2d");

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const f = ctx ? filter.frequency.value : sliderToFreq(+freqSlider.value);
  const g = ctx ? filter.gain.value : +gainSlider.value;
  const q = ctx ? filter.Q.value : +qSlider.value;
  drawEQ(f, g, q);
}
window.addEventListener("resize", resizeCanvas);

function drawEQ(freqHz, gainDb, qVal) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  cctx.clearRect(0, 0, w, h);

  const bgGrad = cctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, "#fbfcff");
  bgGrad.addColorStop(1, "#f3f7ff");
  cctx.fillStyle = bgGrad;
  cctx.fillRect(0, 0, w, h);

  const minLog = Math.log10(20), maxLog = Math.log10(20000);
  const gridFreqs = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000];
  cctx.strokeStyle = "rgba(29, 35, 48, 0.06)";
  cctx.lineWidth = 1;
  cctx.font = "10px Inter, sans-serif";
  cctx.fillStyle = "rgba(29, 35, 48, 0.35)";
  cctx.textAlign = "center";
  gridFreqs.forEach((f) => {
    const x = ((Math.log10(f) - minLog) / (maxLog - minLog)) * w;
    cctx.beginPath();
    cctx.moveTo(x, 0);
    cctx.lineTo(x, h - 14);
    cctx.stroke();
    const label = f >= 1000 ? (f / 1000) + "k" : f;
    cctx.fillText(label, x, h - 3);
  });

  const dbMax = 18;
  [-12, -6, 0, 6, 12].forEach((db) => {
    const y = ((dbMax - db) / (2 * dbMax)) * (h - 14);
    cctx.strokeStyle = db === 0 ? "rgba(29, 35, 48, 0.18)" : "rgba(29, 35, 48, 0.06)";
    cctx.beginPath();
    cctx.moveTo(0, y);
    cctx.lineTo(w, y);
    cctx.stroke();
    if (db !== 0) {
      cctx.fillStyle = "rgba(29, 35, 48, 0.25)";
      cctx.textAlign = "left";
      cctx.fillText((db > 0 ? "+" : "") + db, 4, y - 2);
    }
  });

  const N = Math.max(256, Math.floor(w));
  const freqs = new Float32Array(N);
  const mag = new Float32Array(N);
  const phase = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    freqs[i] = Math.pow(10, minLog + t * (maxLog - minLog));
  }

  if (ctx && filter) {
    const liveFilter = ctx.createBiquadFilter();
    liveFilter.type = "peaking";
    liveFilter.frequency.value = freqHz;
    liveFilter.gain.value = gainDb;
    liveFilter.Q.value = qVal;
    liveFilter.getFrequencyResponse(freqs, mag, phase);
  } else {
    for (let i = 0; i < N; i++) {
      mag[i] = magPeaking(freqs[i], freqHz, gainDb, qVal, 44100);
    }
  }

  cctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * w;
    const db = 20 * Math.log10(mag[i]);
    const y = ((dbMax - db) / (2 * dbMax)) * (h - 14);
    if (i === 0) cctx.moveTo(x, y);
    else cctx.lineTo(x, y);
  }
  const zeroY = (dbMax / (2 * dbMax)) * (h - 14);
  cctx.lineTo(w, zeroY);
  cctx.lineTo(0, zeroY);
  cctx.closePath();

  const curveFill = cctx.createLinearGradient(0, 0, 0, h);
  if (gainDb >= 0) {
    curveFill.addColorStop(0, "rgba(255, 138, 122, 0.35)");
    curveFill.addColorStop(1, "rgba(255, 209, 102, 0.1)");
  } else {
    curveFill.addColorStop(0, "rgba(124, 188, 255, 0.1)");
    curveFill.addColorStop(1, "rgba(124, 188, 255, 0.35)");
  }
  cctx.fillStyle = curveFill;
  cctx.fill();

  cctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * w;
    const db = 20 * Math.log10(mag[i]);
    const y = ((dbMax - db) / (2 * dbMax)) * (h - 14);
    if (i === 0) cctx.moveTo(x, y);
    else cctx.lineTo(x, y);
  }
  cctx.strokeStyle = gainDb >= 0 ? "#ff8a7a" : "#7cbcff";
  cctx.lineWidth = 2.5;
  cctx.stroke();

  const px = ((Math.log10(freqHz) - minLog) / (maxLog - minLog)) * w;
  const py = ((dbMax - gainDb) / (2 * dbMax)) * (h - 14);
  cctx.beginPath();
  cctx.arc(px, py, 7, 0, Math.PI * 2);
  cctx.fillStyle = "#fff";
  cctx.fill();
  cctx.strokeStyle = gainDb >= 0 ? "#ff8a7a" : "#7cbcff";
  cctx.lineWidth = 3;
  cctx.stroke();
}

// RBJ cookbook peaking filter magnitude — fallback only
function magPeaking(f, f0, dbGain, Q, fs) {
  const A = Math.pow(10, dbGain / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosW0 = Math.cos(w0);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cosW0;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha / A;

  const w = 2 * Math.PI * f / fs;
  const cosW = Math.cos(w), sinW = Math.sin(w);
  const cos2W = Math.cos(2 * w), sin2W = Math.sin(2 * w);

  const numRe = b0 + b1 * cosW + b2 * cos2W;
  const numIm = -b1 * sinW - b2 * sin2W;
  const denRe = a0 + a1 * cosW + a2 * cos2W;
  const denIm = -a1 * sinW - a2 * sin2W;

  const numMag = Math.sqrt(numRe * numRe + numIm * numIm);
  const denMag = Math.sqrt(denRe * denRe + denIm * denIm);
  return numMag / denMag;
}

/* =====================================================================
   MODE SWITCHING
===================================================================== */
const modePlay = document.getElementById("modePlay");
const modeQuiz = document.getElementById("modeQuiz");
const playPanel = document.getElementById("playPanel");
const quizPanel = document.getElementById("quizPanel");

modePlay.addEventListener("click", () => setMode("play"));
modeQuiz.addEventListener("click", () => setMode("quiz"));

function setMode(m) {
  stop();
  if (m === "play") {
    modePlay.classList.add("active");
    modeQuiz.classList.remove("active");
    playPanel.style.display = "";
    quizPanel.classList.remove("visible");
    applyEQ();
  } else {
    modeQuiz.classList.add("active");
    modePlay.classList.remove("active");
    playPanel.style.display = "none";
    quizPanel.classList.add("visible");
    // Do NOT auto-start anything; user must pick a source.
    updateQuizUI();
  }
}

/* =====================================================================
   QUIZ MODE
===================================================================== */
const quizState = {
  phase: "idle",        // "idle" | "guessing" | "revealed"
  currentFreq: null,
  guessed: null,
  source: null,         // null | "pink" | "file" | clip index (number)
  userBuffer: null,
  userFileName: null,
  toggle: "eq",         // "dry" | "eq"
  correct: 0,
  total: 0,
};

const freqGuess = document.getElementById("freqGuess");
const scorePill = document.getElementById("scorePill");
const quizFeedback = document.getElementById("quizFeedback");
const quizAction = document.getElementById("quizAction");
const dryEqToggle = document.getElementById("dryEqToggle");
const quizSampleList = document.getElementById("quizSampleList");
const quizDropzone = document.getElementById("quizDropzone");
const quizFileInput = document.getElementById("quizFileInput");
const quizDropzoneIcon = document.getElementById("quizDropzoneIcon");
const quizDropzoneTitle = document.getElementById("quizDropzoneTitle");
const quizDropzoneHint = document.getElementById("quizDropzoneHint");
const diffGroup = document.getElementById("diffGroup");

function fmtQuizFreq(hz) {
  return hz >= 1000 ? (hz / 1000) + "k" : String(hz);
}

function buildQuizButtons() {
  freqGuess.innerHTML = "";
  QUIZ_FREQS.forEach((f) => {
    const btn = document.createElement("button");
    btn.className = "freq-btn";
    btn.textContent = fmtQuizFreq(f) + " Hz";
    btn.dataset.freq = String(f);
    btn.disabled = true;
    btn.addEventListener("click", () => makeGuess(f, btn));
    freqGuess.appendChild(btn);
  });
}

function buildQuizSources() {
  Array.from(quizSampleList.querySelectorAll("[data-qclip]")).forEach((n) => n.remove());
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.qsource = "clip";
    btn.dataset.qclip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => selectQuizClip(i, btn));
    quizSampleList.appendChild(btn);
  });
}

// Pink-noise quiz-source listener — attached once
document.querySelector('#quizSampleList [data-qsource="pink"]').addEventListener("click", function () {
  selectQuizSource("pink", this);
});

async function selectQuizClip(index, btnEl) {
  ensureCtx();
  const icon = btnEl.querySelector(".play-icon");
  const prev = icon ? icon.textContent : "▶";
  if (icon) icon.textContent = "…";
  try {
    await loadUrl(SAMPLE_CLIPS[index].url);
    selectQuizSource(index, btnEl);
  } catch (err) {
    alert("Could not load clip: " + err.message);
    if (icon) icon.textContent = prev;
  }
}

async function selectQuizSource(src, btnEl) {
  ensureCtx();
  const srcEl = (src === "file") ? quizDropzone : btnEl;

  // If clicking the already-active source, toggle play/pause (don't restart).
  if (quizState.source === src && activeSourceEl === srcEl) {
    try {
      const buf = await getQuizBuffer();
      if (!buf) return;
      applyQuizEQ(quizState.toggle === "dry");
      togglePlayback(srcEl, buf);
    } catch (err) {
      alert("Could not load source: " + err.message);
    }
    updateQuizUI();
    return;
  }

  // Switching sources — full selection flow.
  quizState.source = src;

  // UI: mark the selected source element
  quizSampleList.querySelectorAll(".sample-btn").forEach((b) => b.classList.remove("active"));
  quizDropzone.classList.remove("playing");
  if (src === "file") {
    // dropzone is the active one — it already shows .loaded state
  } else if (btnEl) {
    btnEl.classList.add("active");
  }

  // If we're in idle phase, auto-create a question.
  if (quizState.phase === "idle") {
    newQuestion();
  }

  // Make sure the toggle is enabled
  dryEqToggle.setAttribute("aria-disabled", "false");

  // Start playback. Quiz playback defers to the Dry/EQ'd toggle state.
  try {
    const buf = await getQuizBuffer();
    if (!buf) return;
    applyQuizEQ(quizState.toggle === "dry");
    sourceOffset = 0;
    playBuffer(buf, 0);
    // Put the focus/active state on the source UI element
    setActiveSourceEl(srcEl);
  } catch (err) {
    alert("Could not load source: " + err.message);
  }

  updateQuizUI();
}

// Quiz drop zone
quizFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleQuizFile(file);
  quizFileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  quizDropzone.addEventListener(ev, (e) => { e.preventDefault(); quizDropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  quizDropzone.addEventListener(ev, (e) => { e.preventDefault(); quizDropzone.classList.remove("dragover"); })
);
quizDropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleQuizFile(file);
});

quizDropzone.addEventListener("click", () => {
  if (quizState.userBuffer) {
    // Clicking a loaded quiz dropzone selects it (and auto-plays)
    selectQuizSource("file", null);
  } else {
    quizFileInput.click();
  }
});

async function handleQuizFile(file) {
  try {
    const buf = await decodeFile(file);
    quizState.userBuffer = buf;
    quizState.userFileName = file.name;
    markDropzoneLoaded(quizDropzone, file.name);
    await selectQuizSource("file", null);
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

async function getQuizBuffer() {
  ensureCtx();
  if (quizState.source === "pink") {
    if (!pinkBuffer) pinkBuffer = createPinkNoise(4);
    return pinkBuffer;
  }
  if (quizState.source === "file") {
    return quizState.userBuffer;
  }
  if (typeof quizState.source === "number") {
    const clip = SAMPLE_CLIPS[quizState.source];
    return await loadUrl(clip.url);
  }
  return null;
}

function applyQuizEQ(bypassThis = false) {
  if (!ctx) return;
  const diff = DIFFICULTY[quizDifficulty];
  if (bypassThis) {
    filter.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
  } else {
    filter.frequency.setTargetAtTime(quizState.currentFreq || 1000, ctx.currentTime, 0.005);
    filter.gain.setTargetAtTime(diff.gain, ctx.currentTime, 0.005);
    filter.Q.setTargetAtTime(diff.Q, ctx.currentTime, 0.005);
  }
}

/* ---------- Dry/EQ'd toggle ---------- */
function setToggleState(newVal, animate = true) {
  quizState.toggle = newVal;
  dryEqToggle.setAttribute("aria-checked", newVal === "eq" ? "true" : "false");
  // Live-switch the filter without restarting audio
  applyQuizEQ(newVal === "dry");
}

function handleToggleClick() {
  if (dryEqToggle.getAttribute("aria-disabled") === "true") return;
  if (quizState.source == null) return;
  if (quizState.phase === "idle") return;
  setToggleState(quizState.toggle === "eq" ? "dry" : "eq");
}

dryEqToggle.addEventListener("click", handleToggleClick);
dryEqToggle.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    handleToggleClick();
  }
});

/* ---------- Difficulty picker ---------- */
diffGroup.querySelectorAll(".diff-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const d = btn.dataset.diff;
    if (!DIFFICULTY[d]) return;
    quizDifficulty = d;
    diffGroup.querySelectorAll(".diff-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    // Re-apply EQ with the new difficulty if a question is active
    if (quizState.phase !== "idle") {
      applyQuizEQ(quizState.toggle === "dry");
    }
  });
});

/* ---------- Guess / reveal / next ---------- */
function makeGuess(hz, btnEl) {
  if (quizState.phase !== "guessing") return;
  quizState.guessed = hz;
  freqGuess.querySelectorAll(".freq-btn").forEach((b) => b.classList.remove("selected"));
  btnEl.classList.add("selected");
  updateQuizUI();
}

function newQuestion() {
  if (quizState.source == null) return;

  // Pick a different frequency than the last one when possible.
  let f;
  do { f = QUIZ_FREQS[Math.floor(Math.random() * QUIZ_FREQS.length)]; }
  while (quizState.currentFreq && f === quizState.currentFreq && QUIZ_FREQS.length > 1);

  quizState.currentFreq = f;
  quizState.guessed = null;
  quizState.phase = "guessing";
  // Default back to EQ'd on a new question, so the ear hears the boost.
  setToggleState("eq");

  // Clear any reveal markings on the freq buttons.
  freqGuess.querySelectorAll(".freq-btn").forEach((b) =>
    b.classList.remove("selected", "correct", "wrong")
  );

  // Update the filter for the new question. If audio is already playing, it
  // continues — the EQ freq just shifts underneath.
  if (ctx) applyQuizEQ(quizState.toggle === "dry");

  updateQuizUI();
}

function revealAnswer() {
  if (quizState.phase !== "guessing" || quizState.guessed == null) return;

  quizState.phase = "revealed";
  quizState.total += 1;
  const correct = quizState.guessed === quizState.currentFreq;
  if (correct) quizState.correct += 1;

  freqGuess.querySelectorAll(".freq-btn").forEach((b) => {
    const f = +b.dataset.freq;
    if (f === quizState.currentFreq) b.classList.add("correct");
    else if (f === quizState.guessed) b.classList.add("wrong");
  });

  quizFeedback.textContent = correct
    ? "Nice — that's right!"
    : `Nope — it was ${fmtQuizFreq(quizState.currentFreq)} Hz. You picked ${fmtQuizFreq(quizState.guessed)} Hz.`;
  quizFeedback.className = "feedback " + (correct ? "ok" : "bad");

  scorePill.textContent = `${quizState.correct} / ${quizState.total}`;
  updateQuizUI();
}

quizAction.addEventListener("click", () => {
  if (quizState.phase === "guessing") {
    revealAnswer();
  } else {
    newQuestion();
  }
});

/**
 * Centralized UI state for the Quiz panel.
 */
function updateQuizUI() {
  if (quizState.phase === "idle") {
    quizAction.textContent = "New Question";
    quizAction.disabled = quizState.source == null;
  } else if (quizState.phase === "guessing") {
    quizAction.textContent = "Reveal";
    quizAction.disabled = quizState.guessed == null;
  } else {
    quizAction.textContent = "New Question";
    quizAction.disabled = false;
  }

  const toggleOK = quizState.source != null && quizState.phase !== "idle";
  dryEqToggle.setAttribute("aria-disabled", toggleOK ? "false" : "true");
  dryEqToggle.setAttribute("aria-checked", quizState.toggle === "eq" ? "true" : "false");

  freqGuess.querySelectorAll(".freq-btn").forEach((b) => {
    b.disabled = quizState.phase !== "guessing";
  });

  if (quizState.phase === "idle") {
    quizFeedback.textContent = quizState.source == null
      ? "Select a source to start."
      : "Click New Question to begin.";
    quizFeedback.className = "feedback";
  } else if (quizState.phase === "guessing") {
    quizFeedback.textContent = quizState.guessed == null
      ? "Flip between Dry and EQ'd, then pick a frequency."
      : "Ready — click Reveal.";
    quizFeedback.className = "feedback";
  }
  // "revealed" feedback is set inside revealAnswer() and left alone here.
}

/* =====================================================================
   MONO / STEREO TOOL
===================================================================== */
const msDropzone = document.getElementById("msDropzone");
const msFileInput = document.getElementById("msFileInput");
const msSampleList = document.getElementById("msSampleList");
const monoToggle = document.getElementById("monoToggle");
const msStatus = document.getElementById("msStatus");

const msState = {
  source: null,       // null | "file" | clip index (number)
  userBuffer: null,
  userFileName: null,
  isMono: false,
};

function buildMsSources() {
  msSampleList.innerHTML = "";
  SAMPLE_CLIPS.forEach((clip, i) => {
    const btn = document.createElement("button");
    btn.className = "sample-btn";
    btn.dataset.msSource = "clip";
    btn.dataset.msClip = String(i);
    btn.innerHTML =
      `<span class="play-icon">▶</span>` +
      `<span class="sample-name">${escapeHtml(clip.name)}</span>`;
    btn.addEventListener("click", () => handleMsSampleClick(btn, clip, i));
    msSampleList.appendChild(btn);
  });
}

async function handleMsSampleClick(btn, clip, index) {
  ensureCtx();
  const existing = getSourceBuffer(btn);
  if (existing && existing.buffer) {
    msState.source = index;
    togglePlayback(btn, existing.buffer);
    updateMsUI();
    return;
  }
  const icon = btn.querySelector(".play-icon");
  const prev = icon.textContent;
  icon.textContent = "…";
  try {
    const buf = await loadUrl(clip.url);
    setSourceBuffer(btn, buf);
    msState.source = index;
    togglePlayback(btn, buf);
    updateMsUI();
  } catch (err) {
    alert("Could not load clip: " + err.message + "\n\nMake sure the S3 bucket allows CORS GET from this origin.");
    icon.textContent = prev;
  }
}

// Mono/Stereo drop zone
msFileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (file) await handleMsFile(file);
  msFileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  msDropzone.addEventListener(ev, (e) => { e.preventDefault(); msDropzone.classList.add("dragover"); })
);
["dragleave", "drop"].forEach((ev) =>
  msDropzone.addEventListener(ev, (e) => { e.preventDefault(); msDropzone.classList.remove("dragover"); })
);
msDropzone.addEventListener("drop", async (e) => {
  const file = e.dataTransfer.files[0];
  if (file) await handleMsFile(file);
});
msDropzone.addEventListener("click", () => {
  const entry = getSourceBuffer(msDropzone);
  if (entry && entry.buffer) {
    msState.source = "file";
    togglePlayback(msDropzone, entry.buffer);
    updateMsUI();
  } else {
    msFileInput.click();
  }
});

async function handleMsFile(file) {
  try {
    const buf = await decodeFile(file);
    msState.userBuffer = buf;
    msState.userFileName = file.name;
    msState.source = "file";
    setSourceBuffer(msDropzone, buf, file.name);
    markDropzoneLoaded(msDropzone, file.name);
    togglePlayback(msDropzone, buf);
    updateMsUI();
  } catch (err) {
    alert("Could not decode that file: " + err.message);
  }
}

/** Crossfade between the stereo path and the summed-mono path. */
function setMonoRouting(isMono) {
  if (!ctx) return;
  const now = ctx.currentTime;
  msStereoGain.gain.setTargetAtTime(isMono ? 0 : 1, now, 0.015);
  msMonoGain.gain.setTargetAtTime(isMono ? 1 : 0, now, 0.015);
}

function handleMonoToggleClick() {
  if (monoToggle.getAttribute("aria-disabled") === "true") return;
  msState.isMono = !msState.isMono;
  monoToggle.setAttribute("aria-checked", msState.isMono ? "true" : "false");
  setMonoRouting(msState.isMono);
  updateMsUI();
}
monoToggle.addEventListener("click", handleMonoToggleClick);
monoToggle.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); handleMonoToggleClick(); }
});

function updateMsUI() {
  const hasSource = msState.source != null;
  monoToggle.setAttribute("aria-disabled", hasSource ? "false" : "true");
  monoToggle.setAttribute("aria-checked", msState.isMono ? "true" : "false");
  if (!hasSource) {
    msStatus.textContent = "Select a source to start.";
    msStatus.classList.remove("active");
  } else {
    msStatus.classList.add("active");
    msStatus.textContent = msState.isMono
      ? "Summed mono — both channels combined."
      : "Stereo — left and right independent.";
  }
}

/* =====================================================================
   STEREO VECTORSCOPE — minimalist mid/side Lissajous
===================================================================== */
const msCanvas = document.getElementById("msCanvas");
const msCtx = msCanvas ? msCanvas.getContext("2d") : null;

function resizeMsCanvas() {
  if (!msCanvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = msCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  msCanvas.width = rect.width * dpr;
  msCanvas.height = rect.height * dpr;
  msCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resizeMsCanvas);

// Mode-driven scope color: lavender (matches the Stereo toggle) when stereo,
// a darker gold for contrast (toggle uses --sun #ffd166) when mono.
const VIZ_COLOR_STEREO = "#c29cf2";  // = var(--lavender)
const VIZ_COLOR_MONO   = "#d9a836";  // darker than --sun for contrast on light bg

function drawStereoViz() {
  if (!msCtx || !msCanvas) return;
  const w = msCanvas.clientWidth;
  const h = msCanvas.clientHeight;
  if (!w || !h) { requestAnimationFrame(drawStereoViz); return; }

  // Motion-trail fade — matches the soft gradient bg so dots slowly disappear.
  msCtx.fillStyle = "rgba(250, 252, 255, 0.18)";
  msCtx.fillRect(0, 0, w, h);

  // Faint center cross — the only structural ink on the scope.
  msCtx.strokeStyle = "rgba(29, 35, 48, 0.08)";
  msCtx.lineWidth = 1;
  msCtx.beginPath();
  msCtx.moveTo(w / 2, 0); msCtx.lineTo(w / 2, h);
  msCtx.moveTo(0, h / 2); msCtx.lineTo(w, h / 2);
  msCtx.stroke();

  // Only animate when the mono/stereo tool is active and audio is playing.
  if (currentTool !== "monoStereo" || !isPlaying || !leftAnalyser || !rightAnalyser) {
    requestAnimationFrame(drawStereoViz);
    return;
  }

  const N = leftAnalyser.fftSize;
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  leftAnalyser.getFloatTimeDomainData(left);
  rightAnalyser.getFloatTimeDomainData(right);

  const cx = w / 2, cy = h / 2;
  const radius = Math.min(w, h) * 0.46;
  const color = msState.isMono ? VIZ_COLOR_MONO : VIZ_COLOR_STEREO;

  // Plot mid on Y-axis, side on X-axis, rotated 45° from raw L/R so mono lives
  // on the vertical. Subsample for speed (every 2nd frame = ~512 dots). Single
  // color avoids muddy-brown overlap artifacts from multi-hue blending.
  msCtx.fillStyle = color;
  for (let i = 0; i < N; i += 2) {
    const L = left[i];
    const R = right[i];
    const mid  = (L + R) * 0.5;
    const side = (L - R) * 0.5;

    const x = cx + side * radius * 2;
    const y = cy - mid  * radius * 2;

    const amp = Math.min(1, Math.sqrt(mid * mid + side * side) * 1.5);

    msCtx.globalAlpha = 0.3 + amp * 0.5;
    msCtx.beginPath();
    msCtx.arc(x, y, 1.4 + amp * 1.4, 0, Math.PI * 2);
    msCtx.fill();
  }
  msCtx.globalAlpha = 1;

  requestAnimationFrame(drawStereoViz);
}

/* =====================================================================
   TOOL SWITCHING (hamburger menu)
===================================================================== */
const hamburgerBtn = document.getElementById("hamburgerBtn");
const menuCloseBtn = document.getElementById("menuCloseBtn");
const menuOverlay = document.getElementById("menuOverlay");
const sideMenu = document.getElementById("sideMenu");
const menuItems = document.querySelectorAll(".menu-item[data-tool]");
const eqTool = document.getElementById("eqTool");
const monoStereoTool = document.getElementById("monoStereoTool");
const toolNameEl = document.getElementById("toolName");
const eqModeToggle = document.getElementById("eqModeToggle");

function openMenu() {
  sideMenu.classList.add("open");
  menuOverlay.classList.add("visible");
  hamburgerBtn.classList.add("open");
  sideMenu.setAttribute("aria-hidden", "false");
}
function closeMenu() {
  sideMenu.classList.remove("open");
  menuOverlay.classList.remove("visible");
  hamburgerBtn.classList.remove("open");
  sideMenu.setAttribute("aria-hidden", "true");
}
hamburgerBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  sideMenu.classList.contains("open") ? closeMenu() : openMenu();
});
menuCloseBtn.addEventListener("click", closeMenu);
menuOverlay.addEventListener("click", closeMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sideMenu.classList.contains("open")) closeMenu();
});

menuItems.forEach((item) => {
  item.addEventListener("click", () => {
    const tool = item.dataset.tool;
    setTool(tool);
    closeMenu();
  });
});

function setTool(tool) {
  // Stop any audio when switching tools; the source was connected to the old
  // tool's input node, so starting fresh in the new tool is the cleanest move.
  stop();

  if (tool === "eq") {
    currentTool = "eq";
    eqTool.style.display = "";
    monoStereoTool.style.display = "none";
    toolNameEl.textContent = "EQ trainer";
    eqModeToggle.style.display = "";
    applyEQ();
  } else if (tool === "monoStereo") {
    currentTool = "monoStereo";
    eqTool.style.display = "none";
    monoStereoTool.style.display = "";
    toolNameEl.textContent = "Mono / Stereo";
    eqModeToggle.style.display = "none";
    // Park the EQ filter at unity so it doesn't color anything if any stray
    // connection ever reached it.
    if (ctx) filter.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
    // Apply the current mono/stereo routing state.
    setMonoRouting(msState.isMono);
    updateMsUI();
    // Canvas was display:none until now — measure it on the next frame.
    requestAnimationFrame(resizeMsCanvas);
  }

  menuItems.forEach((mi) => mi.classList.toggle("active", mi.dataset.tool === tool));
}

/* =====================================================================
   INIT
===================================================================== */
function init() {
  buildSampleList();
  buildQuizButtons();
  buildQuizSources();
  buildMsSources();
  resizeCanvas();
  resizeMsCanvas();
  updateReadouts();
  drawEQ(sliderToFreq(+freqSlider.value), +gainSlider.value, +qSlider.value);
  updateQuizUI();
  updateMsUI();
  setTool("monoStereo");
  requestAnimationFrame(drawStereoViz);
}
init();

// Resume audio on first user gesture (required by browsers)
document.addEventListener("click", function once() {
  ensureCtx();
  if (ctx.state === "suspended") ctx.resume();
  document.removeEventListener("click", once);
});
