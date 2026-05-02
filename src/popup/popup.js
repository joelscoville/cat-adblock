const enabledInput = document.getElementById("enabled");
const rescanButton = document.getElementById("rescan");
const runInterruptionButton = document.getElementById("run-interruption");
const statusText = document.getElementById("status");
const categoriesContainer = document.getElementById("categories");
const DEFAULT_SETTINGS = {
  enabled: true,
  enabledCategoryIds: ["cat-videos"]
};
const REMOTE_VIDEO_INDEX_URL = "http://localhost:3000/api/videos";
const API_UNAVAILABLE_MESSAGE = "Video API unavailable. Start `video-api` before using Cat Adblocker.";
let availableCategories = [];

function normalizeCategories(payload) {
  if (!Array.isArray(payload?.categories)) {
    return [];
  }

  return payload.categories
    .filter((category) => category && typeof category.id === "string")
    .map((category) => ({
      id: category.id,
      label: typeof category.label === "string" && category.label ? category.label : category.id
    }));
}

async function fetchVideoIndex(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function loadCategories() {
  try {
    availableCategories = normalizeCategories(await fetchVideoIndex(REMOTE_VIDEO_INDEX_URL));
  } catch (error) {
    console.warn("Cat Adblocker popup requires the local video API at http://localhost:3000/api/videos.", error);
    availableCategories = [];
  }
}

function renderCategories(selectedCategoryIds) {
  categoriesContainer.textContent = "";

  for (const category of availableCategories) {
    const option = document.createElement("label");
    option.className = "category-option";

    const text = document.createElement("span");
    text.textContent = category.label;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = category.id;
    input.checked = selectedCategoryIds.includes(category.id);
    input.addEventListener("change", updateCategories);

    option.append(text, input);
    categoriesContainer.append(option);
  }
}

async function loadState() {
  const { enabled = true, enabledCategoryIds = DEFAULT_SETTINGS.enabledCategoryIds } =
    await browser.storage.local.get(DEFAULT_SETTINGS);
  enabledInput.checked = enabled;
  renderCategories(enabledCategoryIds);
  rescanButton.disabled = availableCategories.length === 0;
  runInterruptionButton.disabled = availableCategories.length === 0;
  statusText.textContent =
    availableCategories.length === 0
      ? API_UNAVAILABLE_MESSAGE
      : enabled
        ? "Active on this browser."
        : "Disabled until you toggle it back on.";
}

async function updateCategories() {
  const selected = Array.from(categoriesContainer.querySelectorAll("input:checked"), (input) => input.value);
  const enabledCategoryIds = selected.length > 0 ? selected : [...DEFAULT_SETTINGS.enabledCategoryIds];

  await browser.runtime.sendMessage({
    type: "CAT_ADBLOCKER_SET_CATEGORIES",
    enabledCategoryIds
  });

  renderCategories(enabledCategoryIds);
  statusText.textContent =
    enabledCategoryIds.length === 1
      ? "Using 1 category."
      : `Using ${enabledCategoryIds.length} categories.`;
}

enabledInput.addEventListener("change", async () => {
  const enabled = enabledInput.checked;
  await browser.runtime.sendMessage({
    type: "CAT_ADBLOCKER_SET_ENABLED",
    enabled
  });
  statusText.textContent = enabled ? "Enabled. New ads will be replaced." : "Disabled. Restoring this tab.";
});

rescanButton.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CAT_ADBLOCKER_RESCAN" });
  statusText.textContent = "Rescanning the current tab.";
});

runInterruptionButton.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CAT_ADBLOCKER_RUN_INTERRUPTION_NOW" });
  statusText.textContent = "Starting fullscreen video on this tab.";
});

loadCategories().then(loadState);
