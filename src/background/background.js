const DEFAULT_SETTINGS = {
  enabled: true,
  enabledCategoryIds: ["cat-videos"]
};
let enabled = DEFAULT_SETTINGS.enabled;
const tabAudio = new Map();

const BLOCKED_HOST_SNIPPETS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
  "criteo.com",
  "adsystem.com",
  "zedo.com"
];

const BLOCKED_PATH_SNIPPETS = [
  "/ads/",
  "adservice",
  "advert",
  "banner"
];

function getTabAudio(tabId) {
  if (!tabAudio.has(tabId)) {
    tabAudio.set(tabId, new Map());
  }

  return tabAudio.get(tabId);
}

function stopTabAudio(tabId, audioId) {
  const audioById = tabAudio.get(tabId);
  if (!audioById) {
    return;
  }

  const audio = audioById.get(audioId);
  if (!audio) {
    return;
  }

  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  audioById.delete(audioId);

  if (audioById.size === 0) {
    tabAudio.delete(tabId);
  }
}

function stopAllTabAudio(tabId) {
  const audioById = tabAudio.get(tabId);
  if (!audioById) {
    return;
  }

  for (const audio of audioById.values()) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  tabAudio.delete(tabId);
}

function startTabAudio(tabId, audioId, url, options = {}) {
  stopTabAudio(tabId, audioId);

  const audio = new Audio(url);
  audio.loop = options.loop !== false;
  audio.volume = Number.isFinite(options.volume) ? Math.max(0, Math.min(options.volume, 1)) : 1;
  audio.preload = "auto";

  getTabAudio(tabId).set(audioId, audio);

  const playPromise = audio.play();
  if (playPromise && typeof playPromise.catch === "function") {
    playPromise.catch((error) => {
      stopTabAudio(tabId, audioId);
      console.warn("Cat Adblocker background audio autoplay failed.", error);
    });
  }
}

browser.runtime.onInstalled.addListener(async () => {
  const current = await browser.storage.local.get(DEFAULT_SETTINGS);
  const nextSettings = {
    ...DEFAULT_SETTINGS,
    ...current
  };

  enabled = Boolean(nextSettings.enabled);
  await browser.storage.local.set(nextSettings);
});

function isBlockedRequest(urlString, type) {
  if (!urlString || (type !== "sub_frame" && type !== "image" && type !== "object")) {
    return false;
  }

  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase();
    const path = `${url.pathname}${url.search}`.toLowerCase();

    return (
      BLOCKED_HOST_SNIPPETS.some((snippet) => host.includes(snippet)) ||
      BLOCKED_PATH_SNIPPETS.some((snippet) => path.includes(snippet))
    );
  } catch (error) {
    return false;
  }
}

browser.storage.local.get(DEFAULT_SETTINGS).then((settings) => {
  enabled = Boolean(settings.enabled);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.enabled) {
    enabled = Boolean(changes.enabled.newValue);
  }
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!enabled) {
      return {};
    }
    if (isBlockedRequest(details.url, details.type)) {
      return { cancel: true };
    }

    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

async function sendMessageToActiveTab(message) {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const [activeTab] = tabs;
  if (!activeTab?.id) {
    return null;
  }

  try {
    await browser.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    // Ignore tabs without an injected content script.
  }

  return activeTab.id;
}

browser.tabs.onRemoved.addListener((tabId) => {
  stopAllTabAudio(tabId);
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  const senderTabId = sender.tab?.id;

  if (message?.type === "CAT_ADBLOCKER_START_AUDIO") {
    if (
      typeof senderTabId === "number" &&
      typeof message.audioId === "string" &&
      message.audioId &&
      typeof message.url === "string" &&
      message.url
    ) {
      startTabAudio(senderTabId, message.audioId, message.url, {
        loop: message.loop,
        volume: message.volume
      });
    }
  }

  if (message?.type === "CAT_ADBLOCKER_STOP_AUDIO") {
    if (typeof senderTabId === "number" && typeof message.audioId === "string" && message.audioId) {
      stopTabAudio(senderTabId, message.audioId);
    }
  }

  if (message?.type === "CAT_ADBLOCKER_STOP_TAB_AUDIO") {
    if (typeof senderTabId === "number") {
      stopAllTabAudio(senderTabId);
    }
  }

  if (message?.type === "CAT_ADBLOCKER_SET_ENABLED") {
    enabled = Boolean(message.enabled);
    await browser.storage.local.set({ enabled });
    const activeTabId = await sendMessageToActiveTab({
      type: "CAT_ADBLOCKER_APPLY_ENABLED",
      enabled
    });
    if (!enabled && typeof activeTabId === "number") {
      stopAllTabAudio(activeTabId);
    }
  }

  if (message?.type === "CAT_ADBLOCKER_RESCAN") {
    await sendMessageToActiveTab({ type: "CAT_ADBLOCKER_RESCAN" });
  }

  if (message?.type === "CAT_ADBLOCKER_SET_CATEGORIES") {
    const enabledCategoryIds = Array.isArray(message.enabledCategoryIds)
      ? message.enabledCategoryIds
      : DEFAULT_SETTINGS.enabledCategoryIds;

    await browser.storage.local.set({ enabledCategoryIds });
    await sendMessageToActiveTab({
      type: "CAT_ADBLOCKER_APPLY_CATEGORIES",
      enabledCategoryIds
    });
  }
});
