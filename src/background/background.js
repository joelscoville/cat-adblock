const DEFAULT_SETTINGS = {
  enabled: true
};
let enabled = DEFAULT_SETTINGS.enabled;

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
  if (areaName === "local" && changes.enabled) {
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
    return;
  }

  try {
    await browser.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    // Ignore tabs without an injected content script.
  }
}

browser.runtime.onMessage.addListener(async (message) => {
  if (message?.type === "CAT_ADBLOCKER_SET_ENABLED") {
    enabled = Boolean(message.enabled);
    await browser.storage.local.set({ enabled });
    await sendMessageToActiveTab({
      type: "CAT_ADBLOCKER_APPLY_ENABLED",
      enabled
    });
  }

  if (message?.type === "CAT_ADBLOCKER_RESCAN") {
    await sendMessageToActiveTab({ type: "CAT_ADBLOCKER_RESCAN" });
  }
});
