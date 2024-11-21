import browser from "webextension-polyfill";

const status = document.querySelector(".status");

document.querySelector("[name=save]").addEventListener("click", async function() {
  const token = document.querySelector("[name=token]").value;
  const gistId = document.querySelector("[name=gistId]").value;
  status.textContent = "Saving...";
  await browser.storage.local.set({
    token: token,
    gistId: gistId
  });
  status.textContent = "Options saved.";
});

document.querySelector("[name=syncNow]").addEventListener("click", async function() {
  status.textContent = "Syncing...";
  try {
    await browser.runtime.sendMessage({action: "sync"});
    status.textContent = "Synced.";
  } catch (e) {
    status.textContent = e.message;
  }
});

browser.storage.local.get(["token", "gistId"]).then(function(result) {
  document.querySelector("[name=token]").value = result.token || "";
  document.querySelector("[name=gistId]").value = result.gistId || "";
});

browser.runtime.sendMessage({action: "getSyncError"}).then(function(syncError) {
  if (syncError) {
    status.textContent = syncError;
  }
});
