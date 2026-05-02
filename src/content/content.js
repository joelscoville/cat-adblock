const STORAGE_DEFAULTS = {
  enabled: true,
  enabledCategoryIds: ["cat-videos"]
};

const REMOTE_VIDEO_INDEX_URL = "http://localhost:3000/api/videos";
const MAX_VIDEO_RETRIES = 3;
const TOP_MATCH_COUNT = 3;

const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;
const PROCESS_MARKER = "data-cat-adblocker-processed";
const HIDDEN_MARKER = "data-cat-adblocker-hidden";
const CLASS_NAME = "cat-adblocker-slot";
const BADGE_CLASS = "cat-adblocker-badge";
const PRODUCTIVE_INTERRUPT_DELAY_MS = 60 * 1000;
const PRODUCTIVE_INTERRUPT_DURATION_MS = 15 * 1000;
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
  "trello.com"
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
let windowHasFocus = document.hasFocus();
let activeInterruption = null;
let nextAudioId = 1;

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

function startBackgroundAudio(audioId, url) {
  if (!audioId || !url) {
    return;
  }

  browser.runtime
    .sendMessage({
      type: "CAT_ADBLOCKER_START_AUDIO",
      audioId,
      url,
      loop: true,
      volume: 1
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

  const fallback = document.createElement("div");
  fallback.className = "cat-adblocker-slot__fallback";
  fallback.textContent = "Video unavailable. Still blocking the ad slot.";
  wrapper.insertBefore(fallback, badge);
}

function recoverVideo(wrapper, video, badge, videoState) {
  if (videoState.retryCount >= MAX_VIDEO_RETRIES) {
    stopBackgroundAudio(videoState.audioId);
    renderVideoFallback(wrapper, video, badge);
    return;
  }

  if (videoState.currentVideo?.url) {
    videoState.failedUrls.add(videoState.currentVideo.url);
  }

  const nextVideo = pickVideoForDimensions(videoState.dimensions, videoState.failedUrls);
  if (!nextVideo) {
    stopBackgroundAudio(videoState.audioId);
    renderVideoFallback(wrapper, video, badge);
    return;
  }

  videoState.retryCount += 1;
  setVideoSource(video, videoState, nextVideo);
}

function attachPlaybackRecovery(wrapper, video, badge, videoState) {
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
    recoverVideo(wrapper, video, badge, videoState);
  });
}

function createReplacement(element, dimensions) {
  const wrapper = document.createElement("div");
  wrapper.className = CLASS_NAME;
  wrapper.setAttribute(PROCESS_MARKER, "true");
  wrapper.style.width = `${dimensions.width}px`;
  wrapper.style.height = `${dimensions.height}px`;
  wrapper.style.display = window.getComputedStyle(element).display === "inline" ? "inline-block" : "block";

  const video = document.createElement("video");
  video.muted = true;
  configureAutoplayVideo(video);
  video.setAttribute("aria-label", "Cat video replacing an ad");

  const badge = document.createElement("div");
  badge.className = BADGE_CLASS;
  badge.textContent = "Cat Adblocker";
  wrapper.append(video, badge);

  const initialVideo = pickVideoForDimensions(dimensions);
  const videoState = {
    currentVideo: null,
    dimensions,
    retryCount: 0,
    failedUrls: new Set(),
    audioId: `slot-${nextAudioId}`,
    ignorePauseUntil: 0,
    playRetryPending: false
  };
  nextAudioId += 1;
  wrapper.__catAdblockerAudioId = videoState.audioId;

  if (initialVideo) {
    setVideoSource(video, videoState, initialVideo);
  } else {
    renderVideoFallback(wrapper, video, badge);
  }

  attachPlaybackRecovery(wrapper, video, badge, videoState);
  return wrapper;
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

function stopProductiveInterruption() {
  if (!activeInterruption) {
    return;
  }

  clearTimeout(activeInterruption.timeoutId);
  activeInterruption.video.pause();
  activeInterruption.video.removeAttribute("src");
  activeInterruption.video.load();
  stopBackgroundAudio("productive-interruption");
  exitInterruptionFullscreen(activeInterruption.overlay);
  activeInterruption.overlay.remove();
  activeInterruption = null;
}

function startProductiveInterruption() {
  if (activeInterruption || !enabled) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "cat-adblocker-interruption";
  overlay.setAttribute(PROCESS_MARKER, "true");

  const video = document.createElement("video");
  video.className = "cat-adblocker-interruption__video";
  video.muted = true;
  configureAutoplayVideo(video);
  video.setAttribute("aria-label", "Random video blocking this productive website");
  const videoState = {
    audioId: "productive-interruption",
    playRetryPending: false
  };

  const badge = document.createElement("div");
  badge.className = "cat-adblocker-interruption__badge";
  badge.textContent = "Back in 15 seconds";

  overlay.append(video, badge);
  document.documentElement.append(overlay);

  const timeoutId = window.setTimeout(() => {
    stopProductiveInterruption();
  }, PRODUCTIVE_INTERRUPT_DURATION_MS);

  activeInterruption = {
    overlay,
    video,
    videoState,
    timeoutId
  };

  const selectedVideo = pickVideoForDimensions({
    width: Math.max(window.innerWidth, 1),
    height: Math.max(window.innerHeight, 1)
  });

  if (selectedVideo) {
    video.src = selectedVideo.url;
    video.load();
    ensurePlaying(video, videoState);
    startBackgroundAudio(videoState.audioId, selectedVideo.url);
  } else {
    badge.textContent = "Cat Adblocker break";
  }

  window.requestAnimationFrame(() => {
    if (overlay.isConnected) {
      requestInterruptionFullscreen(overlay);
    }
  });
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
    audioId: replacement.__catAdblockerAudioId,
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
  stopProductiveInterruption();
  stopAllBackgroundAudio();

  for (const [element, entry] of replacements.entries()) {
    stopBackgroundAudio(entry.audioId);
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
  return enabled && isProductiveWebsite() && document.visibilityState === "visible" && windowHasFocus && !activeInterruption;
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
  productiveUsageInterval = window.setInterval(trackProductiveUsage, 1000);
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
    scan(document);
    startObserver();
    startProductiveUsageTimer();
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAT_ADBLOCKER_APPLY_ENABLED") {
    enabled = Boolean(message.enabled);
    if (enabled) {
      scan(document);
      startObserver();
      startProductiveUsageTimer();
    } else {
      stopObserver();
      stopProductiveUsageTimer();
      restoreAll();
    }
  }

  if (message?.type === "CAT_ADBLOCKER_RESCAN" && enabled) {
    scan(document);
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
      scan(document);
      startObserver();
      startProductiveUsageTimer();
    } else {
      stopObserver();
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
});

window.addEventListener("blur", () => {
  windowHasFocus = false;
  lastProductiveTickAt = Date.now();
});

document.addEventListener("visibilitychange", () => {
  lastProductiveTickAt = Date.now();
});

window.addEventListener("pagehide", () => {
  stopAllBackgroundAudio();
});

init();
