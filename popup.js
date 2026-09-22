const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const exportBtn = document.getElementById("exportBtn");
const licenseKeyInput = document.getElementById("licenseKey");
const licenseEmailInput = document.getElementById("licenseEmail");
const licenseMessage = document.getElementById("licenseMessage");
const activateLicenseBtn = document.getElementById("activateLicense");
const deactivateLicenseBtn = document.getElementById("deactivateLicense");
const buyProBtn = document.getElementById("buyPro");
const LICENSE_STORAGE_KEY = "pro_license_v1";
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
const CHECKOUT_URL = "https://twimark.lemonsqueezy.com/checkout/buy/376668c1-9221-4df9-8345-50977db97019";
const FREE_EXPORT_LIMIT = 5;
let currentState = null;
let proEntitled = false;
let pendingExport = false;
let exporting = false;

function isBookmarkHistoryPage(url) {
  try {
    const parsed = new URL(url);
    if (!/^(x\.com|twitter\.com)$/.test(parsed.hostname)) return false;
    return parsed.pathname === "/i/bookmarks" || parsed.pathname === "/i/history" || parsed.pathname === "/i/history/" || /^\/i\/history\/bookmarks(?:\/|$)/.test(parsed.pathname);
  } catch { return false; }
}

function bookmarks() { return Object.values(currentState?.bookmarks || {}); }
function releaseConfigured() { return typeof TWIMARK_LICENSE_API_BASE === "string" && /^https:\/\//.test(TWIMARK_LICENSE_API_BASE); }
function setLicenseMessage(message) { licenseMessage.textContent = message; }
function setModal(id, open) { document.getElementById(id).hidden = !open; }
function openUpgrade() { setModal("successModal", false); setModal("upgradeModal", true); }

function renderState(state) {
  currentState = state;
  const count = bookmarks().length;
  countEl.textContent = count;
  if (!state) return;
  if (state.status === "scanning") {
    exportBtn.disabled = true;
    exportBtn.textContent = `Scanning bookmarks… ${count}`;
    statusEl.textContent = "Scanning safely in the background. You can close this popup and return when it is complete.";
  } else {
    exportBtn.disabled = false;
    exportBtn.textContent = "Export to NotebookLM";
  }
  if (state.status === "ready") statusEl.textContent = count ? `${count} bookmarks are ready. Your first ${Math.min(FREE_EXPORT_LIMIT, count)} are free.` : "No exportable bookmarks were found. Make sure you selected X History’s Bookmarks tab.";
  if (state.status === "error") statusEl.textContent = `Scan failed: ${state.error || "Unknown error"}`;
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ action: "get_scan_state" });
  if (!response?.ok) return;
  renderState(response.state);
  if (pendingExport && response.state?.status === "ready" && bookmarks().length && !exporting) {
    pendingExport = false;
    await exportBookmarks();
  }
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
    method: "POST", headers: { "Content-Type": "application/json" },
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
    if (!quiet) setLicenseMessage("Enter the license key and email from your receipt.");
    return false;
  }
  try {
    await licenseRequest("/validate", license);
    proEntitled = true;
    if (!quiet) setLicenseMessage("Twimark Pro is active on this browser.");
    return true;
  } catch (error) {
    if (!quiet) setLicenseMessage(error.message);
    return false;
  }
}

async function startScan(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isBookmarkHistoryPage(tab?.url)) throw new Error("Open X History and select the Bookmarks tab first.");
  exportBtn.disabled = true;
  exportBtn.textContent = "Starting scan…";
  const initialized = await chrome.runtime.sendMessage({ action: "initialize_scan", mode });
  if (!initialized?.ok) throw new Error(initialized?.error || "Could not start scan.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const started = await chrome.tabs.sendMessage(tab.id, { action: "start_scan" });
  if (!started?.ok) throw new Error(started?.error || "Could not start scanner.");
  await refreshState();
}

function markdown(bookmarkList) {
  const sections = bookmarkList.map((tweet) => {
    const date = tweet.date || "No date";
    const text = tweet.text || "Image/video-only bookmark.";
    const media = tweet.media?.length ? `\n\n**Media:**\n${tweet.media.map((url) => `- ${url}`).join("\n")}` : "";
    return `## Tweet by ${tweet.user} (${tweet.handle}) — ${date}\n\n**Tweet text:**\n${text}\n\n**Source:** ${tweet.url}${media}`;
  });
  return `# Twitter Bookmark Archive\n\nExported by Twimark on ${new Date().toISOString()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n\n---\n\n*Exported via [Twimark](https://twimark.lemonsqueezy.com/) — Convert X bookmarks & threads into Second Brain sources.*\n`;
}

async function downloadMarkdown(bookmarkList) {
  const filename = `Twimark_NotebookLM_${new Date().toISOString().slice(0, 10)}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown(bookmarkList))}`;
  return chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
}

async function recordExport(ids) { await chrome.runtime.sendMessage({ action: "mark_exported", ids }); }

function showSuccess(exportedCount, totalCount, isPro) {
  document.getElementById("successTitle").textContent = isPro ? `Exported all ${exportedCount} bookmarks! 🎉` : `Exported ${exportedCount} bookmarks to Markdown! 🎉`;
  document.getElementById("successCopy").textContent = "Your Markdown file has downloaded. Add it to NotebookLM to create an Audio Overview, study notes, or a searchable second brain.";
  const remaining = Math.max(0, totalCount - exportedCount);
  document.getElementById("vaultHook").textContent = remaining ? `Want the rest? You have ${remaining} bookmarks left in your vault.` : "Your full bookmark vault is now ready for NotebookLM.";
  document.getElementById("successUpgrade").hidden = isPro;
  setModal("successModal", true);
}

async function exportBookmarks() {
  if (exporting || !bookmarks().length) return;
  exporting = true;
  exportBtn.disabled = true;
  exportBtn.textContent = "Preparing your export…";
  try {
    const isPro = await validateSavedLicense({ quiet: true });
    const all = bookmarks();
    const selection = isPro ? all : all.slice(0, FREE_EXPORT_LIMIT);
    await downloadMarkdown(selection);
    if (isPro) await recordExport(selection.map((tweet) => tweet.id));
    showSuccess(selection.length, all.length, isPro);
    statusEl.textContent = isPro ? "Your full library export has downloaded." : "Your free Markdown sample has downloaded.";
  } catch (error) {
    statusEl.textContent = `Export failed: ${error.message}`;
  } finally {
    exporting = false;
    exportBtn.disabled = false;
    exportBtn.textContent = "Export to NotebookLM";
  }
}

function purchaseUrl() {
  return `${CHECKOUT_URL}?checkout[custom][twimark_installation_id]=${encodeURIComponent(crypto.randomUUID())}`;
}

function openCheckout() { chrome.tabs.create({ url: purchaseUrl() }); }

exportBtn.addEventListener("click", async () => {
  try {
    if (currentState?.status === "ready" && bookmarks().length) await exportBookmarks();
    else {
      const isPro = await validateSavedLicense({ quiet: true });
      const exported = await chrome.storage.local.get("exported_tweet_ids_v2");
      const mode = isPro && exported.exported_tweet_ids_v2?.length ? "smart_sync" : "full_export";
      pendingExport = true;
      await startScan(mode);
    }
  } catch (error) { pendingExport = false; statusEl.textContent = error.message; exportBtn.disabled = false; exportBtn.textContent = "Export to NotebookLM"; }
});

document.getElementById("openLicense").addEventListener("click", () => setModal("licenseModal", true));
document.getElementById("openUpgrade").addEventListener("click", openUpgrade);
document.getElementById("successUpgrade").addEventListener("click", openUpgrade);
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => setModal(button.dataset.close, false)));
document.getElementById("notebookLink").addEventListener("click", (event) => { event.preventDefault(); chrome.tabs.create({ url: event.currentTarget.href }); });

activateLicenseBtn.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim(); const email = licenseEmailInput.value.trim();
  if (!key || !email) return setLicenseMessage("Enter both the license key and checkout email.");
  activateLicenseBtn.disabled = true;
  try {
    const license = { key, email, instanceId: "" };
    const data = await licenseRequest("/activate", license);
    if (!data.instanceId) throw new Error("Activation did not return a device instance.");
    license.instanceId = data.instanceId;
    await chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: license });
    await validateSavedLicense();
    setTimeout(() => setModal("licenseModal", false), 650);
  } catch (error) { setLicenseMessage(error.message); } finally { activateLicenseBtn.disabled = false; }
});

deactivateLicenseBtn.addEventListener("click", async () => {
  const license = await savedLicense();
  if (!license?.key || !license?.email || !license?.instanceId) return setLicenseMessage("There is no active Pro license on this browser.");
  deactivateLicenseBtn.disabled = true;
  try { await licenseRequest("/deactivate", license); await chrome.storage.local.remove(LICENSE_STORAGE_KEY); proEntitled = false; setLicenseMessage("This browser has been deactivated."); }
  catch (error) { setLicenseMessage(error.message); } finally { deactivateLicenseBtn.disabled = false; }
});

buyProBtn.addEventListener("click", openCheckout);
document.getElementById("upgradeBuy").addEventListener("click", openCheckout);

(async () => {
  const license = await savedLicense();
  if (license?.key) licenseKeyInput.value = license.key;
  if (license?.email) licenseEmailInput.value = license.email;
  await refreshState();
  await validateSavedLicense({ quiet: true });
})();
setInterval(refreshState, 1000);
