const enabledInput = document.getElementById("enabled");
const rescanButton = document.getElementById("rescan");
const statusText = document.getElementById("status");
const categoriesContainer = document.getElementById("categories");
const DEFAULT_SETTINGS = {
  enabled: true,
  enabledCategoryIds: ["cat-videos"]
};
const VIDEO_INDEX_PATH = "assets/video-index.json";
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

async function loadCategories() {
  try {
    const response = await fetch(browser.runtime.getURL(VIDEO_INDEX_PATH));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    availableCategories = normalizeCategories(payload);
  } catch (error) {
    console.warn("Cat Adblocker popup failed to load categories.", error);
    availableCategories = [
      { id: "cat-videos", label: "Cat Videos" },
      { id: "memes", label: "Memes" },
      { id: "brainrot", label: "Brainrot" }
    ];
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
  statusText.textContent = enabled
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

loadCategories().then(loadState);
