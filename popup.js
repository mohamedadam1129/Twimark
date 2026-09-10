const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const fullExportBtn = document.getElementById("fullExport");
const smartSyncBtn = document.getElementById("smartSync");
const csvBtn = document.getElementById("downloadCsv");
const markdownBtn = document.getElementById("downloadMarkdown");
const licenseKeyInput = document.getElementById("licenseKey");
const licenseEmailInput = document.getElementById("licenseEmail");
const licenseMessage = document.getElementById("licenseMessage");
const activateLicenseBtn = document.getElementById("activateLicense");
const deactivateLicenseBtn = document.getElementById("deactivateLicense");
const buyProBtn = document.getElementById("buyPro");

const LICENSE_STORAGE_KEY = "pro_license_v1";
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
let currentState = null;
let proEntitled = false;

function isBookmarkHistoryPage(url) {
  try {
    const parsed = new URL(url);
    if (!/^(x\.com|twitter\.com)$/.test(parsed.hostname)) return false;
    if (parsed.pathname === "/i/bookmarks") return true;
    if (parsed.pathname === "/i/history" || parsed.pathname === "/i/history/") return true;
    // X History contains non-bookmark tabs. Do not accidentally export Likes,
    // Videos, or Articles as if they were user-saved bookmarks.
    return /^\/i\/history\/bookmarks(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function bookmarks() {
  return Object.values(currentState?.bookmarks || {});
}

function releaseConfigured() {
  return typeof TWIMARK_LICENSE_API_BASE === "string" && /^https:\/\//.test(TWIMARK_LICENSE_API_BASE);
}

function setLicenseMessage(message) {
  licenseMessage.textContent = message;
}

function renderExportAvailability() {
  const scanReady = currentState?.status === "ready" && bookmarks().length > 0;
  csvBtn.disabled = !scanReady;
  markdownBtn.disabled = !scanReady || !proEntitled;
}

function renderState(state) {
  currentState = state;
  const count = bookmarks().length;
  countEl.textContent = count;
  renderExportAvailability();
  if (!state) return;
  if (state.status === "scanning") statusEl.textContent = `Scanning safely in the background… ${count} bookmarks found. You may close this popup.`;
  if (state.status === "ready") statusEl.textContent = count ? `Scan complete: ${count} bookmarks ready to export.` : "Scan complete, but no exportable bookmarks were found.";
  if (state.status === "error") statusEl.textContent = `Scan failed: ${state.error || "Unknown error"}`;
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ action: "get_scan_state" });
  if (response?.ok) renderState(response.state);
}

async function installationId() {
  const stored = await chrome.storage.local.get(INSTALLATION_STORAGE_KEY);
  if (stored[INSTALLATION_STORAGE_KEY]) return stored[INSTALLATION_STORAGE_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALLATION_STORAGE_KEY]: id });
  return id;
}

async function savedLicense() {
  const stored = await chrome.storage.local.get([LICENSE_STORAGE_KEY, "license_key"]);
  return stored[LICENSE_STORAGE_KEY] || (stored.license_key ? { key: stored.license_key, email: "", instanceId: "" } : null);
}

async function licenseRequest(path, license) {
  if (!releaseConfigured()) throw new Error("Pro licensing is not configured in this build.");
  const response = await fetch(`${TWIMARK_LICENSE_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ licenseKey: license.key, email: license.email, instanceId: license.instanceId, installationId: await installationId() })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "License verification failed.");
  return data;
}

async function validateSavedLicense({ quiet = false } = {}) {
  const license = await savedLicense();
  proEntitled = false;
  if (!license?.key || !license?.email || !license?.instanceId) {
    renderExportAvailability();
    if (!quiet) setLicenseMessage("Enter your lifetime license key and checkout email to unlock NotebookLM export.");
    return false;
  }
  try {
    await licenseRequest("/validate", license);
    proEntitled = true;
    setLicenseMessage("Twimark Pro is active on this browser.");
    renderExportAvailability();
    return true;
  } catch (error) {
    renderExportAvailability();
    if (!quiet) setLicenseMessage(error.message);
    return false;
  }
}

async function startScan(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isBookmarkHistoryPage(tab?.url)) {
    statusEl.textContent = "Open X History and select the Bookmarks tab first.";
    return;
  }
  fullExportBtn.disabled = smartSyncBtn.disabled = true;
  statusEl.textContent = "Starting scan…";
  const initialized = await chrome.runtime.sendMessage({ action: "initialize_scan", mode });
  if (!initialized?.ok) throw new Error(initialized?.error || "Could not start scan.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const started = await chrome.tabs.sendMessage(tab.id, { action: "start_scan" });
  if (!started?.ok) throw new Error(started?.error || "Could not start scanner.");
  await refreshState();
}

function csvEscape(value) {
  return `"${String(value || "").replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
}

function markdown(bookmarkList) {
  const sections = bookmarkList.map((tweet) => {
    const date = tweet.date || "No date";
    const text = tweet.text || "Image/video-only bookmark.";
    const media = tweet.media?.length ? `\n\n**Media:**\n${tweet.media.map((url) => `- ${url}`).join("\n")}` : "";
    return `## Tweet by ${tweet.user} (${tweet.handle}) — ${date}\n\n**Tweet text:**\n${text}\n\n**Source:** ${tweet.url}${media}`;
  });
  return `# Twitter Bookmark Archive\n\nExported by Twimark on ${new Date().toISOString()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

async function download(filename, mime, content) {
  const url = `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  return chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
}

async function recordExport() {
  await chrome.runtime.sendMessage({ action: "mark_exported", ids: bookmarks().map((tweet) => tweet.id) });
}

csvBtn.addEventListener("click", async () => {
  try {
    const content = ["User,Handle,Date,Text,Media,URL", ...bookmarks().map((tweet) => [tweet.user, tweet.handle, tweet.date, tweet.text, (tweet.media || []).join(" "), tweet.url].map(csvEscape).join(","))].join("\n");
    await download("twimark_bookmarks.csv", "text/csv", `\uFEFF${content}`);
    await recordExport();
    statusEl.textContent = "CSV download started.";
  } catch (error) { statusEl.textContent = `CSV download failed: ${error.message}`; }
});

markdownBtn.addEventListener("click", async () => {
  if (!await validateSavedLicense()) return;
  try {
    const filename = `Twimark_NotebookLM_${new Date().toISOString().slice(0, 10)}.md`;
    await download(filename, "text/markdown", markdown(bookmarks()));
    await recordExport();
    statusEl.textContent = "Markdown download started. Opening NotebookLM…";
    await chrome.tabs.create({ url: "https://notebooklm.google.com/" });
  } catch (error) { statusEl.textContent = `Markdown download failed: ${error.message}`; }
});

activateLicenseBtn.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  const email = licenseEmailInput.value.trim();
  if (!key || !email) return setLicenseMessage("Enter both the license key and checkout email.");
  activateLicenseBtn.disabled = true;
  try {
    const license = { key, email, instanceId: "" };
    const data = await licenseRequest("/activate", license);
    if (!data.instanceId) throw new Error("Activation did not return a device instance.");
    license.instanceId = data.instanceId;
    await chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: license });
    await validateSavedLicense();
  } catch (error) { setLicenseMessage(error.message); }
  finally { activateLicenseBtn.disabled = false; }
});

deactivateLicenseBtn.addEventListener("click", async () => {
  const license = await savedLicense();
  if (!license?.key || !license?.email || !license?.instanceId) return setLicenseMessage("There is no active Pro license on this browser.");
  deactivateLicenseBtn.disabled = true;
  try {
    await licenseRequest("/deactivate", license);
    await chrome.storage.local.remove(LICENSE_STORAGE_KEY);
    proEntitled = false;
    renderExportAvailability();
    setLicenseMessage("This browser has been deactivated.");
  } catch (error) { setLicenseMessage(error.message); }
  finally { deactivateLicenseBtn.disabled = false; }
});

buyProBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: "https://twimark.lemonsqueezy.com/checkout/buy/376668c1-9221-4df9-8345-50977db97019"
  });
});

fullExportBtn.addEventListener("click", () => startScan("full_export").catch((error) => { statusEl.textContent = error.message; fullExportBtn.disabled = smartSyncBtn.disabled = false; }));
smartSyncBtn.addEventListener("click", () => startScan("smart_sync").catch((error) => { statusEl.textContent = error.message; fullExportBtn.disabled = smartSyncBtn.disabled = false; }));

(async () => {
  const license = await savedLicense();
  if (license?.key) licenseKeyInput.value = license.key;
  if (license?.email) licenseEmailInput.value = license.email;
  await refreshState();
  await validateSavedLicense({ quiet: true });
})();
setInterval(refreshState, 1000);
