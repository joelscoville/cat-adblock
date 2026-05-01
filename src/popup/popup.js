const enabledInput = document.getElementById("enabled");
const rescanButton = document.getElementById("rescan");
const statusText = document.getElementById("status");

async function loadState() {
  const { enabled = true } = await browser.storage.local.get({ enabled: true });
  enabledInput.checked = enabled;
  statusText.textContent = enabled
    ? "Active on this browser."
    : "Disabled until you toggle it back on.";
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

loadState();
