const STORAGE_DEFAULTS = {
  enabled: true,
  enabledCategoryIds: ["cat-videos"]
};

const FALLBACK_VIDEOS = [
  {
    url: browser.runtime.getURL("assets/videos/cat-videos/cat-loop-1.webm"),
    categoryId: "cat-videos",
    width: null,
    height: null,
    aspectRatio: null
  },
  {
    url: browser.runtime.getURL("assets/videos/cat-videos/cat-loop-2.webm"),
    categoryId: "cat-videos",
    width: null,
    height: null,
    aspectRatio: null
  }
];
const VIDEO_INDEX_PATH = "assets/video-index.json";
const MAX_VIDEO_RETRIES = 3;
const TOP_MATCH_COUNT = 3;

const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;
const PROCESS_MARKER = "data-cat-adblocker-processed";
const HIDDEN_MARKER = "data-cat-adblocker-hidden";
const CLASS_NAME = "cat-adblocker-slot";
const BADGE_CLASS = "cat-adblocker-badge";

const replacements = new Map();
let observer = null;
let enabled = true;
let enabledCategoryIds = [...STORAGE_DEFAULTS.enabledCategoryIds];
let indexedCategories = [];
let activeVideos = [...FALLBACK_VIDEOS];

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
  if (!entry || typeof entry.path !== "string") {
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
    url: browser.runtime.getURL(entry.path),
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

async function loadVideoIndex() {
  try {
    const response = await fetch(browser.runtime.getURL(VIDEO_INDEX_PATH));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const categories = Array.isArray(payload?.categories)
      ? payload.categories.map(normalizeCategory).filter(Boolean)
      : [];
    indexedCategories = categories;
  } catch (error) {
    console.warn("Cat Adblocker failed to load video index, using fallback videos.", error);
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

  return [...FALLBACK_VIDEOS];
}

function refreshActiveVideos() {
  activeVideos = getCategoryVideos(enabledCategoryIds);
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

function ensurePlaying(video) {
  const playPromise = video.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch(() => {});
  }
}

function setVideoSource(video, videoState, nextVideo) {
  if (!nextVideo) {
    return false;
  }

  videoState.currentVideo = nextVideo;
  videoState.ignorePauseUntil = Date.now() + 250;
  video.src = nextVideo.url;
  video.load();
  ensurePlaying(video);
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
    renderVideoFallback(wrapper, video, badge);
    return;
  }

  if (videoState.currentVideo?.url) {
    videoState.failedUrls.add(videoState.currentVideo.url);
  }

  const nextVideo = pickVideoForDimensions(videoState.dimensions, videoState.failedUrls);
  if (!nextVideo) {
    renderVideoFallback(wrapper, video, badge);
    return;
  }

  videoState.retryCount += 1;
  setVideoSource(video, videoState, nextVideo);
}

function attachPlaybackRecovery(wrapper, video, badge, videoState) {
  video.addEventListener("ended", () => {
    video.currentTime = 0;
    ensurePlaying(video);
  });

  video.addEventListener("pause", () => {
    if (Date.now() < videoState.ignorePauseUntil || video.ended || video.seeking || !video.src) {
      return;
    }

    ensurePlaying(video);
  });

  video.addEventListener("stalled", () => {
    videoState.ignorePauseUntil = Date.now() + 250;
    video.load();
    ensurePlaying(video);
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
  video.defaultMuted = true;
  video.autoplay = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("aria-label", "Cat video replacing an ad");

  video.addEventListener("mouseenter", () => {
    video.muted = false;
  });

  video.addEventListener("mouseleave", () => {
    video.muted = true;
  });

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
    ignorePauseUntil: 0
  };

  if (initialVideo) {
    setVideoSource(video, videoState, initialVideo);
  } else {
    renderVideoFallback(wrapper, video, badge);
  }

  attachPlaybackRecovery(wrapper, video, badge, videoState);
  return wrapper;
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
  for (const [element, entry] of replacements.entries()) {
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
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "CAT_ADBLOCKER_APPLY_ENABLED") {
    enabled = Boolean(message.enabled);
    if (enabled) {
      scan(document);
      startObserver();
    } else {
      stopObserver();
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
    } else {
      stopObserver();
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

init();
