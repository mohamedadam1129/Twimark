const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const exportBtn = document.getElementById("exportBtn");
const licenseKeyInput = document.getElementById("licenseKey");
const licenseEmailInput = document.getElementById("licenseEmail");
const licenseMessage = document.getElementById("licenseMessage");
const activateLicenseBtn = document.getElementById("activateLicense");
const deactivateLicenseBtn = document.getElementById("deactivateLicense");
const buyProBtn = document.getElementById("buyPro");
const authStateEl = document.getElementById("authState");
const LICENSE_STORAGE_KEY = "pro_license_v1";
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
const CHECKOUT_URL = "https://twimark.lemonsqueezy.com/checkout/buy/376668c1-9221-4df9-8345-50977db97019";
const FREE_EXPORT_LIMIT = 5;
let currentState = null;
let proEntitled = false;
let pendingExport = false;
let exporting = false;
let pendingDownload = null;

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
function openUpgrade() { setModal("transformModal", false); setModal("upgradeModal", true); }

function updateAuthUi(loggedIn, message = "") {
  if (!authStateEl) return;
  authStateEl.hidden = !loggedIn;
  authStateEl.textContent = loggedIn ? "Logged in" : message;
}

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
  if (state.threadStitching?.status === "stitching") statusEl.textContent = `Smart Thread Stitching… ${state.threadStitching.completed} of ${state.threadStitching.total} conversations checked.`;
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
    if (!quiet) {
      setLicenseMessage("Twimark Pro is active on this browser.");
      updateAuthUi(true, "Logged in");
    }
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
  const emittedThreads = new Set();
  const sections = bookmarkList.flatMap((tweet) => {
    const thread = Array.isArray(tweet.thread) && tweet.thread.length > 1 ? tweet.thread : null;
    const threadKey = tweet.threadRootId || tweet.id;
    if (emittedThreads.has(threadKey)) return [];
    emittedThreads.add(threadKey);
    if (thread) {
      const parts = thread.map((post, index) => {
        const media = post.media?.length ? `\n\n**Media:**\n${post.media.map((url) => `- ${url}`).join("\n")}` : "";
        return `### Post ${index + 1}\n\n${post.text || "Image/video-only post."}${media}\n\n**Source:** ${post.url}`;
      });
      return `## Thread by ${tweet.user} (${tweet.handle})\n\n${parts.join("\n\n")}`;
    }
    const date = tweet.date || "No date";
    const text = tweet.text || "Image/video-only bookmark.";
    const media = tweet.media?.length ? `\n\n**Media:**\n${tweet.media.map((url) => `- ${url}`).join("\n")}` : "";
    return [`## Tweet by ${tweet.user} (${tweet.handle}) — ${date}\n\n**Tweet text:**\n${text}\n\n**Source:** ${tweet.url}${media}`];
  });
  return `# Twitter Bookmark Archive\n\nExported by Twimark on ${new Date().toISOString()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n\n---\n\n*Exported via [Twimark](https://twimark.lemonsqueezy.com/) — Convert X bookmarks & threads into Second Brain sources.*\n`;
}

async function downloadMarkdown(bookmarkList) {
  const filename = `Twimark_NotebookLM_${new Date().toISOString().slice(0, 10)}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown(bookmarkList))}`;
  return chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
}

async function recordExport(ids) { await chrome.runtime.sendMessage({ action: "mark_exported", ids }); }

function displayDate(date) {
  const parsed = date ? new Date(date) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }).format(parsed) : "X History";
}

function previewMarkdown(tweet) {
  const clean = (tweet.text || "Image/video-only bookmark.").replace(/\s+/g, " ").trim();
  const phrases = clean.split(/(?<=[.!?])\s+|\s*•\s*/).filter(Boolean);
  const headline = (phrases[0] || clean).replace(/^[-•]\s*/, "").slice(0, 62);
  const bullets = phrases.slice(1, 3).map((phrase) => `- ${phrase.slice(0, 54)}`);
  return `**${headline}${headline.length === 62 ? "…" : ""}**\n\n${bullets.length ? bullets.join("\n") : clean.slice(0, 108)}\n\n_Source: X • ${displayDate(tweet.date)}_`;
}

function showTransform(selection, isPro) {
  const tweet = selection[0];
  const avatar = document.getElementById("tweetAvatar");
  avatar.replaceChildren();
  if (tweet.avatar) {
    const image = document.createElement("img");
    image.src = tweet.avatar;
    image.alt = "";
    avatar.append(image);
  } else {
    avatar.textContent = (tweet.user || "X").slice(0, 1).toUpperCase();
  }
  document.getElementById("tweetName").textContent = tweet.user || "Your saved post";
  document.getElementById("tweetMeta").textContent = `${tweet.handle || "@unknown"} · ${displayDate(tweet.date)}`;
  document.getElementById("tweetText").textContent = tweet.text || "Image/video-only bookmark.";
  document.getElementById("markdownPreview").textContent = previewMarkdown(tweet);
  document.getElementById("transformFooter").textContent = isPro ? "Full Markdown • Ready for NotebookLM" : `5 free bookmarks • ${Math.max(0, bookmarks().length - selection.length)} more in your vault`;
  setModal("transformModal", true);
}

async function exportBookmarks() {
  if (exporting || !bookmarks().length) return;
  exporting = true;
  exportBtn.disabled = true;
  exportBtn.textContent = "Preparing your export…";
  try {
    const isPro = await validateSavedLicense({ quiet: true });
    let all = bookmarks();
    if (isPro) {
      exportBtn.textContent = "Stitching thread context…";
      statusEl.textContent = "Smart Thread Stitching is checking related posts from the same author.";
      const stitched = await chrome.runtime.sendMessage({ action: "stitch_threads" });
      if (!stitched?.ok) throw new Error(stitched?.error || "Thread stitching could not start.");
      await refreshState();
      all = bookmarks();
    }
    const selection = isPro ? all : all.slice(0, FREE_EXPORT_LIMIT);
    pendingDownload = { selection, isPro };
    showTransform(selection, isPro);
    statusEl.textContent = "Preview ready. Continue when you’re ready to send it to NotebookLM.";
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
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => setModal(button.dataset.close, false)));
document.getElementById("continueNotebook").addEventListener("click", async () => {
  if (!pendingDownload) return;
  const button = document.getElementById("continueNotebook");
  button.disabled = true;
  try {
    await downloadMarkdown(pendingDownload.selection);
    if (pendingDownload.isPro) await recordExport(pendingDownload.selection.map((tweet) => tweet.id));
    await chrome.tabs.create({ url: "https://notebooklm.google.com/?utm_source=twimark" });
    statusEl.textContent = "Markdown download started. NotebookLM is open in a new tab.";
    setModal("transformModal", false);
    pendingDownload = null;
  } catch (error) {
    statusEl.textContent = `Export failed: ${error.message}`;
  } finally { button.disabled = false; }
});

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
    const isValid = await validateSavedLicense();
    if (!isValid) throw new Error("License was activated but could not be verified. Please try again.");
    updateAuthUi(true, "Logged in");
    setTimeout(() => setModal("licenseModal", false), 650);
  } catch (error) { setLicenseMessage(error.message); } finally { activateLicenseBtn.disabled = false; }
});

deactivateLicenseBtn.addEventListener("click", async () => {
  const license = await savedLicense();
  if (!license?.key || !license?.email || !license?.instanceId) return setLicenseMessage("There is no active Pro license on this browser.");
  deactivateLicenseBtn.disabled = true;
  try { await licenseRequest("/deactivate", license); await chrome.storage.local.remove(LICENSE_STORAGE_KEY); proEntitled = false; updateAuthUi(false); setLicenseMessage("This browser has been deactivated."); }
  catch (error) { setLicenseMessage(error.message); } finally { deactivateLicenseBtn.disabled = false; }
});

buyProBtn.addEventListener("click", openCheckout);
document.getElementById("upgradeBuy").addEventListener("click", openCheckout);

(async () => {
  const license = await savedLicense();
  if (license?.key) licenseKeyInput.value = license.key;
  if (license?.email) licenseEmailInput.value = license.email;
  await refreshState();
  const loggedIn = await validateSavedLicense({ quiet: true });
  updateAuthUi(loggedIn);
})();
setInterval(refreshState, 1000);
