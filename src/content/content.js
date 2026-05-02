const STORAGE_DEFAULTS = {
  enabled: true,
  enabledCategoryIds: ["cat-videos"]
};

const REMOTE_VIDEO_INDEX_URL = "http://localhost:3000/api/videos";
const REMOTE_CURSOR_MOVE_URL = "http://localhost:3000/api/cursor/move";
const MAX_VIDEO_RETRIES = 3;
const TOP_MATCH_COUNT = 3;

const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;
const PROCESS_MARKER = "data-cat-adblocker-processed";
const HIDDEN_MARKER = "data-cat-adblocker-hidden";
const CLASS_NAME = "cat-adblocker-slot";
const BADGE_CLASS = "cat-adblocker-badge";
const SKIP_BUTTON_CLASS = "cat-adblocker-skip";
const QUAD_GRID_CLASS = "cat-adblocker-quad";
const YOUTUBE_AD_CHECK_INTERVAL_MS = 250;
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com"];
const INITIAL_POPUP_GRACE_MS = 10 * 1000;
const PRODUCTIVE_INTERRUPT_DELAY_MS = 4 * 1000;
const PRODUCTIVE_INTERRUPT_DURATION_MS = 8 * 500;
const PAGE_TIMELINE_TICK_MS = 500;
const PAGE_TIMELINE_RANDOM_INSERT_MS = 2 * 1000;
const PAGE_TIMELINE_MAIN_REPLACE_MS = 3 * 1000;
const PAGE_TIMELINE_TAKEOVER_MS = 8 * 1000;
const RANDOM_INSERT_INTERVAL_MS = 3000;
const RANDOM_INSERT_LIFETIME_MS = 200000;
const MAX_RANDOM_INSERTIONS = 100;
const RANDOM_INSERT_MIN_SIZE = 180;
const RANDOM_INSERT_MAX_SIZE = 360;
const PAW_INTERRUPT_MIN_DELAY_MS = 900;
const PAW_INTERRUPT_MAX_DELAY_MS = 1800;
const PAW_INTERRUPT_DURATION_MS = 900;
const PAW_CURSOR_MOVE_DELAY_MS = 145;
const CURSOR_MOVE_REQUEST_TIMEOUT_MS = 2500;
const PAW_PUSH_MIN_DISTANCE = 320;
const PAW_PUSH_MAX_DISTANCE = 620;
const FAKE_CURSOR_SIZE = 28;
const PAW_HEIGHT_VIEWPORT_RATIO = 0.5;
const PAW_IMAGE_PATH = "icons/ChatGPT Image May 2, 2026, 12_43_18 PM.png";
const OIIAI_VIDEO_FILENAME = "YTDown_YouTube_W_W-OIIA-OIIA-Spinning-Cat_Media_IxX_QHay02M_001_1080p.webm";
const OIIAI_AUDIO_ID = "oiiai-enter";
const PRODUCTIVE_HOSTS = [
  "airtable.com",
  "asana.com",
  "atlassian.net",
  "calendar.google.com",
  "clickup.com",
  "docs.google.com",
  "figma.com",
  "github.com",
  "gitlab.com",
  "linear.app",
  "mail.google.com",
  "notion.so",
  "office.com",
  "slack.com",
  "trello.com",
];

const replacements = new Map();
let observer = null;
let enabled = true;
let enabledCategoryIds = [...STORAGE_DEFAULTS.enabledCategoryIds];
let indexedCategories = [];
let activeVideos = [];
let productiveUsageInterval = null;
let productiveUsageElapsedMs = 0;
let lastProductiveTickAt = 0;
let pageTimelineInterval = null;
let pageTimelineElapsedMs = 0;
let lastPageTimelineTickAt = 0;
let randomInsertInterval = null;
let randomInsertions = [];
let mainElementsReplaced = false;
let pageTakeoverActive = false;
let pageTakeoverShown = false;
let popupGraceUntil = 0;
let windowHasFocus = document.hasFocus();
let activeInterruption = null;
let nextAudioId = 1;
let youtubeAdInterval = null;
let youtubeReplacement = null;
let lastPointerPosition = null;
let pawInterruptTimeout = null;
let activePawInterruption = null;
let activeOiiaiTakeover = null;

function requestCursorMove(target) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      x: target.x,
      y: target.y,
      screenX: window.screenX,
      screenY: window.screenY,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1
    })
  };

  if (controller) {
    options.signal = controller.signal;
  }

  let timeoutId = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = window.setTimeout(() => {
      controller?.abort();
      resolve(false);
    }, CURSOR_MOVE_REQUEST_TIMEOUT_MS);
  });

  const movePromise = fetch(REMOTE_CURSOR_MOVE_URL, options)
    .then((response) => response.ok)
    .catch(() => false);

  return Promise.race([movePromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function resetPopupGracePeriod() {
  popupGraceUntil = Date.now() + INITIAL_POPUP_GRACE_MS;
}

function isPopupGraceActive() {
  return Date.now() < popupGraceUntil;
}

function getCandidateElements(root = document) {
  const selector = [
    "iframe",
    "[id*='ad']",
    "[class*='ad']",
    "[id*='ads']",
    "[class*='ads']",
    "[id*='banner']",
    "[class*='banner']",
    "[data-ad]",
    "[aria-label*='ad']"
  ].join(",");

  return Array.from(root.querySelectorAll(selector));
}

function hasStrongAdSignal(element) {
  const haystack = [
    element.id,
    element.className,
    element.getAttribute("data-ad"),
    element.getAttribute("aria-label"),
    element.getAttribute("src"),
    element.getAttribute("href"),
    element.getAttribute("role")
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const signals = [" ad ", "ads", "advert", "banner", "sponsor", "promo", "doubleclick"];
  return signals.some((signal) => haystack.includes(signal.trim()));
}

function isSkippableContext(element) {
  return Boolean(element.closest(".cat-adblocker-slot, nav, header, footer, form, [role='navigation']"));
}

function getDimensions(element) {
  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  return { width, height };
}

function isLikelyAd(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.hasAttribute(PROCESS_MARKER) || isSkippableContext(element)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const { width, height } = getDimensions(element);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return false;
  }

  if (element.tagName === "IFRAME") {
    return true;
  }

  const commonSlot =
    (width >= 300 && width <= 336 && height >= 240 && height <= 300) ||
    (width >= 728 && width <= 970 && height >= 80 && height <= 300) ||
    (width >= 150 && width <= 320 && height >= 250 && height <= 700);

  return hasStrongAdSignal(element) && commonSlot;
}

function shuffle(array) {
  const copy = [...array];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function normalizeVideoEntry(categoryId, entry) {
  if (!entry || typeof entry.url !== "string") {
    return null;
  }

  const width = Number.isFinite(entry.width) ? Number(entry.width) : null;
  const height = Number.isFinite(entry.height) ? Number(entry.height) : null;
  const aspectRatio =
    Number.isFinite(entry.aspectRatio) && Number(entry.aspectRatio) > 0
      ? Number(entry.aspectRatio)
      : width && height
        ? width / height
        : null;

  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : entry.filename || entry.url,
    filename: typeof entry.filename === "string" ? entry.filename : null,
    url: entry.url,
    categoryId,
    width,
    height,
    aspectRatio
  };
}

function normalizeCategory(entry) {
  if (!entry || typeof entry.id !== "string") {
    return null;
  }

  const videos = Array.isArray(entry.videos)
    ? entry.videos.map((video) => normalizeVideoEntry(entry.id, video)).filter(Boolean)
    : [];

  return {
    id: entry.id,
    label: typeof entry.label === "string" && entry.label ? entry.label : entry.id,
    videos
  };
}

async function fetchVideoIndex(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.categories)
    ? payload.categories.map(normalizeCategory).filter(Boolean)
    : [];
}

async function loadVideoIndex() {
  try {
    indexedCategories = await fetchVideoIndex(REMOTE_VIDEO_INDEX_URL);
  } catch (error) {
    console.warn("Cat Adblocker requires the local video API at http://localhost:3000/api/videos.", error);
    indexedCategories = [];
  }
}

function getCategoryVideos(categoryIds) {
  const requestedIds = new Set(categoryIds);
  const matchingVideos = indexedCategories
    .filter((category) => requestedIds.has(category.id))
    .flatMap((category) => category.videos);

  if (matchingVideos.length > 0) {
    return matchingVideos;
  }

  const fallbackCategory = indexedCategories.find((category) => category.id === "cat-videos");
  if (fallbackCategory?.videos.length) {
    return fallbackCategory.videos;
  }

  return [];
}

function refreshActiveVideos() {
  activeVideos = getCategoryVideos(enabledCategoryIds);
}

function isProductiveWebsite() {
  const hostname = window.location.hostname.toLowerCase();
  return PRODUCTIVE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function pickVideoForDimensions(dimensions, excludedUrls = new Set()) {
  const availableVideos = activeVideos.filter((video) => !excludedUrls.has(video.url));
  const candidates = availableVideos.length > 0 ? availableVideos : activeVideos;
  if (candidates.length === 0) {
    return null;
  }

  const slotRatio = dimensions.height > 0 ? dimensions.width / dimensions.height : null;
  const ratioCandidates = candidates.filter((video) => Number.isFinite(video.aspectRatio));
  if (!slotRatio || ratioCandidates.length === 0) {
    return shuffle(candidates)[0];
  }

  const ranked = [...ratioCandidates].sort(
    (left, right) => Math.abs(left.aspectRatio - slotRatio) - Math.abs(right.aspectRatio - slotRatio)
  );
  return shuffle(ranked.slice(0, TOP_MATCH_COUNT))[0] || shuffle(candidates)[0];
}

function configureAutoplayVideo(video) {
  video.defaultMuted = true;
  video.muted = true;
  video.autoplay = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("muted", "");
  video.setAttribute("autoplay", "");
  video.setAttribute("playsinline", "");
}

function ensurePlaying(video, videoState) {
  configureAutoplayVideo(video);

  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {
      if (!videoState || videoState.playRetryPending) {
        return;
      }

      videoState.playRetryPending = true;
      window.setTimeout(() => {
        videoState.playRetryPending = false;
        if (!video.isConnected || video.ended || !video.src) {
          return;
        }

        video.muted = true;
        const retryPromise = video.play();
        if (retryPromise && typeof retryPromise.catch === "function") {
          retryPromise.catch(() => {});
        }
      }, 100);
    });
  }
}

function startBackgroundAudio(audioId, url, options = {}) {
  if (!audioId || !url) {
    return;
  }

  browser.runtime
    .sendMessage({
      type: "CAT_ADBLOCKER_START_AUDIO",
      audioId,
      url,
      loop: options.loop !== false,
      volume: Number.isFinite(options.volume) ? options.volume : 1
    })
    .catch(() => {});
}

function stopBackgroundAudio(audioId) {
  if (!audioId) {
    return;
  }

  browser.runtime
    .sendMessage({
      type: "CAT_ADBLOCKER_STOP_AUDIO",
      audioId
    })
    .catch(() => {});
}

function stopAllBackgroundAudio() {
  browser.runtime
    .sendMessage({
      type: "CAT_ADBLOCKER_STOP_TAB_AUDIO"
    })
    .catch(() => {});
}

function setVideoSource(video, videoState, nextVideo) {
  if (!nextVideo) {
    return false;
  }

  videoState.currentVideo = nextVideo;
  videoState.ignorePauseUntil = Date.now() + 250;
  videoState.playRetryPending = false;
  video.src = nextVideo.url;
  video.load();
  ensurePlaying(video, videoState);
  startBackgroundAudio(videoState.audioId, nextVideo.url);
  return true;
}

function renderVideoFallback(wrapper, video, badge) {
  video.remove();
  badge.textContent = "Cat Adblocker fallback";
  if (badge.parentNode === wrapper) {
    wrapper.insertBefore(createVideoFallback(), badge);
  } else {
    wrapper.append(createVideoFallback());
  }
}

function createVideoFallback() {
  const fallback = document.createElement("div");
  fallback.className = "cat-adblocker-slot__fallback";
  fallback.textContent = "Video unavailable. Still blocking the ad slot.";
  return fallback;
}

function recoverVideo(container, video, badge, videoState) {
  if (videoState.retryCount >= MAX_VIDEO_RETRIES) {
    stopBackgroundAudio(videoState.audioId);
    renderVideoFallback(container, video, badge);
    return;
  }

  if (videoState.currentVideo?.url) {
    videoState.failedUrls.add(videoState.currentVideo.url);
  }

  const nextVideo = pickVideoForDimensions(videoState.dimensions, videoState.failedUrls);
  if (!nextVideo) {
    stopBackgroundAudio(videoState.audioId);
    renderVideoFallback(container, video, badge);
    return;
  }

  videoState.retryCount += 1;
  setVideoSource(video, videoState, nextVideo);
}

function attachPlaybackRecovery(container, video, badge, videoState) {
  video.addEventListener("ended", () => {
    video.currentTime = 0;
    ensurePlaying(video, videoState);
  });

  video.addEventListener("pause", () => {
    if (Date.now() < videoState.ignorePauseUntil || video.ended || video.seeking || !video.src) {
      return;
    }

    ensurePlaying(video, videoState);
  });

  video.addEventListener("stalled", () => {
    videoState.ignorePauseUntil = Date.now() + 250;
    video.load();
    ensurePlaying(video, videoState);
  });

  video.addEventListener("error", () => {
    recoverVideo(container, video, badge, videoState);
  });
}

function createVideoState(dimensions) {
  const audioId = `slot-${nextAudioId}`;
  nextAudioId += 1;

  return {
    currentVideo: null,
    dimensions,
    retryCount: 0,
    failedUrls: new Set(),
    audioId,
    ignorePauseUntil: 0,
    playRetryPending: false
  };
}

function createReplacementVideo(
  wrapper,
  dimensions,
  badge,
  initialVideo = pickVideoForDimensions(dimensions),
  fallbackContainer = wrapper
) {
  const video = document.createElement("video");
  video.muted = true;
  configureAutoplayVideo(video);
  video.setAttribute("aria-label", "Cat video replacing an ad");

  const videoState = createVideoState(dimensions);
  wrapper.__catAdblockerAudioIds.push(videoState.audioId);

  if (initialVideo) {
    setVideoSource(video, videoState, initialVideo);
  } else {
    return { video: null, videoState, fallback: createVideoFallback() };
  }

  attachPlaybackRecovery(fallbackContainer, video, badge, videoState);
  return { video, videoState };
}

function stopReplacementAudio(wrapper) {
  const audioIds = Array.isArray(wrapper.__catAdblockerAudioIds) ? wrapper.__catAdblockerAudioIds : [];
  for (const audioId of audioIds) {
    stopBackgroundAudio(audioId);
  }
  wrapper.__catAdblockerAudioIds = [];
}

function expandReplacementToQuad(wrapper, dimensions, badge, skipButton) {
  if (wrapper.classList.contains(QUAD_GRID_CLASS)) {
    return;
  }

  const expandedWidth = Math.round(dimensions.width * 1.5);
  const expandedHeight = Math.round(dimensions.height * 1.5);
  dimensions.width = expandedWidth;
  dimensions.height = expandedHeight;
  wrapper.style.width = `${expandedWidth}px`;
  wrapper.style.height = `${expandedHeight}px`;
  stopReplacementAudio(wrapper);
  wrapper.querySelectorAll("video, .cat-adblocker-slot__fallback").forEach((node) => {
    node.remove();
  });
  wrapper.classList.add(QUAD_GRID_CLASS);
  badge.textContent = "Cat Adblocker x4";
  skipButton.remove();

  const usedUrls = new Set();
  for (let index = 0; index < 4; index += 1) {
    const quadrant = document.createElement("div");
    quadrant.className = "cat-adblocker-quad__cell";

    const cellDimensions = {
      width: Math.max(Math.floor(dimensions.width / 2), 1),
      height: Math.max(Math.floor(dimensions.height / 2), 1)
    };
    const selectedVideo = pickVideoForDimensions(cellDimensions, usedUrls);
    const { video, fallback } = createReplacementVideo(wrapper, cellDimensions, badge, selectedVideo, quadrant);
    if (selectedVideo) {
      usedUrls.add(selectedVideo.url);
    }

    quadrant.append(video || fallback);
    wrapper.insertBefore(quadrant, badge);
  }
}

function createReplacement(element, dimensions) {
  const wrapper = document.createElement("div");
  wrapper.className = CLASS_NAME;
  wrapper.setAttribute(PROCESS_MARKER, "true");
  wrapper.__catAdblockerAudioIds = [];
  wrapper.style.width = `${dimensions.width}px`;
  wrapper.style.height = `${dimensions.height}px`;
  wrapper.style.display = window.getComputedStyle(element).display === "inline" ? "inline-block" : "block";

  const badge = document.createElement("div");
  badge.className = BADGE_CLASS;
  badge.textContent = "Cat Adblocker";

  const skipButton = createSkipButton(() => {
    expandReplacementToQuad(wrapper, dimensions, badge, skipButton);
  });

  const { video, fallback } = createReplacementVideo(wrapper, dimensions, badge);
  wrapper.append(video || fallback, skipButton, badge);
  return wrapper;
}

function createSkipButton(onSkip) {
  const skipButton = document.createElement("button");
  skipButton.className = SKIP_BUTTON_CLASS;
  skipButton.type = "button";
  skipButton.textContent = "Skip ad";
  skipButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onSkip(skipButton);
  });
  return skipButton;
}

function isYouTubeWebsite() {
  const hostname = window.location.hostname.toLowerCase();
  return YOUTUBE_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

function getYouTubePlayer() {
  return document.querySelector(".html5-video-player");
}

function getYouTubeMainVideo(player) {
  return player?.querySelector("video.html5-main-video") || document.querySelector("video.html5-main-video");
}

function isYouTubeVideoAdActive(player) {
  return Boolean(
    player?.classList.contains("ad-showing") ||
      player?.classList.contains("ad-interrupting") ||
      player?.querySelector(".ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-skip-button-container")
  );
}

function restoreYouTubeVideoState() {
  const video = youtubeReplacement?.video;
  if (!video) {
    return;
  }

  if (typeof youtubeReplacement.wasMuted === "boolean") {
    video.muted = youtubeReplacement.wasMuted;
  }

  if (Number.isFinite(youtubeReplacement.volume)) {
    video.volume = youtubeReplacement.volume;
  }

  video.style.removeProperty("opacity");
}

function removeYouTubeReplacement() {
  if (!youtubeReplacement) {
    return;
  }

  stopReplacementAudio(youtubeReplacement.replacement);
  youtubeReplacement.replacement.remove();
  restoreYouTubeVideoState();
  youtubeReplacement = null;
}

function updateYouTubeReplacementSize(player) {
  if (!youtubeReplacement) {
    return;
  }

  const dimensions = getDimensions(player);
  youtubeReplacement.replacement.style.width = `${dimensions.width}px`;
  youtubeReplacement.replacement.style.height = `${dimensions.height}px`;
}

function replaceYouTubeVideoAd(player) {
  const video = getYouTubeMainVideo(player);
  const dimensions = getDimensions(player);

  if (!video || dimensions.width < MIN_WIDTH || dimensions.height < MIN_HEIGHT) {
    removeYouTubeReplacement();
    return;
  }

  if (youtubeReplacement?.player === player && youtubeReplacement.replacement.isConnected) {
    video.muted = true;
    video.style.setProperty("opacity", "0", "important");
    updateYouTubeReplacementSize(player);
    return;
  }

  removeYouTubeReplacement();

  const replacement = createReplacement(player, dimensions);
  replacement.classList.add("cat-adblocker-youtube-ad");
  replacement.style.position = "absolute";
  replacement.style.inset = "0";
  replacement.style.zIndex = "2147483646";
  replacement.style.pointerEvents = "auto";

  const playerStyle = window.getComputedStyle(player);
  if (playerStyle.position === "static") {
    player.style.position = "relative";
  }

  player.append(replacement);
  youtubeReplacement = {
    player,
    video,
    replacement,
    wasMuted: video.muted,
    volume: video.volume
  };

  video.muted = true;
  video.style.setProperty("opacity", "0", "important");
}

function scanYouTubeVideoAd() {
  if (!enabled || !isYouTubeWebsite()) {
    removeYouTubeReplacement();
    return;
  }

  const player = getYouTubePlayer();
  if (!player || !isYouTubeVideoAdActive(player)) {
    removeYouTubeReplacement();
    return;
  }

  replaceYouTubeVideoAd(player);
}

function startYouTubeAdWatcher() {
  if (youtubeAdInterval || !isYouTubeWebsite()) {
    return;
  }

  scanYouTubeVideoAd();
  youtubeAdInterval = window.setInterval(scanYouTubeVideoAd, YOUTUBE_AD_CHECK_INTERVAL_MS);
}

function stopYouTubeAdWatcher() {
  if (youtubeAdInterval) {
    clearInterval(youtubeAdInterval);
    youtubeAdInterval = null;
  }

  removeYouTubeReplacement();
}

function exitInterruptionFullscreen(overlay) {
  const ownsFullscreen = document.fullscreenElement === overlay || document.webkitFullscreenElement === overlay;
  if (!ownsFullscreen) {
    return;
  }

  if (typeof document.exitFullscreen === "function") {
    document.exitFullscreen().catch(() => {});
    return;
  }

  if (typeof document.webkitExitFullscreen === "function") {
    document.webkitExitFullscreen();
  }
}

function requestInterruptionFullscreen(overlay) {
  const requestFullscreen = overlay.requestFullscreen || overlay.webkitRequestFullscreen;
  if (typeof requestFullscreen !== "function") {
    return;
  }

  const result = requestFullscreen.call(overlay);
  if (result && typeof result.catch === "function") {
    result.catch(() => {});
  }
}

function stopInterruptionMedia(interruption) {
  for (const video of interruption.videos || []) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }

  for (const audioId of interruption.audioIds || []) {
    stopBackgroundAudio(audioId);
  }
}

function formatSeconds(milliseconds) {
  return Math.max(Math.ceil(milliseconds / 1000), 1);
}

function createInterruptionTimeout() {
  return window.setTimeout(() => {
    stopProductiveInterruption();
  }, PRODUCTIVE_INTERRUPT_DURATION_MS);
}

function ensureActiveInterruptionTimeout() {
  if (!activeInterruption || activeInterruption.timeoutId) {
    return;
  }

  activeInterruption.timeoutId = createInterruptionTimeout();
}

function stopProductiveInterruption() {
  if (!activeInterruption) {
    return;
  }

  if (activeInterruption.timeoutId) {
    clearTimeout(activeInterruption.timeoutId);
  }
  stopInterruptionMedia(activeInterruption);
  exitInterruptionFullscreen(activeInterruption.overlay);
  activeInterruption.overlay.remove();
  activeInterruption = null;
  pageTakeoverActive = false;
}

function createInterruptionVideo(container, audioId, dimensions, badge, excludedUrls = new Set()) {
  const video = document.createElement("video");
  video.className = "cat-adblocker-interruption__video";
  video.muted = true;
  configureAutoplayVideo(video);
  video.setAttribute("aria-label", "Random video blocking this productive website");

  const videoState = {
    ...createVideoState(dimensions),
    audioId
  };
  const selectedVideo = pickVideoForDimensions(dimensions, excludedUrls);

  if (selectedVideo) {
    setVideoSource(video, videoState, selectedVideo);
  } else {
    badge.textContent = "Cat Adblocker break";
  }

  attachPlaybackRecovery(container, video, badge, videoState);
  return { video, videoState, selectedVideo };
}

function expandProductiveInterruptionToQuad() {
  if (!activeInterruption || activeInterruption.overlay.classList.contains("cat-adblocker-interruption--quad")) {
    return;
  }

  const { overlay, badge, skipButton } = activeInterruption;
  stopInterruptionMedia(activeInterruption);
  overlay.querySelectorAll("video").forEach((video) => {
    video.remove();
  });
  overlay.classList.add("cat-adblocker-interruption--quad");
  badge.textContent = `Back in ${formatSeconds(PRODUCTIVE_INTERRUPT_DURATION_MS)} seconds`;
  skipButton?.remove();
  ensureActiveInterruptionTimeout();

  const dimensions = {
    width: Math.max(Math.floor(window.innerWidth / 2), 1),
    height: Math.max(Math.floor(window.innerHeight / 2), 1)
  };
  const usedUrls = new Set();
  const videos = [];
  const audioIds = [];

  for (let index = 0; index < 4; index += 1) {
    const cell = document.createElement("div");
    cell.className = "cat-adblocker-interruption__cell";
    const audioId = `productive-interruption-${index + 1}`;
    const { video, selectedVideo } = createInterruptionVideo(cell, audioId, dimensions, badge, usedUrls);

    if (selectedVideo) {
      usedUrls.add(selectedVideo.url);
    }

    cell.append(video);
    overlay.insertBefore(cell, badge);
    videos.push(video);
    audioIds.push(audioId);
  }

  activeInterruption.videos = videos;
  activeInterruption.audioIds = audioIds;
}

function startProductiveInterruption() {
  if (activeInterruption || !enabled || isPopupGraceActive()) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "cat-adblocker-interruption";
  overlay.setAttribute(PROCESS_MARKER, "true");

  const badge = document.createElement("div");
  badge.className = "cat-adblocker-interruption__badge";
  badge.textContent = `Back in ${formatSeconds(PRODUCTIVE_INTERRUPT_DURATION_MS)} seconds`;

  const skipButton = document.createElement("button");
  skipButton.className = "cat-adblocker-interruption__skip";
  skipButton.type = "button";
  skipButton.textContent = "Skip ad";
  skipButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    expandProductiveInterruptionToQuad();
  });

  const dimensions = {
    width: Math.max(window.innerWidth, 1),
    height: Math.max(window.innerHeight, 1)
  };
  const { video, videoState } = createInterruptionVideo(overlay, "productive-interruption", dimensions, badge);

  overlay.append(video, skipButton, badge);
  document.documentElement.append(overlay);

  activeInterruption = {
    overlay,
    videos: [video],
    audioIds: [videoState.audioId],
    badge,
    skipButton,
    timeoutId: createInterruptionTimeout()
  };

  window.requestAnimationFrame(() => {
    if (overlay.isConnected) {
      requestInterruptionFullscreen(overlay);
    }
  });
}

function findOiiaiVideo() {
  for (const category of indexedCategories) {
    const video = category.videos.find((entry) => entry.filename === OIIAI_VIDEO_FILENAME);
    if (video) {
      return video;
    }
  }

  return activeVideos.find((entry) => entry.filename === OIIAI_VIDEO_FILENAME) || null;
}

function stopOiiaiTakeover() {
  if (!activeOiiaiTakeover) {
    return;
  }

  stopBackgroundAudio(OIIAI_AUDIO_ID);
  activeOiiaiTakeover.overlay.remove();
  activeOiiaiTakeover = null;
}

function startOiiaiTakeover() {
  if (!enabled) {
    return;
  }

  const selectedVideo = findOiiaiVideo();
  if (!selectedVideo?.url) {
    return;
  }

  stopOiiaiTakeover();

  const overlay = document.createElement("div");
  overlay.className = "cat-adblocker-oiiai-takeover";
  overlay.setAttribute(PROCESS_MARKER, "true");

  const tint = document.createElement("div");
  tint.className = "cat-adblocker-oiiai-takeover__tint";

  const lasers = document.createElement("div");
  lasers.className = "cat-adblocker-oiiai-takeover__lasers";

  overlay.append(tint, lasers);
  document.documentElement.append(overlay);
  activeOiiaiTakeover = { overlay };

  startBackgroundAudio(OIIAI_AUDIO_ID, selectedVideo.url, { loop: true, volume: 1 });
}

function isPageTimelineActive() {
  return enabled && document.visibilityState === "visible" && windowHasFocus;
}

function removeRandomInsertion(wrapper) {
  if (!wrapper) {
    return;
  }

  if (wrapper.__catAdblockerTimeoutId) {
    clearTimeout(wrapper.__catAdblockerTimeoutId);
    wrapper.__catAdblockerTimeoutId = null;
  }

  stopReplacementAudio(wrapper);
  wrapper.remove();
  randomInsertions = randomInsertions.filter((entry) => entry !== wrapper);
}

function createFloatingCatVideo() {
  if (
    isPopupGraceActive() ||
    !isPageTimelineActive() ||
    activeVideos.length === 0 ||
    randomInsertions.length >= MAX_RANDOM_INSERTIONS
  ) {
    return;
  }

  const size = RANDOM_INSERT_MIN_SIZE + Math.floor(Math.random() * (RANDOM_INSERT_MAX_SIZE - RANDOM_INSERT_MIN_SIZE));
  const dimensions = {
    width: size,
    height: Math.max(Math.floor(size * (0.58 + Math.random() * 0.42)), RANDOM_INSERT_MIN_SIZE)
  };
  const wrapper = document.createElement("div");
  wrapper.className = "cat-adblocker-random-insert";
  wrapper.setAttribute(PROCESS_MARKER, "true");
  wrapper.__catAdblockerAudioIds = [];
  wrapper.style.width = `${dimensions.width}px`;
  wrapper.style.height = `${dimensions.height}px`;
  wrapper.style.left = `${Math.max(8, Math.random() * Math.max(window.innerWidth - dimensions.width - 16, 8))}px`;
  wrapper.style.top = `${Math.max(8, Math.random() * Math.max(window.innerHeight - dimensions.height - 16, 8))}px`;

  const badge = document.createElement("div");
  badge.className = BADGE_CLASS;
  badge.textContent = "Cat Adblocker";

  const { video, fallback } = createReplacementVideo(wrapper, dimensions, badge);
  const skipButton = createSkipButton(() => {
    expandReplacementToQuad(wrapper, dimensions, badge, skipButton);
  });
  wrapper.append(video || fallback, skipButton, badge);
  document.documentElement.append(wrapper);
  randomInsertions.push(wrapper);
  wrapper.__catAdblockerTimeoutId = window.setTimeout(() => {
    removeRandomInsertion(wrapper);
  }, RANDOM_INSERT_LIFETIME_MS);
}

function startRandomInsertions() {
  if (randomInsertInterval) {
    return;
  }

  createFloatingCatVideo();
  randomInsertInterval = window.setInterval(createFloatingCatVideo, RANDOM_INSERT_INTERVAL_MS);
}

function stopRandomInsertions() {
  if (randomInsertInterval) {
    clearInterval(randomInsertInterval);
    randomInsertInterval = null;
  }

  for (const wrapper of [...randomInsertions]) {
    removeRandomInsertion(wrapper);
  }
}

function isReplaceableMainElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.hasAttribute(PROCESS_MARKER) || element.closest(`.${CLASS_NAME}, .cat-adblocker-random-insert`)) {
    return false;
  }

  if (element.matches("html, body, script, style, link, meta, noscript, iframe, video, audio, canvas, svg")) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }

  const { width, height } = getDimensions(element);
  const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
  const area = width * height;
  return width >= 240 && height >= 140 && area >= viewportArea * 0.08 && area <= viewportArea * 0.75;
}

function replaceMainPageElements() {
  if (mainElementsReplaced) {
    return;
  }

  const preferred = Array.from(document.querySelectorAll("main, article, [role='main'], section")).filter(
    isReplaceableMainElement
  );
  const candidates = preferred.length
    ? preferred
    : Array.from(document.body?.children || []).filter(isReplaceableMainElement);

  for (const element of candidates.slice(0, 3)) {
    replaceElement(element);
  }

  mainElementsReplaced = true;
}

function startPageTakeover() {
  if (pageTakeoverActive || pageTakeoverShown || !enabled || isPopupGraceActive()) {
    return;
  }

  if (!activeInterruption) {
    startProductiveInterruption();
    if (!activeInterruption) {
      return;
    }
  }

  pageTakeoverActive = true;
  pageTakeoverShown = true;
  activeInterruption.badge.textContent = `Back in ${formatSeconds(PRODUCTIVE_INTERRUPT_DURATION_MS)} seconds`;
  ensureActiveInterruptionTimeout();
}

function applyPageTimeline() {
  scan(document);

  if (pageTimelineElapsedMs >= PAGE_TIMELINE_RANDOM_INSERT_MS) {
    startRandomInsertions();
    schedulePawInterruption();
  }

  if (pageTimelineElapsedMs >= PAGE_TIMELINE_MAIN_REPLACE_MS) {
    replaceMainPageElements();
  }

  if (pageTimelineElapsedMs >= PAGE_TIMELINE_TAKEOVER_MS) {
    startPageTakeover();
  }
}

function trackPageTimeline() {
  const now = Date.now();

  if (isPageTimelineActive()) {
    pageTimelineElapsedMs += lastPageTimelineTickAt ? now - lastPageTimelineTickAt : 0;
    applyPageTimeline();
  }

  lastPageTimelineTickAt = now;
}

function startPageTimeline() {
  if (pageTimelineInterval) {
    return;
  }

  lastPageTimelineTickAt = Date.now();
  applyPageTimeline();
  pageTimelineInterval = window.setInterval(trackPageTimeline, PAGE_TIMELINE_TICK_MS);
}

function stopPageTimeline() {
  if (pageTimelineInterval) {
    clearInterval(pageTimelineInterval);
    pageTimelineInterval = null;
  }

  pageTimelineElapsedMs = 0;
  lastPageTimelineTickAt = 0;
  mainElementsReplaced = false;
  pageTakeoverShown = false;
  stopRandomInsertions();
}

function clamp(value, min, max) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, lower), upper);
}

function getRandomPawDelay() {
  const range = PAW_INTERRUPT_MAX_DELAY_MS - PAW_INTERRUPT_MIN_DELAY_MS;
  return PAW_INTERRUPT_MIN_DELAY_MS + Math.floor(Math.random() * (range + 1));
}

function canRunPawInterruption() {
  return enabled && !isPopupGraceActive() && document.visibilityState === "visible" && windowHasFocus;
}

function stopPawInterruptionTimer() {
  if (!pawInterruptTimeout) {
    return;
  }

  clearTimeout(pawInterruptTimeout);
  pawInterruptTimeout = null;
}

function cleanupPawInterruption() {
  stopPawInterruptionTimer();

  if (!activePawInterruption) {
    document.documentElement.classList.remove("cat-adblocker-hide-cursor");
    return;
  }

  clearTimeout(activePawInterruption.timeoutId);
  clearTimeout(activePawInterruption.cursorMoveTimeoutId);
  activePawInterruption.cancelled = true;
  activePawInterruption.overlay.remove();
  activePawInterruption = null;
  document.documentElement.classList.remove("cat-adblocker-hide-cursor");
}

function startPawCursorMove(interruption) {
  if (!interruption) {
    return Promise.resolve(false);
  }

  if (interruption.cursorMovePromise) {
    return interruption.cursorMovePromise;
  }

  interruption.cursorMovePromise = requestCursorMove(interruption.cursorEnd).then((moved) => {
    if (moved && activePawInterruption === interruption) {
      lastPointerPosition = interruption.cursorEnd;
    }

    return moved;
  });

  return interruption.cursorMovePromise;
}

function finishPawInterruption(interruption) {
  if (!interruption || activePawInterruption !== interruption || interruption.finishing) {
    return;
  }

  interruption.finishing = true;
  clearTimeout(interruption.timeoutId);
  clearTimeout(interruption.cursorMoveTimeoutId);
  interruption.overlay.classList.add("cat-adblocker-paw-overlay--settling");

  startPawCursorMove(interruption).finally(() => {
    if (activePawInterruption !== interruption || interruption.cancelled) {
      return;
    }

    cleanupPawInterruption();
    schedulePawInterruption();
  });
}

function schedulePawInterruption() {
  stopPawInterruptionTimer();

  if (!canRunPawInterruption() || activePawInterruption) {
    return;
  }

  pawInterruptTimeout = window.setTimeout(() => {
    pawInterruptTimeout = null;
    startPawInterruption();
  }, getRandomPawDelay());
}

function getPushedCursorPosition(start, swipeDirection) {
  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(window.innerHeight, 1);
  const minX = FAKE_CURSOR_SIZE;
  const maxX = viewportWidth - FAKE_CURSOR_SIZE;
  const availableDistance = swipeDirection > 0 ? maxX - start.x : start.x - minX;
  const minDistance = Math.min(PAW_PUSH_MIN_DISTANCE, Math.max(availableDistance, 0));
  const maxDistance = Math.min(
    Math.max(PAW_PUSH_MAX_DISTANCE, viewportWidth * 0.55),
    Math.max(availableDistance, minDistance)
  );
  const pushDistance = minDistance + Math.random() * Math.max(maxDistance - minDistance, 0);
  const upwardLift = Math.max(70, Math.min(viewportHeight * 0.22, 180));

  return {
    x: clamp(start.x + swipeDirection * pushDistance, minX, maxX),
    y: clamp(start.y - upwardLift * Math.random(), FAKE_CURSOR_SIZE, viewportHeight - FAKE_CURSOR_SIZE)
  };
}

function startPawInterruption() {
  if (!canRunPawInterruption() || activePawInterruption) {
    schedulePawInterruption();
    return;
  }

  if (!lastPointerPosition) {
    schedulePawInterruption();
    return;
  }

  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(window.innerHeight, 1);
  const cursorStart = {
    x: clamp(lastPointerPosition.x, FAKE_CURSOR_SIZE, viewportWidth - FAKE_CURSOR_SIZE),
    y: clamp(lastPointerPosition.y, FAKE_CURSOR_SIZE, viewportHeight - FAKE_CURSOR_SIZE)
  };
  const swipeDirection = Math.random() < 0.5 ? 1 : -1;
  const pawRenderedHeight = Math.max(viewportHeight * PAW_HEIGHT_VIEWPORT_RATIO, 140);
  const pawStartX = swipeDirection > 0 ? -pawRenderedHeight * 1.15 : viewportWidth + pawRenderedHeight * 0.15;
  const pawTravel = viewportWidth + pawRenderedHeight * 1.35;
  const cursorEnd = getPushedCursorPosition(cursorStart, swipeDirection);

  const overlay = document.createElement("div");
  overlay.className = "cat-adblocker-paw-overlay";
  overlay.setAttribute(PROCESS_MARKER, "true");

  const paw = document.createElement("img");
  paw.className = "cat-adblocker-paw";
  paw.alt = "";
  paw.decoding = "async";
  paw.src = browser.runtime.getURL(PAW_IMAGE_PATH);
  paw.style.left = `${pawStartX}px`;
  paw.style.height = `${pawRenderedHeight}px`;
  paw.style.setProperty("--cat-adblocker-paw-travel", `${pawTravel * swipeDirection}px`);

  const fakeCursor = document.createElement("div");
  fakeCursor.className = "cat-adblocker-fake-cursor";
  fakeCursor.style.left = `${cursorStart.x}px`;
  fakeCursor.style.top = `${cursorStart.y}px`;
  fakeCursor.style.setProperty("--cat-adblocker-cursor-dx", `${cursorEnd.x - cursorStart.x}px`);
  fakeCursor.style.setProperty("--cat-adblocker-cursor-dy", `${cursorEnd.y - cursorStart.y}px`);

  overlay.append(paw, fakeCursor);
  document.documentElement.append(overlay);
  document.documentElement.classList.add("cat-adblocker-hide-cursor");

  const interruption = {
    overlay,
    timeoutId: null,
    cursorMoveTimeoutId: null,
    cursorEnd,
    cursorMovePromise: null,
    finishing: false,
    cancelled: false
  };

  const cursorMoveTimeoutId = window.setTimeout(() => {
    if (activePawInterruption !== interruption) {
      return;
    }

    startPawCursorMove(interruption);
  }, PAW_CURSOR_MOVE_DELAY_MS);

  const timeoutId = window.setTimeout(() => {
    finishPawInterruption(interruption);
  }, PAW_INTERRUPT_DURATION_MS);

  interruption.timeoutId = timeoutId;
  interruption.cursorMoveTimeoutId = cursorMoveTimeoutId;
  activePawInterruption = interruption;
}

function replaceElement(element) {
  const dimensions = getDimensions(element);
  const replacement = createReplacement(element, dimensions);
  const placeholder = document.createComment("cat-adblocker-placeholder");
  const originalDisplay = element.style.display;

  if (!element.parentNode) {
    return;
  }

  element.parentNode.insertBefore(placeholder, element);
  element.style.setProperty("display", "none", "important");
  element.setAttribute(PROCESS_MARKER, "true");
  element.setAttribute(HIDDEN_MARKER, "true");
  placeholder.parentNode.insertBefore(replacement, placeholder.nextSibling);

  replacements.set(element, {
    placeholder,
    replacement,
    originalDisplay
  });
}

function scan(root = document) {
  if (!enabled) {
    return;
  }

  const elements = root instanceof Element ? [root, ...getCandidateElements(root)] : getCandidateElements(root);
  for (const element of elements) {
    if (isLikelyAd(element)) {
      replaceElement(element);
    }
  }
}

function restoreAll() {
  cleanupPawInterruption();
  stopOiiaiTakeover();
  stopPageTimeline();
  stopProductiveInterruption();
  stopYouTubeAdWatcher();
  stopAllBackgroundAudio();

  for (const [element, entry] of replacements.entries()) {
    stopReplacementAudio(entry.replacement);
    entry.replacement.remove();
    entry.placeholder.remove();
    element.style.display = entry.originalDisplay;
    element.removeAttribute(PROCESS_MARKER);
    element.removeAttribute(HIDDEN_MARKER);
    replacements.delete(element);
  }
}

function startObserver() {
  if (observer) {
    return;
  }

  observer = new MutationObserver((mutations) => {
    if (!enabled) {
      return;
    }

    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          scan(node);
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

function stopObserver() {
  observer?.disconnect();
  observer = null;
}

function isProductiveUsageActive() {
  return (
    enabled &&
    !isPopupGraceActive() &&
    isProductiveWebsite() &&
    document.visibilityState === "visible" &&
    windowHasFocus &&
    !activeInterruption
  );
}

function trackProductiveUsage() {
  const now = Date.now();

  if (isProductiveUsageActive()) {
    productiveUsageElapsedMs += lastProductiveTickAt ? now - lastProductiveTickAt : 0;
    if (productiveUsageElapsedMs >= PRODUCTIVE_INTERRUPT_DELAY_MS) {
      productiveUsageElapsedMs = 0;
      startProductiveInterruption();
    }
  }

  lastProductiveTickAt = now;
}

function startProductiveUsageTimer() {
  if (productiveUsageInterval || !isProductiveWebsite()) {
    return;
  }

  lastProductiveTickAt = Date.now();
  productiveUsageInterval = window.setInterval(trackProductiveUsage, 500);
}

function stopProductiveUsageTimer() {
  if (productiveUsageInterval) {
    clearInterval(productiveUsageInterval);
    productiveUsageInterval = null;
  }

  productiveUsageElapsedMs = 0;
  lastProductiveTickAt = 0;
  stopProductiveInterruption();
}

async function init() {
  const settings = await browser.storage.local.get(STORAGE_DEFAULTS);
  await loadVideoIndex();
  enabled = Boolean(settings.enabled);
  enabledCategoryIds = Array.isArray(settings.enabledCategoryIds)
    ? settings.enabledCategoryIds
    : [...STORAGE_DEFAULTS.enabledCategoryIds];
  refreshActiveVideos();

  if (enabled) {
    resetPopupGracePeriod();
    scan(document);
    startObserver();
    startYouTubeAdWatcher();
    startProductiveUsageTimer();
    startPageTimeline();
    schedulePawInterruption();
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAT_ADBLOCKER_APPLY_ENABLED") {
    enabled = Boolean(message.enabled);
    if (enabled) {
      resetPopupGracePeriod();
      scan(document);
      startObserver();
      startYouTubeAdWatcher();
      startProductiveUsageTimer();
      startPageTimeline();
      schedulePawInterruption();
    } else {
      stopObserver();
      stopYouTubeAdWatcher();
      stopProductiveUsageTimer();
      restoreAll();
    }
  }

  if (message?.type === "CAT_ADBLOCKER_RESCAN" && enabled) {
    scan(document);
    scanYouTubeVideoAd();
  }

  if (message?.type === "CAT_ADBLOCKER_RUN_INTERRUPTION_NOW" && enabled) {
    productiveUsageElapsedMs = 0;
    startProductiveInterruption();
  }

  if (message?.type === "CAT_ADBLOCKER_APPLY_CATEGORIES") {
    enabledCategoryIds = Array.isArray(message.enabledCategoryIds)
      ? message.enabledCategoryIds
      : [...STORAGE_DEFAULTS.enabledCategoryIds];
    refreshActiveVideos();
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.enabled) {
    enabled = Boolean(changes.enabled.newValue);
    if (enabled) {
      resetPopupGracePeriod();
      scan(document);
      startObserver();
      startYouTubeAdWatcher();
      startProductiveUsageTimer();
      startPageTimeline();
      schedulePawInterruption();
    } else {
      stopObserver();
      stopYouTubeAdWatcher();
      stopProductiveUsageTimer();
      restoreAll();
    }
  }

  if (changes.enabledCategoryIds) {
    enabledCategoryIds = Array.isArray(changes.enabledCategoryIds.newValue)
      ? changes.enabledCategoryIds.newValue
      : [...STORAGE_DEFAULTS.enabledCategoryIds];
    refreshActiveVideos();
  }
});

window.addEventListener("focus", () => {
  windowHasFocus = true;
  lastProductiveTickAt = Date.now();
  schedulePawInterruption();
});

window.addEventListener("blur", () => {
  windowHasFocus = false;
  lastProductiveTickAt = Date.now();
  cleanupPawInterruption();
});

document.addEventListener("visibilitychange", () => {
  lastProductiveTickAt = Date.now();
  if (document.visibilityState === "visible") {
    schedulePawInterruption();
  } else {
    cleanupPawInterruption();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.repeat) {
    startOiiaiTakeover();
    return;
  }

  if (event.key === "Escape") {
    stopOiiaiTakeover();
  }
});

window.addEventListener("pagehide", () => {
  stopOiiaiTakeover();
  cleanupPawInterruption();
  stopAllBackgroundAudio();
});

document.addEventListener(
  "pointermove",
  (event) => {
    lastPointerPosition = {
      x: event.clientX,
      y: event.clientY
    };
  },
  { passive: true }
);

document.addEventListener(
  "mousemove",
  (event) => {
    lastPointerPosition = {
      x: event.clientX,
      y: event.clientY
    };
  },
  { passive: true }
);

init();
