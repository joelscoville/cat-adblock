const STORAGE_DEFAULTS = {
  enabled: true
};

const FALLBACK_VIDEO_PATHS = [
  browser.runtime.getURL("assets/videos/cat-loop-1.webm"),
  browser.runtime.getURL("assets/videos/cat-loop-2.webm")
];
const VIDEO_MANIFEST_PATH = "assets/video-manifest.json";
let videoPaths = [...FALLBACK_VIDEO_PATHS];

const MIN_WIDTH = 120;
const MIN_HEIGHT = 60;
const PROCESS_MARKER = "data-cat-adblocker-processed";
const HIDDEN_MARKER = "data-cat-adblocker-hidden";
const CLASS_NAME = "cat-adblocker-slot";
const BADGE_CLASS = "cat-adblocker-badge";

const replacements = new Map();
let observer = null;
let enabled = true;

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

function pickVideoPath() {
  const index = Math.floor(Math.random() * videoPaths.length);
  return videoPaths[index];
}

async function loadVideoPaths() {
  try {
    const response = await fetch(browser.runtime.getURL(VIDEO_MANIFEST_PATH));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const filenames = await response.json();
    if (!Array.isArray(filenames) || filenames.length === 0) {
      throw new Error("Empty or invalid video manifest");
    }

    videoPaths = filenames.map((filename) => browser.runtime.getURL(`assets/videos/${filename}`));
  } catch (error) {
    console.warn("Cat Adblocker failed to load video manifest, using fallback videos.", error);
    videoPaths = [...FALLBACK_VIDEO_PATHS];
  }
}

function createReplacement(element, dimensions) {
  const wrapper = document.createElement("div");
  wrapper.className = CLASS_NAME;
  wrapper.setAttribute(PROCESS_MARKER, "true");
  wrapper.style.width = `${dimensions.width}px`;
  wrapper.style.height = `${dimensions.height}px`;
  wrapper.style.display = window.getComputedStyle(element).display === "inline" ? "inline-block" : "block";

  const video = document.createElement("video");
  video.src = pickVideoPath();
  video.muted = true;
  video.autoplay = true;
  video.loop = true;
  video.playsInline = true;
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
  await loadVideoPaths();
  enabled = Boolean(settings.enabled);

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
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.enabled) {
    return;
  }

  enabled = Boolean(changes.enabled.newValue);
  if (enabled) {
    scan(document);
    startObserver();
  } else {
    stopObserver();
    restoreAll();
  }
});

init();
