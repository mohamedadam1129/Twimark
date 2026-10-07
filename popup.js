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
const openLicenseBtn = document.getElementById("openLicense");
const paymentBannerEl = document.getElementById("paymentBanner");
const LOGGED_IN_LABEL = "Pro is active ✓";
const LICENSE_STORAGE_KEY = "twimark_entitlement_v1";
const LEGACY_LICENSE_KEY = "pro_license_v1"; // pre-2.7 lifetime keys
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
const ENTITLEMENT_REFRESH_MS = 15 * 60 * 1000;
const FREE_EXPORT_LIMIT = 5;
let currentState = null;
let proEntitled = false;
let proTier = "free";            // free | pro_monthly | pro_annual | pro_lifetime
let proState = "unpaid";         // active | grace | paused | trial | suspended | unpaid | lifetime
let graceUntilMs = null;
let portalUrl = null;
let legacyLicense = null;        // legacy license-key record, if present
let entitlementFetchedAt = 0;
let validating = false;
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

// --- pricing table (monthly / annual / lifetime) ----------------------------

function planCards() {
  const list = typeof TWIMARK_PLANS === "array" ? TWIMARK_PLANS : [TWIMARK_PLANS];
  const modal = document.getElementById("upgradeModal");
  const target = modal?.querySelector(".pricing");
  if (!target) return;
  target.replaceChildren(
    ...list.map((plan) => {
      const section = document.createElement("section");
      section.className = `plan${plan.badge ? " anchor" : ""}`;
      if (plan.badge) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = plan.badge;
        section.append(badge);
      }
      const heading = document.createElement("h3");
      heading.textContent = plan.title;
      section.append(heading);
      const price = document.createElement("p");
      price.className = "price";
      const amount = document.createElement("span");
      amount.textContent = plan.price;
      const per = document.createElement("small");
      per.textContent = plan.per;
      price.append(amount, per);
      section.append(price);
      if (plan.billed) {
        const billed = document.createElement("p");
        billed.className = "billed";
        billed.textContent = plan.billed;
        section.append(billed);
      }
      const callout = document.createElement("p");
      callout.className = "callout";
      callout.textContent = plan.callout;
      section.append(callout);
      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "buy";
      buy.dataset.checkout = plan.checkoutUrl;
      buy.dataset.plan = plan.id;
      buy.textContent = plan.badge ? "Get started" : "Continue";
      buy.addEventListener("click", (event) => {
        event.preventDefault();
        openCheckout(event.currentTarget.dataset.checkout, event.currentTarget.dataset.plan);
      });
      section.append(buy);
      return section;
    })
  );
}

function updateAuthUi(loggedIn, message = "") {
  if (openLicenseBtn) {
    openLicenseBtn.classList.toggle("logged-in", loggedIn);
    openLicenseBtn.innerHTML = loggedIn ? LOGGED_IN_LABEL : "Log in for Pro";
    openLicenseBtn.title = loggedIn ? `Twimark Pro is active on this browser (${proState})` : "";
  }
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
  renderPaymentBanner();
}

function renderPaymentBanner() {
  if (!paymentBannerEl) return;
  const show = proEntitled && proState === "grace" && graceUntilMs && graceUntilMs > Date.now();
  if (!show) {
    paymentBannerEl.hidden = true;
    return;
  }
  const hoursLeft = Math.max(1, Math.ceil((graceUntilMs - Date.now()) / 3_600_000));
  paymentBannerEl.hidden = false;
  paymentBannerEl.innerHTML = "";
  const text = document.createElement("p");
  text.innerHTML = `<strong>Payment issue.</strong> Pro stays on for ~${hoursLeft}h. Update your card to keep full access.</p>`;
  const action = document.createElement("a");
  action.href = portalUrl || "https://twimark.lemonsqueezy.com/billing";
  action.target = "_blank";
  action.rel = "noopener";
  action.className = "banner-button";
  action.textContent = "Fix payment in the customer portal →";
  action.addEventListener("click", (event) => { event.preventDefault(); chrome.tabs.create({ url: portalUrl || "https://twimark.lemonsqueezy.com/billing" }); });
  paymentBannerEl.append(text, action);
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

async function refreshEntitlement({ quiet = false, force = false } = {}) {
  if (!releaseConfigured()) return false;
  if (validating) return proEntitled;
  const cached = await chrome.storage.local.get(LICENSE_STORAGE_KEY);
  const cachedEntitlement = cached[LICENSE_STORAGE_KEY];
  const cacheFresh = cachedEntitlement?.fetchedAt && Date.now() - cachedEntitlement.fetchedAt < ENTITLEMENT_REFRESH_MS;
  if (!force && cacheFresh && cachedEntitlement) {
    applyEntitlement(cachedEntitlement);
    return proEntitled;
  }
  validating = true;
  try {
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cachedEntitlement?.email || "", installationId: await installationId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (typeof data?.ok !== "boolean") throw new Error(data.error || "Entitlement verification failed.");
    if (data.claimed === false) {
      // Not yet activated on this device: try to claim an emailed purchase.
      const activated = await activateStoredRecord({ quiet: true });
      if (activated?.claimed) {
        await refreshEntitlement({ quiet, force: true });
        return proEntitled;
      }
      if (legacyLicense?.key && typeof LegacyBridge === "undefined") {
        // kick a legacy re-claim through background if a legacy key is still stored
        await activateLegacyLicense(legacyLicense.key, legacyLicense.email, { quiet: true });
      }
      applyEntitlement({ email: cachedEntitlement?.email || "", pro: false, tier: "free", state: data.state || "no_purchase_found", fetchedAt: Date.now() });
      return false;
    }
    applyEntitlement({ ...data, email: cachedEntitlement?.email || "", fetchedAt: Date.now() });
    chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: { ...data, email: cachedEntitlement?.email || "", fetchedAt: Date.now() } });
    if (!quiet) setLicenseMessage(data.pro ? "Twimark Pro is active on this browser." : "No active Pro purchase found on this browser.");
    return data.pro;
  } catch (error) {
    if (!quiet) setLicenseMessage(error.message);
    return proEntitled;
  } finally {
    validating = false;
  }
}

function applyEntitlement(ent) {
  proEntitled = Boolean(ent.pro);
  proTier = ent.tier || "free";
  proState = ent.state || "unpaid";
  graceUntilMs = ent.graceUntilMs || null;
  portalUrl = ent.portalUrl || null;
  updateAuthUi(proEntitled);
  renderPaymentBanner();
}

async function activateStoredRecord({ quiet = false } = {}) {
  const stored = await chrome.storage.local.get([LICENSE_STORAGE_KEY, LEGACY_LICENSE_KEY]);
  const email = stored[LICENSE_STORAGE_KEY]?.email || stored[LEGACY_LICENSE_KEY]?.email || "";
  if (!releaseConfigured() || !email) return null;
  try {
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, installationId: await installationId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) {
      if (!quiet) setLicenseMessage(data.error || "Could not activate Twimark Pro for this email.");
      return null;
    }
    if (!data.claimed) return { claimed: false };
    const entitlement = { ...data, email, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: entitlement });
    applyEntitlement(entitlement);
    return { claimed: true };
  } catch (error) {
    if (!quiet) setLicenseMessage(error.message);
    return null;
  }
}

async function activateLegacyLicense(licenseKey, email, { quiet = false } = {}) {
  if (!releaseConfigured()) return null;
  try {
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey, email, installationId: await installationId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.ok || !data?.claimed) {
      if (!quiet) setLicenseMessage(data.error || "This Twimark Pro license could not be verified.");
      return null;
    }
    const entitlement = { ...data, email, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [LICENSE_STORAGE_KEY]: entitlement });
    applyEntitlement(entitlement);
    // keep the legacy credential only as recovery info; entitlement is now server-side
    await chrome.storage.local.set({ [LEGACY_LICENSE_KEY]: { key: licenseKey, email, instanceId: "" } });
    if (!quiet) setLicenseMessage("Twimark Pro is active on this browser.");
    return { claimed: true };
  } catch (error) {
    if (!quiet) setLicenseMessage(error.message);
    return null;
  }
}

async function savedLicense() {
  const stored = await chrome.storage.local.get([LICENSE_STORAGE_KEY, LEGACY_LICENSE_KEY]);
  legacyLicense = stored[LEGACY_LICENSE_KEY] || null;
  return stored[LICENSE_STORAGE_KEY]?.email || legacyLicense?.email || "";
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
    return [`## Tweet by ${tweet.user} (${tweet.handle}) — ${date}\n\n**Source:** ${tweet.url}${media}`];
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
    const isPro = await refreshEntitlement({ quiet: true });
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

function purchaseUrl(baseUrl, planId) {
  const params = new URLSearchParams();
  params.set("checkout[custom][twimark_installation_id]", await_installation_for_url());
  params.set("checkout[custom][twimark_plan]", planId);
  const email = licenseEmailInput?.value?.trim();
  if (email) params.set("checkout[prefill][email]", email);
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${params}`;
}

function openCheckout(baseUrl, planId = "lifetime") {
  chrome.tabs.create({ url: purchaseUrl(baseUrl, planId) });
}

exportBtn.addEventListener("click", async () => {
  try {
    if (currentState?.status === "ready" && bookmarks().length) await exportBookmarks();
    else {
      const isPro = await refreshEntitlement({ quiet: true });
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
  const key = licenseKeyInput.value.trim();
  const email = licenseEmailInput.value.trim();
  if (!email) return setLicenseMessage("Enter the checkout email for your purchase.");
  activateLicenseBtn.disabled = true;
  try {
    if (key) {
      // legacy key path — the gateway converts it into an account entitlement
      const result = await activateLegacyLicense(key, email);
      if (!result?.claimed) throw new Error("Activation failed. Check the license key and email.");
    } else {
      const result = await activateStoredRecord();
      if (!result?.claimed) throw new Error("No Pro purchase found for this email yet. Complete a purchase or enter a license key.");
    }
    setTimeout(() => setModal("licenseModal", false), 650);
  } catch (error) { setLicenseMessage(error.message); } finally { activateLicenseBtn.disabled = false; }
});

deactivateLicenseBtn.addEventListener("click", async () => {
  deactivateLicenseBtn.disabled = true;
  try {
    const email = await savedLicense();
    if (!email) return setLicenseMessage("There is no active Pro license on this browser.");
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/deactivate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, installationId: await installationId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data.error || "Could not deactivate this device.");
    await chrome.storage.local.remove([LICENSE_STORAGE_KEY, LEGACY_LICENSE_KEY]);
    proEntitled = false;
    applyEntitlement({});
    updateAuthUi(false);
    setLicenseMessage("This browser has been deactivated.");
  } catch (error) {
    setLicenseMessage(error.message);
  } finally {
    deactivateLicenseBtn.disabled = false;
  }
});

buyProBtn.addEventListener("click", () => openCheckout(typeof TWIMARK_PLANS !== "array" && TWIMARK_PLANS ? TWIMARK_PLANS.checkoutUrl : undefined, "lifetime"));
document.getElementById("upgradeBuy").addEventListener("click", openUpgrade);

(async () => {
  await installationId();
  const email = await savedLicense();
  if (email && licenseEmailInput) licenseEmailInput.value = email;
  planCards();
  await refreshState();
  await refreshEntitlement({ force: true });
  updateAuthUi(proEntitled);
})();
setInterval(refreshState, 1000);
