const statusEl = document.getElementById("status");
const countEl = document.getElementById("count");
const fullExportBtn = document.getElementById("fullExport");
const smartSyncBtn = document.getElementById("smartSync");
const csvBtn = document.getElementById("downloadCsv");
const markdownBtn = document.getElementById("downloadMarkdown");

let currentState = null;

function isBookmarksPage(url) {
  return /(^https:\/\/)(x\.com|twitter\.com)\/i\/bookmarks/.test(url || "");
}

function bookmarks() {
  return Object.values(currentState?.bookmarks || {});
}

function setExportEnabled(enabled) {
  csvBtn.disabled = !enabled;
  markdownBtn.disabled = !enabled;
}

function renderState(state) {
  currentState = state;
  const count = bookmarks().length;
  countEl.textContent = count;
  setExportEnabled(state?.status === "ready" && count > 0);
  if (!state) return;
  if (state.status === "scanning") statusEl.textContent = `Scanning safely in the background… ${count} bookmarks found. You may close this popup.`;
  if (state.status === "ready") statusEl.textContent = count ? `Scan complete: ${count} bookmarks ready to export.` : "Scan complete, but no exportable bookmarks were found.";
  if (state.status === "error") statusEl.textContent = `Scan failed: ${state.error || "Unknown error"}`;
}

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ action: "get_scan_state" });
  if (response?.ok) renderState(response.state);
}

async function startScan(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!isBookmarksPage(tab?.url)) {
    statusEl.textContent = "Open your X bookmarks page first.";
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
  try {
    const filename = `Twimark_NotebookLM_${new Date().toISOString().slice(0, 10)}.md`;
    await download(filename, "text/markdown", markdown(bookmarks()));
    await recordExport();
    statusEl.textContent = "Markdown download started. Opening NotebookLM…";
    await chrome.tabs.create({ url: "https://notebooklm.google.com/" });
  } catch (error) { statusEl.textContent = `Markdown download failed: ${error.message}`; }
});

fullExportBtn.addEventListener("click", () => startScan("full_export").catch((error) => { statusEl.textContent = error.message; fullExportBtn.disabled = smartSyncBtn.disabled = false; }));
smartSyncBtn.addEventListener("click", () => startScan("smart_sync").catch((error) => { statusEl.textContent = error.message; fullExportBtn.disabled = smartSyncBtn.disabled = false; }));

refreshState();
setInterval(refreshState, 1000);
