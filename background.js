const SCAN_KEY = "scan_state_v2";
const EXPORTED_IDS_KEY = "exported_tweet_ids_v2";
const PRO_LICENSE_KEY = "pro_license_v1";
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
const LICENSE_API_BASE = "https://twimark-license-gateway.twimarkworker.workers.dev";
const THREAD_STITCH_DELAY_MS = 450;
const THREAD_TAB_TIMEOUT_MS = 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTabComplete(tabId) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === "complete") return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error("X conversation page timed out.")); }, THREAD_TAB_TIMEOUT_MS);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") { cleanup(); resolve(); }
    };
    const cleanup = () => { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function extractThreadForBookmark(bookmark) {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: bookmark.url, active: false });
    await waitForTabComplete(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const result = await chrome.tabs.sendMessage(tab.id, { action: "extract_thread", targetId: bookmark.id });
    return result?.ok ? result.posts || [] : [];
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function stitchThreads() {
  const scan = await getScanState();
  if (!scan || scan.status !== "ready") return { ok: false, error: "Complete a bookmark scan before stitching threads." };
  if (scan.threadStitching?.status === "stitching") return { ok: false, error: "Thread stitching is already running." };

  const bookmarks = Object.values(scan.bookmarks).filter((bookmark) => !bookmark.threadStitchingAttempted);
  if (!bookmarks.length) return { ok: true, stitched: scan.threadStitching?.stitched || 0, total: 0 };
  scan.threadStitching = { status: "stitching", total: bookmarks.length, completed: 0, stitched: 0 };
  await setScanState(scan);

  for (const bookmark of bookmarks) {
    try {
      const posts = await extractThreadForBookmark(bookmark);
      if (posts.length > 1) {
        scan.bookmarks[bookmark.id].thread = posts;
        scan.bookmarks[bookmark.id].threadRootId = posts[0].id;
        scan.threadStitching.stitched += 1;
      }
    } catch (error) {
      console.warn("Twimark could not stitch thread", bookmark.id, error);
    }
    scan.bookmarks[bookmark.id].threadStitchingAttempted = true;
    scan.threadStitching.completed += 1;
    await setScanState(scan);
    await sleep(THREAD_STITCH_DELAY_MS);
  }
  scan.threadStitching.status = "ready";
  await setScanState(scan);
  return { ok: true, stitched: scan.threadStitching.stitched, total: bookmarks.length };
}

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
      case "stitch_threads":
        sendResponse(await stitchThreads());
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
