import "./style.css";

let player = null;
let apiReady = false;
let pendingVideoId = null;
let currentVideoId = "";
let currentVideoTitle = "";
let activeLoopId = null;
let monitorTimer = null;
let isSeekingProgress = false;
let playbackSpeed = 1.0;
let lastLiveSidebarSecond = -1;

let transcriptCues = [];
let currentCueIndex = -1;
let subtitleRequestToken = 0;
const translationMemory = new Map();
const TRANSLATION_STORAGE_PREFIX = "ytloop:vi:";
const TRANSLATE_ACCESS_STORAGE_KEY = "ytloop:translateAccessCode";
const vocabLoadingLoops = new Set();
const vocabRefreshTimers = new Map();

let englishSubtitleBlurred = false;
let vietnameseSubtitleBlurred = false;

let suspendAutoLoop = false;
let activeComboSegmentIndex = 0;
const combineSelection = new Set();

const STORAGE_KEY = "ytloop:v5:loops";
const LAST_URL_KEY = "ytloop:v5:lastUrl";

const $ = (id) => document.getElementById(id);

const els = {
  youtubeUrl: $("youtubeUrl"),
  loadBtn: $("loadBtn"),
  urlError: $("urlError"),
  savedLoops: $("savedLoops"),
  addLoopBtn: $("addLoopBtn"),
  videoShortTitle: $("videoShortTitle"),
  currentTime: $("currentTime"),
  durationTime: $("durationTime"),
  progressBar: $("progressBar"),
  markerA: $("markerA"),
  markerB: $("markerB"),
  loopRegion: $("loopRegion"),
  playPauseBtn: $("playPauseBtn"),
  muteBtn: $("muteBtn"),
  fullscreenBtn: $("fullscreenBtn"),
  seekBackBtn: $("seekBackBtn"),
  jumpToStartBtn: $("jumpToStartBtn"),
  setStartBtn: $("setStartBtn"),
  setEndBtn: $("setEndBtn"),
  playerShell: $("playerShell"),
  loopHint: $("loopHint"),
  speedDownBtn: $("speedDownBtn"),
  speedUpBtn: $("speedUpBtn"),
  speedValue: $("speedValue"),
  subtitleBox: $("subtitleBox"),
  subtitleEnglish: $("subtitleEnglish"),
  subtitleVietnamese: $("subtitleVietnamese"),
  subtitleStatus: $("subtitleStatus"),
  combineCount: $("combineCount"),
  createCombineBtn: $("createCombineBtn"),
  clearCombineBtn: $("clearCombineBtn"),
  vocabPanel: $("vocabPanel"),
  vocabLoopName: $("vocabLoopName"),
  vocabList: $("vocabList")
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatLoopTime(seconds) {
  if (!Number.isFinite(seconds)) return "?";
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const totalMinutes = Math.floor(total / 60);

  if (totalMinutes >= 60) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return `${String(totalMinutes).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseYouTubeId(value) {
  const raw = value.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(raw)) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname.includes("youtu.be")) return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2];
      if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2];
      if (url.pathname.startsWith("/live/")) return url.pathname.split("/")[2];
    }
  } catch {}
  return null;
}

function setError(message = "") {
  els.urlError.textContent = message;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getTranslateAccessCode() {
  try {
    const saved = localStorage.getItem(TRANSLATE_ACCESS_STORAGE_KEY);
    if (saved) return saved;
  } catch {}

  const value = window.prompt("Nhập mã dịch cá nhân:");
  if (!value) return "";

  const trimmed = value.trim();

  try {
    localStorage.setItem(TRANSLATE_ACCESS_STORAGE_KEY, trimmed);
  } catch {}

  return trimmed;
}

function forgetTranslateAccessCode() {
  try {
    localStorage.removeItem(TRANSLATE_ACCESS_STORAGE_KEY);
  } catch {}
}

function loopVocabSignature(loop) {
  const segments = getLoopSegments(loop);
  if (!segments.length) return "";
  return segments
    .map(segment => `${Number(segment.start).toFixed(3)}-${Number(segment.end).toFixed(3)}`)
    .join("|");
}

function renderVocabularyPanel() {
  if (!els.vocabList || !els.vocabLoopName) return;

  const loop = getActiveLoop();

  if (!loop) {
    els.vocabLoopName.textContent = "Chưa chọn loop";
    els.vocabList.innerHTML = '<div class="vocab-empty">Tạo hoặc chọn loop để xem từ mới.</div>';
    return;
  }

  els.vocabLoopName.textContent = loop.name || "Loop";

  if (!isLoopReady(loop)) {
    els.vocabList.innerHTML = '<div class="vocab-empty">Hoàn tất start / end để tạo từ mới.</div>';
    return;
  }

  if (loop.vocabStatus === "loading" || vocabLoadingLoops.has(loop.id)) {
    els.vocabList.innerHTML = '<div class="vocab-empty">Đang tạo từ mới...</div>';
    return;
  }

  const vocab = Array.isArray(loop.vocab) ? loop.vocab : [];

  if (vocab.length) {
    els.vocabList.innerHTML = vocab
      .map(item => `
        <div class="vocab-item">
          <div class="vocab-term">${escapeHtml(item.term || "")}</div>
          <div class="vocab-meaning">${escapeHtml(item.meaningVi || "")}</div>
        </div>
      `)
      .join("");
    return;
  }

  if (loop.vocabStatus === "error") {
    els.vocabList.innerHTML = '<div class="vocab-empty">Chưa tạo được từ mới. Chọn lại loop để thử lại.</div>';
    return;
  }

  els.vocabList.innerHTML = '<div class="vocab-empty">Đang chờ transcript...</div>';
}

function getTranscriptForLoop(loop) {
  const segments = getLoopSegments(loop);
  if (!segments.length || !transcriptCues.length) return "";

  const texts = [];

  for (const segment of segments) {
    for (const cue of transcriptCues) {
      if (cue.end >= segment.start && cue.start <= segment.end) {
        if (!texts.length || texts[texts.length - 1] !== cue.text) {
          texts.push(cue.text);
        }
      }
    }
  }

  return texts.join(" ").replace(/\s+/g, " ").trim();
}

async function generateVocabularyForLoop(loopId, force = false) {
  const loop = loadAllLoops().find(item => item.id === loopId);
  if (!loop || !isLoopReady(loop)) {
    renderVocabularyPanel();
    return;
  }

  const signature = loopVocabSignature(loop);
  const existing = Array.isArray(loop.vocab) ? loop.vocab : [];

  if (!force && existing.length && loop.vocabSignature === signature) {
    renderVocabularyPanel();
    return;
  }

  if (vocabLoadingLoops.has(loopId)) return;

  const transcript = getTranscriptForLoop(loop);

  if (!transcript) {
    updateLoop(loopId, {
      vocab: [],
      vocabStatus: "waiting",
      vocabSignature: null
    });
    renderVocabularyPanel();
    return;
  }

  const accessCode = getTranslateAccessCode();

  if (!accessCode) {
    updateLoop(loopId, {
      vocab: [],
      vocabStatus: "waiting",
      vocabSignature: null
    });
    renderVocabularyPanel();
    return;
  }

  vocabLoadingLoops.add(loopId);
  updateLoop(loopId, {
    vocab: [],
    vocabStatus: "loading",
    vocabSignature: null
  });
  renderVocabularyPanel();

  try {
    const response = await fetch("/api/vocab", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-translate-access": accessCode
      },
      body: JSON.stringify({
        loopName: loop.name || "Loop",
        transcript
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (response.status === 403) {
        forgetTranslateAccessCode();
      }
      throw new Error(data?.error || "Không tạo được từ mới.");
    }

    const latestLoop = loadAllLoops().find(item => item.id === loopId);
    if (!latestLoop || loopVocabSignature(latestLoop) !== signature) {
      return;
    }

    const items = Array.isArray(data?.items)
      ? data.items
          .map(item => ({
            term: String(item?.term || "").trim(),
            meaningVi: String(item?.meaningVi || "").trim()
          }))
          .filter(item => item.term && item.meaningVi)
          .slice(0, 8)
      : [];

    updateLoop(loopId, {
      vocab: items,
      vocabStatus: items.length ? "ready" : "empty",
      vocabSignature: signature
    });
  } catch (error) {
    updateLoop(loopId, {
      vocab: [],
      vocabStatus: "error",
      vocabSignature: null
    });

    if (activeLoopId === loopId) {
      setError(error?.message || "Không tạo được từ mới.");
    }
  } finally {
    vocabLoadingLoops.delete(loopId);
    renderVocabularyPanel();
  }
}

function scheduleVocabularyRefresh(loopId, delay = 900) {
  const oldTimer = vocabRefreshTimers.get(loopId);
  if (oldTimer) clearTimeout(oldTimer);

  const timer = setTimeout(() => {
    vocabRefreshTimers.delete(loopId);
    generateVocabularyForLoop(loopId, true);
  }, delay);

  vocabRefreshTimers.set(loopId, timer);
}

function ensureActiveLoopVocabulary() {
  const loop = getActiveLoop();
  renderVocabularyPanel();

  if (
    loop &&
    isLoopReady(loop) &&
    (!Array.isArray(loop.vocab) ||
      !loop.vocab.length ||
      loop.vocabSignature !== loopVocabSignature(loop))
  ) {
    generateVocabularyForLoop(loop.id);
  }
}

function saveLastUrl(url) {
  localStorage.setItem(LAST_URL_KEY, url);
}

function restoreLastUrl() {
  const url = localStorage.getItem(LAST_URL_KEY);
  if (url) els.youtubeUrl.value = url;
}

function getDuration() {
  try { return player?.getDuration?.() || 0; } catch { return 0; }
}

function clamp(value) {
  const duration = getDuration();
  return Math.max(0, duration > 0 ? Math.min(value, duration) : value);
}

function loadAllLoops() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveAllLoops(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function getVideoLoops() {
  const items = loadAllLoops();
  if (!currentVideoId) return items;
  return items.filter(item => item.videoId === currentVideoId);
}

function getActiveLoop() {
  return loadAllLoops().find(item => item.id === activeLoopId) || null;
}

function isCombo(loop) {
  return loop?.type === "combo" && Array.isArray(loop.segments);
}

function isSingleLoopReady(loop) {
  return !!(
    loop &&
    !isCombo(loop) &&
    Number.isFinite(loop.start) &&
    Number.isFinite(loop.end) &&
    loop.end > loop.start
  );
}

function isLoopReady(loop) {
  if (!loop) return false;

  if (isCombo(loop)) {
    return (
      loop.segments.length === 2 &&
      loop.segments.every(
        segment =>
          Number.isFinite(segment.start) &&
          Number.isFinite(segment.end) &&
          segment.end > segment.start
      )
    );
  }

  return isSingleLoopReady(loop);
}

function getLoopSegments(loop) {
  if (!loop) return [];
  if (isCombo(loop)) return loop.segments;
  if (isSingleLoopReady(loop)) return [{ start: loop.start, end: loop.end }];
  return [];
}

function createNewLoop() {
  if (!currentVideoId) {
    setError("Hãy load video trước khi tạo loop.");
    return;
  }

  const videoLoops = getVideoLoops().filter(loop => !isCombo(loop));
  const newLoop = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    type: "single",
    videoId: currentVideoId,
    title: currentVideoTitle || "YouTube Video",
    name: `Loop ${videoLoops.length + 1}`,
    start: null,
    end: null,
    speed: playbackSpeed,
    vocab: [],
    vocabStatus: "waiting",
    vocabSignature: null,
    createdAt: Date.now()
  };

  const items = loadAllLoops();
  items.unshift(newLoop);
  saveAllLoops(items);

  activeLoopId = newLoop.id;
  suspendAutoLoop = true;
  activeComboSegmentIndex = 0;
  lastLiveSidebarSecond = -1;
  renderLoops();
  updateLoopUi();
  setError("");
}

function selectLoop(id, seekToStart = false) {
  activeLoopId = id;
  suspendAutoLoop = false;
  activeComboSegmentIndex = 0;
  lastLiveSidebarSecond = -1;

  const loop = getActiveLoop();

  if (loop && Number.isFinite(loop.speed)) {
    playbackSpeed = loop.speed;
    applyPlaybackSpeed();
  }

  const segments = getLoopSegments(loop);
  if (player && seekToStart && segments.length) {
    try {
      player.seekTo(segments[0].start, true);
      player.playVideo();
    } catch {}
  }

  renderLoops();
  updateLoopUi();
  ensureActiveLoopVocabulary();
}

function deleteLoop(id) {
  const items = loadAllLoops().filter(item => item.id !== id);
  saveAllLoops(items);

  combineSelection.delete(id);

  if (activeLoopId === id) {
    activeLoopId = null;
    suspendAutoLoop = false;
    activeComboSegmentIndex = 0;
    lastLiveSidebarSecond = -1;
  }

  renderLoops();
  updateLoopUi();
  updateCombineToolbar();
  renderVocabularyPanel();
}

function updateLoop(loopId, patch) {
  const items = loadAllLoops().map(item => item.id === loopId ? { ...item, ...patch } : item);
  saveAllLoops(items);
}

function toggleCombineSelection(id) {
  const loop = loadAllLoops().find(item => item.id === id);

  if (!isSingleLoopReady(loop)) {
    setError("Chỉ ghép được loop thường đã có start và end.");
    return;
  }

  if (combineSelection.has(id)) {
    combineSelection.delete(id);
  } else {
    if (combineSelection.size >= 2) {
      setError("Chỉ chọn 2 loop. Hãy bỏ một loop trước.");
      return;
    }
    combineSelection.add(id);
  }

  setError("");
  renderLoops();
  updateCombineToolbar();
}

function clearCombineSelection() {
  combineSelection.clear();
  renderLoops();
  updateCombineToolbar();
}

function updateCombineToolbar() {
  const selected = Array.from(combineSelection);
  els.combineCount.textContent = `Ghép: ${selected.length}/2`;
  els.createCombineBtn.disabled = selected.length !== 2;
}

function createCombinedLoop() {
  const selectedIds = Array.from(combineSelection);
  if (selectedIds.length !== 2) return;

  const all = loadAllLoops();
  const selectedLoops = selectedIds
    .map(id => all.find(item => item.id === id))
    .filter(Boolean);

  if (
    selectedLoops.length !== 2 ||
    !selectedLoops.every(loop => isSingleLoopReady(loop)) ||
    !selectedLoops.every(loop => loop.videoId === currentVideoId)
  ) {
    setError("Hai loop phải thuộc cùng video và đều có start/end.");
    return;
  }

  const comboCount = getVideoLoops().filter(isCombo).length;
  const combo = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    type: "combo",
    videoId: currentVideoId,
    title: currentVideoTitle || "YouTube Video",
    name: `Combine ${comboCount + 1}`,
    sourceLoopIds: [...selectedIds],
    segments: selectedLoops.map(loop => ({
      start: loop.start,
      end: loop.end,
      sourceName: loop.name || "Loop"
    })),
    speed: playbackSpeed,
    vocab: [],
    vocabStatus: "waiting",
    vocabSignature: null,
    createdAt: Date.now()
  };

  all.unshift(combo);
  saveAllLoops(all);

  combineSelection.clear();
  activeLoopId = combo.id;
  suspendAutoLoop = false;
  activeComboSegmentIndex = 0;
  lastLiveSidebarSecond = -1;

  renderLoops();
  updateCombineToolbar();
  updateLoopUi();
  setError("");

  const firstSegment = combo.segments[0];
  if (player && firstSegment) {
    player.seekTo(firstSegment.start, true);
    player.playVideo();
  }

  renderVocabularyPanel();
  generateVocabularyForLoop(combo.id);
}

function renderLoops() {
  const loops = getVideoLoops();
  els.savedLoops.innerHTML = "";

  if (!loops.length) {
    els.savedLoops.innerHTML =
      '<div class="empty">Nhấn dấu + để tạo loop mới.</div>';
    return;
  }

  loops.forEach((loop, index) => {
    const card = document.createElement("div");
    const active = loop.id === activeLoopId;

    const selectedIndex =
      Array.from(combineSelection).indexOf(loop.id);

    const selectedForCombine =
      selectedIndex >= 0;

    card.className =
      `loop-card${active ? " active" : ""}${selectedForCombine ? " combine-selected" : ""}`;

    card.dataset.action = "select";
    card.dataset.id = loop.id;

    let timeText = "start ? - end ?";

    if (isCombo(loop)) {
      const seg = loop.segments || [];

      timeText =
        seg.length === 2
          ? `${formatLoopTime(seg[0].start)}-${formatLoopTime(seg[0].end)} + ${formatLoopTime(seg[1].start)}-${formatLoopTime(seg[1].end)}`
          : "combo lỗi";

    } else {
      const hasStart =
        Number.isFinite(loop.start);

      const hasEnd =
        Number.isFinite(loop.end);

      if (hasStart && hasEnd) {
        timeText =
          `${formatLoopTime(loop.start)} - ${formatLoopTime(loop.end)}`;

      } else if (hasStart) {
        let liveEnd = "end ?";

        if (
          active &&
          player &&
          typeof player.getCurrentTime === "function"
        ) {
          try {
            liveEnd =
              formatLoopTime(
                player.getCurrentTime()
              );
          } catch {}
        }

        timeText =
          `${formatLoopTime(loop.start)} - <span class="live-sidebar-end" data-live-loop-id="${loop.id}">${liveEnd}</span>`;

      } else if (hasEnd) {
        let liveStart = "start ?";

        if (
          active &&
          player &&
          typeof player.getCurrentTime === "function"
        ) {
          try {
            liveStart =
              formatLoopTime(
                player.getCurrentTime()
              );
          } catch {}
        }

        timeText = active
          ? `<span class="live-sidebar-start" data-live-loop-id="${loop.id}">${liveStart}</span> - ${formatLoopTime(loop.end)}`
          : `start ? - ${formatLoopTime(loop.end)}`;

      } else if (active) {
        let liveStart = "start ?";

        if (
          player &&
          typeof player.getCurrentTime === "function"
        ) {
          try {
            liveStart =
              formatLoopTime(
                player.getCurrentTime()
              );
          } catch {}
        }

        timeText =
          `<span class="live-sidebar-start" data-live-loop-id="${loop.id}">${liveStart}</span> - end ?`;
      }
    }

    const typeTag =
      isCombo(loop)
        ? "COMBINE"
        : active
          ? "ACTIVE"
          : "LOOP";

    const combineButton =
      !isCombo(loop) &&
      isSingleLoopReady(loop)
        ? `
          <button
            class="loop-combine${selectedForCombine ? " selected" : ""}"
            data-action="combine"
            data-id="${loop.id}"
            title="Chọn loop này để ghép"
          >
            ${selectedForCombine ? selectedIndex + 1 : "GHÉP"}
          </button>
        `
        : "";

    card.innerHTML = `
      <div class="loop-top">
        <span class="loop-name">
          ${loop.name || `Loop ${index + 1}`}
        </span>

        <span class="loop-tag">
          ${typeTag}
        </span>
      </div>

      <div class="loop-time">
        ${timeText}
      </div>

      ${combineButton}

      <button
        class="loop-delete"
        data-action="delete"
        data-id="${loop.id}"
        title="Xóa loop"
      >
        ×
      </button>
    `;

    els.savedLoops.appendChild(card);
  });
}
function updateLiveSidebarPreview(currentTime) {
  const loop = getActiveLoop();

  if (
    !loop ||
    isCombo(loop) ||
    (Number.isFinite(loop.start) && Number.isFinite(loop.end))
  ) {
    lastLiveSidebarSecond = -1;
    return;
  }

  const currentSecond = Math.max(0, Math.floor(currentTime));
  if (currentSecond === lastLiveSidebarSecond) return;

  lastLiveSidebarSecond = currentSecond;

  const selector = Number.isFinite(loop.start)
    ? `.live-sidebar-end[data-live-loop-id="${loop.id}"]`
    : `.live-sidebar-start[data-live-loop-id="${loop.id}"]`;

  const liveEl = document.querySelector(selector);

  if (liveEl) {
    liveEl.textContent = formatLoopTime(currentSecond);
  }
}

function updateTimelineDecor() {
  const loop = getActiveLoop();
  const duration = getDuration();

  if (isCombo(loop)) {
    const segment = loop.segments?.[activeComboSegmentIndex] || loop.segments?.[0];

    if (duration > 0 && segment) {
      els.markerA.style.left = `${(segment.start / duration) * 100}%`;
      els.markerA.classList.remove("hidden");

      els.markerB.style.left = `${(segment.end / duration) * 100}%`;
      els.markerB.classList.remove("hidden");

      const a = (segment.start / duration) * 100;
      const b = (segment.end / duration) * 100;
      els.loopRegion.style.left = `${a}%`;
      els.loopRegion.style.width = `${Math.max(0, b - a)}%`;
      els.loopRegion.classList.remove("hidden");
      return;
    }
  }

  const hasA = duration > 0 && loop && Number.isFinite(loop.start);
  const hasB = duration > 0 && loop && Number.isFinite(loop.end);

  if (hasA) {
    els.markerA.style.left = `${(loop.start / duration) * 100}%`;
    els.markerA.classList.remove("hidden");
  } else {
    els.markerA.classList.add("hidden");
  }

  if (hasB) {
    els.markerB.style.left = `${(loop.end / duration) * 100}%`;
    els.markerB.classList.remove("hidden");
  } else {
    els.markerB.classList.add("hidden");
  }

  if (hasA && hasB && loop.end > loop.start) {
    const a = (loop.start / duration) * 100;
    const b = (loop.end / duration) * 100;
    els.loopRegion.style.left = `${a}%`;
    els.loopRegion.style.width = `${Math.max(0, b - a)}%`;
    els.loopRegion.classList.remove("hidden");
  } else {
    els.loopRegion.classList.add("hidden");
  }
}

function updateSetPointButtons() {
  const loop = getActiveLoop();

  if (isCombo(loop)) {
    els.setStartBtn.classList.remove("is-set");
    els.setEndBtn.classList.remove("is-set");
    els.setStartBtn.disabled = true;
    els.setEndBtn.disabled = true;
    return;
  }

  els.setStartBtn.disabled = false;
  els.setEndBtn.disabled = false;

  const startSet = !!(loop && Number.isFinite(loop.start));
  const endSet = !!(loop && Number.isFinite(loop.end));

  els.setStartBtn.classList.toggle("is-set", startSet);
  els.setEndBtn.classList.toggle("is-set", endSet);
}

function updateLoopUi() {
  const loop = getActiveLoop();

  if (!currentVideoTitle) {
    els.videoShortTitle.textContent = "No video";
  } else {
    const short = currentVideoTitle.length > 22 ? currentVideoTitle.slice(0, 22) + "..." : currentVideoTitle;
    els.videoShortTitle.textContent = short;
  }

  if (!loop) {
    els.loopHint.textContent = "Chưa chọn loop.";
  } else if (isCombo(loop)) {
    const seg = loop.segments || [];
    const state = suspendAutoLoop ? "tạm dừng" : "đang chạy";
    els.loopHint.textContent = `Combine ${state}: ${seg.length === 2 ? "1 → 2 → 1..." : ""}`;
  } else if (isLoopReady(loop)) {
    els.loopHint.textContent =
      suspendAutoLoop
        ? `Loop tạm dừng: ${formatTime(loop.start)} - ${formatTime(loop.end)}`
        : `Loop: ${formatTime(loop.start)} - ${formatTime(loop.end)}`;
  } else {
    const a = Number.isFinite(loop.start) ? formatTime(loop.start) : "?";
    const b = Number.isFinite(loop.end) ? formatTime(loop.end) : "?";
    els.loopHint.textContent = `Đang tạo: ${a} - ${b}`;
  }

  updateSetPointButtons();
  updateTimelineDecor();
  renderVocabularyPanel();
}

function applyPlaybackSpeed() {
  playbackSpeed = Math.round(Math.min(3, Math.max(0.5, playbackSpeed)) * 100) / 100;
  els.speedValue.textContent = `${playbackSpeed.toFixed(2)}x`;

  const loop = getActiveLoop();
  if (loop) updateLoop(loop.id, { speed: playbackSpeed });

  if (player) {
    try {
      player.setPlaybackRate(playbackSpeed);
      const actual = Number(player.getPlaybackRate?.());
      if (Number.isFinite(actual) && Math.abs(actual - playbackSpeed) > 0.001) {
        els.speedValue.title = `YouTube đang phát ở ${actual}x`;
      } else {
        els.speedValue.title = "";
      }
    } catch {}
  }
}

function changeSpeed(delta) {
  playbackSpeed = Math.round((playbackSpeed + delta) * 100) / 100;
  applyPlaybackSpeed();
}

function loadVideo(videoId) {
  currentVideoId = videoId;
  activeLoopId = null;
  currentVideoTitle = "";
  suspendAutoLoop = false;
  activeComboSegmentIndex = 0;
  combineSelection.clear();

  setError("");
  resetSubtitles("Đang tải phụ đề...");

  if (!apiReady) {
    pendingVideoId = videoId;
    return;
  }

  if (!player) {
    player = new window.YT.Player("player", {
      width: "100%",
      height: "100%",
      videoId,
      playerVars: {
        playsinline: 1,
        controls: 0,
        rel: 0,
        modestbranding: 1,
        cc_load_policy: 0
      },
      events: {
        onReady: (event) => {
          startMonitor();
          applyPlaybackSpeed();
          updateTitle();
          renderLoops();
          updateLoopUi();
          updateCombineToolbar();
          loadTranscript(videoId);
        },
        onStateChange: () => {
          updateTitle();
        },
        onPlaybackRateChange: (event) => {
          // YouTube chỉ hỗ trợ một số mức tốc độ thực tế.
          const actual = Number(event?.data);
          if (Number.isFinite(actual)) {
            els.speedValue.title = `Tốc độ YouTube thực tế: ${actual}x`;
          }
        }
      }
    });
  } else {
    player.loadVideoById(videoId);
    setTimeout(() => loadTranscript(videoId), 350);
  }

  saveLastUrl(els.youtubeUrl.value.trim());
  renderLoops();
  updateLoopUi();
  updateCombineToolbar();
  renderVocabularyPanel();
}

function updateTitle() {
  try {
    const data = player?.getVideoData?.();
    currentVideoTitle = data?.title || "YouTube Video";
  } catch {
    currentVideoTitle = "YouTube Video";
  }
  updateLoopUi();
}

function setStart() {
  if (!player) return;
  if (!activeLoopId) {
    setError("Nhấn dấu + để tạo loop trước.");
    return;
  }

  const loop = getActiveLoop();

  if (isCombo(loop)) {
    setError("Loop ghép không chỉnh start/end trực tiếp. Hãy chỉnh 2 loop gốc.");
    return;
  }

  // Nếu đã có start:
  // bấm nút start lần nữa để xóa start và bắt đầu chọn lại.
  if (Number.isFinite(loop?.start)) {
    updateLoop(activeLoopId, {
      start: null,
      vocab: [],
      vocabStatus: "waiting",
      vocabSignature: null
    });

    // Dừng auto-loop trong lúc đang chọn lại start.
    suspendAutoLoop = true;
    activeComboSegmentIndex = 0;
    lastLiveSidebarSecond = -1;

    renderLoops();
    updateLoopUi();
    setError("");
    return;
  }

  // Nếu chưa có start thì lấy thời gian hiện tại làm start mới.
  const t = clamp(player.getCurrentTime());
  const patch = {
    start: t,
    vocab: [],
    vocabStatus: "waiting",
    vocabSignature: null
  };

  // Nếu end cũ nằm trước start mới thì bỏ end để chọn lại.
  if (Number.isFinite(loop?.end) && loop.end <= t) {
    patch.end = null;
  }

  updateLoop(activeLoopId, patch);

  // Start đã được chốt: dừng preview start.
  lastLiveSidebarSecond = -1;

  const updatedLoop = getActiveLoop();

  // Nếu end cũ vẫn hợp lệ thì loop đủ 2 mốc và chạy lại.
  // Nếu chưa có end thì tiếp tục ở chế độ chọn end như cũ.
  suspendAutoLoop = !isLoopReady(updatedLoop);
  activeComboSegmentIndex = 0;

  renderLoops();
  updateLoopUi();
  setError("");

  if (isLoopReady(updatedLoop)) {
    scheduleVocabularyRefresh(updatedLoop.id);
  }
}

function setEnd() {
  if (!player) return;

  if (!activeLoopId) {
    setError("Nhấn dấu + để tạo loop trước.");
    return;
  }

  const loop = getActiveLoop();

  if (isCombo(loop)) {
    setError("Loop ghép không chỉnh start/end trực tiếp. Hãy chỉnh 2 loop gốc.");
    return;
  }

  if (!Number.isFinite(loop?.start)) {
    setError("Hãy chọn start trước.");
    return;
  }

  // Nếu đã có end:
  // bấm nút end lần nữa để xóa end và bắt đầu chọn lại.
  if (Number.isFinite(loop.end)) {
    updateLoop(activeLoopId, { end: null, vocab: [], vocabStatus: "waiting", vocabSignature: null });

    // Dừng auto-loop trong lúc đang chọn lại end.
    suspendAutoLoop = true;
    activeComboSegmentIndex = 0;
    lastLiveSidebarSecond = -1;

    renderLoops();
    updateLoopUi();
    setError("");
    return;
  }

  // Nếu chưa có end thì lấy thời gian hiện tại làm end mới.
  const t = clamp(player.getCurrentTime());

  if (t <= loop.start) {
    setError("End phải lớn hơn start.");
    return;
  }

  updateLoop(activeLoopId, { end: t, vocab: [], vocabStatus: "loading", vocabSignature: null });

  // Khi đủ start/end thì loop bắt đầu chạy tự động.
  suspendAutoLoop = false;
  activeComboSegmentIndex = 0;
  lastLiveSidebarSecond = -1;

  renderLoops();
  updateLoopUi();
  setError("");

  generateVocabularyForLoop(activeLoopId, true);
}

function adjustPoint(point, delta) {
  const loop = getActiveLoop();
  if (!loop || !player) return;

  if (isCombo(loop)) {
    setError("Hãy chỉnh thời gian ở 2 loop gốc.");
    return;
  }

  if (point === "a") {
    if (!Number.isFinite(loop.start)) return;
    const next = clamp(loop.start + delta);
    if (Number.isFinite(loop.end) && next >= loop.end) return;
    updateLoop(loop.id, { start: next, vocab: [], vocabStatus: "waiting", vocabSignature: null });
  } else {
    if (!Number.isFinite(loop.end)) return;
    const next = clamp(loop.end + delta);
    if (Number.isFinite(loop.start) && next <= loop.start) return;
    updateLoop(loop.id, { end: next, vocab: [], vocabStatus: "waiting", vocabSignature: null });
  }

  renderLoops();
  updateLoopUi();

  const updatedLoop = getActiveLoop();
  if (isLoopReady(updatedLoop)) {
    // Sau mỗi lần A-/A+/B-/B+, tua lại đầu loop để nghe ngay thay đổi.
    suspendAutoLoop = false;
    activeComboSegmentIndex = 0;
    lastLiveSidebarSecond = -1;

    try {
      player.seekTo(updatedLoop.start, true);
      player.playVideo();
    } catch {}

    scheduleVocabularyRefresh(updatedLoop.id);
  }
}


function applySubtitleVisibility() {
  els.subtitleEnglish.classList.toggle("subtitle-blurred", englishSubtitleBlurred);
  els.subtitleVietnamese.classList.toggle("subtitle-blurred", vietnameseSubtitleBlurred);

  els.subtitleBox.classList.toggle("en-hidden", englishSubtitleBlurred);
  els.subtitleBox.classList.toggle("vi-hidden", vietnameseSubtitleBlurred);
}

function toggleEnglishSubtitleBlur() {
  englishSubtitleBlurred = !englishSubtitleBlurred;
  applySubtitleVisibility();
}

function toggleVietnameseSubtitleBlur() {
  vietnameseSubtitleBlurred = !vietnameseSubtitleBlurred;
  applySubtitleVisibility();
}

function resetSubtitles(status = "Chưa tải phụ đề") {
  transcriptCues = [];
  currentCueIndex = -1;
  subtitleRequestToken += 1;
  els.subtitleEnglish.textContent = "";
  els.subtitleVietnamese.textContent = "";
  els.subtitleStatus.textContent = status;
  els.subtitleStatus.classList.remove("ok");
  applySubtitleVisibility();
}

function normalizeTranscriptItems(items) {
  if (!Array.isArray(items) || !items.length) return [];

  const duration = getDuration();
  const rawMax = Math.max(...items.map(item => {
    const offset = Number(item.offset) || 0;
    const dur = Number(item.duration) || 0;
    return offset + dur;
  }));

  const scale = duration > 0 && rawMax > duration * 20 ? 0.001 : 1;

  return items
    .map(item => {
      const start = (Number(item.offset) || 0) * scale;
      const dur = Math.max(0.05, (Number(item.duration) || 0) * scale);
      return {
        text: String(item.text || "").replace(/\s+/g, " ").trim(),
        start,
        end: start + dur
      };
    })
    .filter(cue => cue.text)
    .sort((a, b) => a.start - b.start);
}

async function loadTranscript(videoId) {
  const token = ++subtitleRequestToken;
  transcriptCues = [];
  currentCueIndex = -1;
  els.subtitleStatus.textContent = "Đang tải phụ đề tiếng Anh...";
  els.subtitleEnglish.textContent = "";
  els.subtitleVietnamese.textContent = "";

  try {
    const response = await fetch(`/api/transcript/${encodeURIComponent(videoId)}?lang=en`);
    const data = await response.json();

    if (token !== subtitleRequestToken) return;

    if (!response.ok) {
      throw new Error(data?.error || "Không có phụ đề.");
    }

    transcriptCues = normalizeTranscriptItems(data.items);

    if (!transcriptCues.length) {
      throw new Error("Video không có phụ đề tiếng Anh.");
    }

    els.subtitleStatus.textContent = `EN + VI • ${transcriptCues.length} câu`;
    els.subtitleStatus.classList.add("ok");
    updateSubtitleForTime(player?.getCurrentTime?.() || 0, true);
    ensureActiveLoopVocabulary();
  } catch {
    if (token !== subtitleRequestToken) return;
    transcriptCues = [];
    currentCueIndex = -1;
    els.subtitleStatus.textContent = "Không lấy được phụ đề";
    els.subtitleEnglish.textContent = "Video này không có transcript tiếng Anh khả dụng.";
    els.subtitleVietnamese.textContent = "";
  }
}

function findCueIndex(time) {
  if (!transcriptCues.length) return -1;

  let low = 0;
  let high = transcriptCues.length - 1;
  let best = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (transcriptCues[mid].start <= time + 0.05) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best < 0 ? 0 : best;
}

function translationCacheKey(cue) {
  return `${currentVideoId}:${cue.start.toFixed(3)}:${cue.text}`;
}

function loadStoredTranslation(key) {
  try {
    return localStorage.getItem(TRANSLATION_STORAGE_PREFIX + key);
  } catch {
    return null;
  }
}

function saveStoredTranslation(key, value) {
  try {
    localStorage.setItem(TRANSLATION_STORAGE_PREFIX + key, value);
  } catch {}
}

async function translateCue(cue, cueIndex) {
  const key = translationCacheKey(cue);

  // Có trong RAM cache
  if (translationMemory.has(key)) {
    if (currentCueIndex === cueIndex) {
      els.subtitleVietnamese.textContent =
        translationMemory.get(key);
    }
    return;
  }

  // Có trong localStorage
  const stored = loadStoredTranslation(key);

  if (stored) {
    translationMemory.set(key, stored);

    if (currentCueIndex === cueIndex) {
      els.subtitleVietnamese.textContent = stored;
    }

    return;
  }

  const accessCode = getTranslateAccessCode();

  if (!accessCode) {
    if (currentCueIndex === cueIndex) {
      els.subtitleVietnamese.textContent =
        "Chưa bật dịch cá nhân.";
    }
    return;
  }

  // Chia transcript thành từng cụm cố định 12 câu.
  // Các câu trong cùng cụm sẽ dùng chung 1 request Gemini.
  const BATCH_SIZE = 12;
  const batchStart =
    Math.floor(cueIndex / BATCH_SIZE) * BATCH_SIZE;

  const batchEnd = Math.min(
    transcriptCues.length,
    batchStart + BATCH_SIZE
  );

  const batchKey =
    `${currentVideoId}:${batchStart}:${batchEnd}`;

  // Map promise dùng chung để tránh 12 câu gọi 12 request cùng lúc.
  if (!translateCue.batchPromises) {
    translateCue.batchPromises = new Map();
  }

  const batchPromises = translateCue.batchPromises;

  // Nếu batch chưa được gọi thì gọi đúng 1 lần.
  if (!batchPromises.has(batchKey)) {
    const promise = (async () => {
      const batchCues =
        transcriptCues.slice(batchStart, batchEnd);

      const response = await fetch("/api/translate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-translate-access": accessCode
        },
        body: JSON.stringify({
          items: batchCues.map(item => ({
            text: item.text
          }))
        })
      });

      const data = await response
        .json()
        .catch(() => ({}));

      if (!response.ok) {
        if (response.status === 403) {
          forgetTranslateAccessCode();
          throw new Error(
            "Mã dịch sai. Web sẽ hỏi lại."
          );
        }

        if (response.status === 429) {
          throw new Error(
            "Gemini đang giới hạn lượt dịch. Chờ một chút rồi thử lại."
          );
        }

        throw new Error(
          data?.error || "Không dịch được phụ đề."
        );
      }

      const translations =
        Array.isArray(data?.translations)
          ? data.translations
          : [];

      if (translations.length !== batchCues.length) {
        throw new Error(
          "Gemini trả về thiếu câu dịch."
        );
      }

      // Lưu toàn bộ 12 câu vào cache.
      batchCues.forEach((item, index) => {
        const translated = String(
          translations[index] || ""
        ).trim();

        if (!translated) return;

        const itemKey = translationCacheKey(item);

        translationMemory.set(
          itemKey,
          translated
        );

        saveStoredTranslation(
          itemKey,
          translated
        );
      });
    })();

    batchPromises.set(batchKey, promise);

    promise.finally(() => {
      batchPromises.delete(batchKey);
    });
  }

  if (currentCueIndex === cueIndex) {
    els.subtitleVietnamese.textContent =
      "Đang dịch...";
  }

  try {
    await batchPromises.get(batchKey);

    const translated =
      translationMemory.get(key) ||
      loadStoredTranslation(key);

    if (currentCueIndex === cueIndex) {
      els.subtitleVietnamese.textContent =
        translated ||
        "Không dịch được câu này.";
    }
  } catch (error) {
    if (currentCueIndex === cueIndex) {
      els.subtitleVietnamese.textContent =
        error?.message ||
        "Không dịch được câu này.";
    }
  }
}
function updateSubtitleForTime(time, force = false) {
  if (!transcriptCues.length) return;

  const index = findCueIndex(time);
  if (index < 0) return;
  if (!force && index === currentCueIndex) return;

  currentCueIndex = index;
  const cue = transcriptCues[index];

  els.subtitleEnglish.textContent = cue.text;
  translateCue(cue, index);
}

function navigateSentence(direction) {
  if (!player || !transcriptCues.length) {
    setError("Video chưa có phụ đề để tua theo câu.");
    return;
  }

  const now = player.getCurrentTime();
  const base = findCueIndex(now);

  let targetIndex = base;

  if (direction === "previous") {
    targetIndex = Math.max(0, base - 1);
  }

  if (direction === "next") {
    targetIndex = Math.min(
      transcriptCues.length - 1,
      base + 1
    );
  }

  const loop = getActiveLoop();
  const segments = getLoopSegments(loop);

  let targetTime =
    transcriptCues[targetIndex].start + 0.01;

  // Nếu loop đã có START + END thì A/S/D
  // không được phép thoát ra khỏi khung loop.
  if (isLoopReady(loop) && segments.length) {
    const segment =
      segments.length === 2
        ? (
            segments[activeComboSegmentIndex] ||
            segments[0]
          )
        : segments[0];

    const minTime = segment.start + 0.05;
    const maxTime = segment.end - 0.05;

    // Không cho A tua trước START.
    if (targetTime < minTime) {
      targetTime = minTime;
    }

    // Không cho D tua vượt END.
    if (targetTime > maxTime) {
      targetTime = Math.max(
        minTime,
        maxTime
      );
    }
  }

  // Loop đã hoàn chỉnh thì sau A/S/D
  // vẫn tiếp tục giữ auto-loop.
  suspendAutoLoop = !isLoopReady(loop);

  currentCueIndex = -1;

  player.seekTo(
    Math.max(0, targetTime),
    true
  );

  player.playVideo();

  updateSubtitleForTime(
    targetTime,
    true
  );

  updateLoopUi();
  setError("");
}

function startMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);

  monitorTimer = setInterval(() => {
    if (!player || typeof player.getCurrentTime !== "function") return;

    let current = 0;
    try { current = player.getCurrentTime(); } catch { return; }

    els.currentTime.textContent = formatTime(current);
    updateSubtitleForTime(current);
    updateLiveSidebarPreview(current);

    const duration = getDuration();
    if (duration > 0) {
      els.durationTime.textContent = formatTime(duration);
      if (!isSeekingProgress) {
        els.progressBar.value = String(Math.round((current / duration) * 1000));
      }
    }

    const loop = getActiveLoop();

    if (!suspendAutoLoop && isLoopReady(loop)) {
      const segments = getLoopSegments(loop);

      if (segments.length === 1) {
        const segment = segments[0];
        if (current >= segment.end) {
          player.seekTo(segment.start, true);
          player.playVideo();
        }
      }

      if (segments.length === 2) {
        const segment = segments[activeComboSegmentIndex] || segments[0];

        if (current >= segment.end) {
          // COMBINE chạy tuần tự vô hạn:
          // segment 1 -> segment 2 -> segment 1 -> segment 2 ...
          activeComboSegmentIndex = activeComboSegmentIndex === 0 ? 1 : 0;
          const nextSegment = segments[activeComboSegmentIndex];
          player.seekTo(nextSegment.start, true);
          player.playVideo();
          updateTimelineDecor();
        }
      }
    }
  }, 60);
}

function playPause() {
  if (!player) return;
  try {
    const state = player.getPlayerState();
    if (state === window.YT.PlayerState.PLAYING) {
      player.pauseVideo();
      els.playPauseBtn.textContent = "▶";
    } else {
      player.playVideo();
      els.playPauseBtn.textContent = "❚❚";
    }
  } catch {}
}

function toggleMute() {
  if (!player) return;
  try {
    if (player.isMuted()) {
      player.unMute();
      els.muteBtn.textContent = "🔊";
    } else {
      player.mute();
      els.muteBtn.textContent = "🔇";
    }
  } catch {}
}

function seekRelative(delta) {
  if (!player) return;
  try {
    player.seekTo(clamp(player.getCurrentTime() + delta), true);
  } catch {}
}

function jumpToStart() {
  const loop = getActiveLoop();
  if (!player || !loop) return;

  const segments = getLoopSegments(loop);
  if (!segments.length) return;

  suspendAutoLoop = false;
  activeComboSegmentIndex = 0;
  player.seekTo(segments[0].start, true);
  player.playVideo();
  updateLoopUi();
}

function toggleFullscreen() {
  const el = els.playerShell;
  if (!document.fullscreenElement) {
    el.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

els.loadBtn.addEventListener("click", () => {
  const id = parseYouTubeId(els.youtubeUrl.value);
  if (!id) {
    setError("Link YouTube không hợp lệ.");
    return;
  }
  loadVideo(id);
});

els.youtubeUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.loadBtn.click();
});

els.addLoopBtn.addEventListener("click", createNewLoop);
els.playPauseBtn.addEventListener("click", playPause);
els.muteBtn.addEventListener("click", toggleMute);
els.fullscreenBtn.addEventListener("click", toggleFullscreen);
els.seekBackBtn.addEventListener("click", () => seekRelative(-5));
els.jumpToStartBtn.addEventListener("click", jumpToStart);
els.setStartBtn.addEventListener("click", setStart);
els.setEndBtn.addEventListener("click", setEnd);

els.speedDownBtn.addEventListener("click", () => changeSpeed(-0.05));
els.speedUpBtn.addEventListener("click", () => changeSpeed(0.05));

els.createCombineBtn.addEventListener("click", createCombinedLoop);
els.clearCombineBtn.addEventListener("click", clearCombineSelection);

document.querySelectorAll("[data-adjust]").forEach((btn) => {
  btn.addEventListener("click", () => {
    adjustPoint(btn.dataset.adjust, Number(btn.dataset.value));
  });
});

els.savedLoops.addEventListener("click", (e) => {
  const target = e.target.closest("[data-action]");
  if (!target) return;

  const { action, id } = target.dataset;

  if (action === "delete") {
    deleteLoop(id);
  } else if (action === "combine") {
    toggleCombineSelection(id);
  } else if (action === "select") {
    selectLoop(id, true);
  }
});

els.progressBar.addEventListener("input", () => {
  isSeekingProgress = true;
});

els.progressBar.addEventListener("change", () => {
  if (!player) return;
  const duration = getDuration();
  const target = duration * (Number(els.progressBar.value) / 1000);
  player.seekTo(target, true);
  isSeekingProgress = false;
});

document.addEventListener("keydown", (e) => {
  const tag = e.target?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea") return;

  if (e.code === "Space") {
    e.preventDefault();
    playPause();
  } else if (e.key.toLowerCase() === "a") {
    e.preventDefault();
    navigateSentence("previous");
  } else if (e.key.toLowerCase() === "s") {
    e.preventDefault();
    navigateSentence("current");
  } else if (e.key.toLowerCase() === "d") {
    e.preventDefault();
    navigateSentence("next");
  } else if (e.key.toLowerCase() === "q") {
    e.preventDefault();
    toggleEnglishSubtitleBlur();
  } else if (e.key.toLowerCase() === "w") {
    e.preventDefault();
    toggleVietnameseSubtitleBlur();
  } else if (e.key === "ArrowLeft") {
    seekRelative(-1);
  } else if (e.key === "ArrowRight") {
    seekRelative(1);
  }
});

window.onYouTubeIframeAPIReady = () => {
  apiReady = true;
  if (pendingVideoId) {
    const id = pendingVideoId;
    pendingVideoId = null;
    loadVideo(id);
  }
};

const script = document.createElement("script");
script.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(script);

restoreLastUrl();
renderLoops();
updateLoopUi();
updateCombineToolbar();
applyPlaybackSpeed();
applySubtitleVisibility();
renderVocabularyPanel();
