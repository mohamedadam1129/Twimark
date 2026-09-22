const SCAN_KEY = "scan_state_v2";
const EXPORTED_IDS_KEY = "exported_tweet_ids_v2";
const PRO_LICENSE_KEY = "pro_license_v1";
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
const LICENSE_API_BASE = "https://twimark-license-gateway.twimarkworker.workers.dev";

async function installationId() {
  const result = await chrome.storage.local.get(INSTALLATION_STORAGE_KEY);
  if (result[INSTALLATION_STORAGE_KEY]) return result[INSTALLATION_STORAGE_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALLATION_STORAGE_KEY]: id });
  return id;
}

async function activatePurchasedLicense(licenseKey, email) {
  if (typeof licenseKey !== "string" || typeof email !== "string" || !licenseKey.trim() || !email.trim()) {
    return { ok: false, error: "The purchase link is missing a license key or email." };
  }
  const response = await fetch(`${LICENSE_API_BASE}/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licenseKey: licenseKey.trim(),
      email: email.trim(),
      installationId: await installationId()
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok || !data.instanceId) {
    return { ok: false, error: data.error || "Could not activate this purchase." };
  }
  await chrome.storage.local.set({ [PRO_LICENSE_KEY]: { key: licenseKey.trim(), email: email.trim(), instanceId: data.instanceId } });
  return { ok: true };
}

function emptyScan(mode) {
  return {
    mode,
    status: "scanning",
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    bookmarks: {}
  };
}

async function getScanState() {
  const result = await chrome.storage.local.get(SCAN_KEY);
  return result[SCAN_KEY] || null;
}

async function setScanState(state) {
  await chrome.storage.local.set({ [SCAN_KEY]: state });
}

async function initializeScan(mode) {
  const existing = await getScanState();
  if (existing?.status === "scanning") {
    return { ok: false, error: "A scan is already in progress. Reopen the popup to monitor it." };
  }
  const scan = emptyScan(mode);
  await setScanState(scan);
  return { ok: true, state: scan };
}

async function recordBookmarks(bookmarks) {
  const scan = await getScanState();
  if (!scan || scan.status !== "scanning") return { ok: false, error: "No active scan." };

  const exported = await chrome.storage.local.get(EXPORTED_IDS_KEY);
  const exportedIds = new Set(exported[EXPORTED_IDS_KEY] || []);
  let accepted = 0;

  for (const bookmark of bookmarks) {
    if (!bookmark?.id) continue;
    if (scan.mode === "smart_sync" && exportedIds.has(bookmark.id)) continue;
    if (!scan.bookmarks[bookmark.id]) accepted += 1;
    scan.bookmarks[bookmark.id] = bookmark;
  }

  await setScanState(scan);
  return { ok: true, accepted, total: Object.keys(scan.bookmarks).length };
}

async function completeScan(error = null) {
  const scan = await getScanState();
  if (!scan) return { ok: false, error: "No scan to complete." };
  scan.status = error ? "error" : "ready";
  scan.error = error;
  scan.completedAt = new Date().toISOString();
  await setScanState(scan);
  return { ok: true, total: Object.keys(scan.bookmarks).length };
}

async function markExported(ids) {
  const result = await chrome.storage.local.get(EXPORTED_IDS_KEY);
  const merged = new Set([...(result[EXPORTED_IDS_KEY] || []), ...ids]);
  await chrome.storage.local.set({ [EXPORTED_IDS_KEY]: [...merged] });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    switch (request.action) {
      case "initialize_scan":
        sendResponse(await initializeScan(request.mode));
        break;
      case "record_bookmarks":
        sendResponse(await recordBookmarks(request.bookmarks || []));
        break;
      case "complete_scan":
        sendResponse(await completeScan(request.error || null));
        break;
      case "get_scan_state":
        sendResponse({ ok: true, state: await getScanState() });
        break;
      case "mark_exported":
        sendResponse(await markExported(request.ids || []));
        break;
      default:
        sendResponse({ ok: false, error: "Unknown action." });
    }
  })().catch((error) => {
    console.error("Twimark background error", error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  if (request?.action !== "activate_purchase" || !sender.url?.startsWith(`${LICENSE_API_BASE}/activate`)) {
    sendResponse({ ok: false, error: "Untrusted activation request." });
    return;
  }
  activatePurchasedLicense(request.licenseKey, request.email)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
