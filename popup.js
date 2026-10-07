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
const attributionToggleEl = document.getElementById("attributionToggle");

const LOGGED_IN_LABEL = "Pro is active ✓";
const ENTITLEMENT_KEY = "twimark_entitlement_v1";
const LEGACY_LICENSE_KEY = "pro_license_v1"; // pre-2.7 lifetime keys
const ATTRIBUTION_OPT_OUT_KEY = "remove_attribution_v1";
const INSTALLATION_STORAGE_KEY = "installation_id_v1";
const ENTITLEMENT_REFRESH_MS = 15 * 60 * 1000;
const FREE_EXPORT_LIMIT = 5;

let currentState = null;
let proEntitled = false;
let proTier = "free";      // free | pro_monthly | pro_annual | pro_lifetime
let proState = "unpaid";   // active | grace | paused | trial | suspended | unpaid | lifetime
let graceUntilMs = null;
let portalUrl = null;
let legacyLicense = null;
let entitlementEmail = "";
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

// --- Pricing (monthly / annual / Founding Pass) -----------------------------

function planList() {
  if (Array.isArray(TWIMARK_PLANS) && TWIMARK_PLANS.length) return TWIMARK_PLANS;
  return typeof TWIMARK_PLANS === "object" && TWIMARK_PLANS ? [TWIMARK_PLANS] : [];
}

function renderPricingCards() {
  const target = document.querySelector("#upgradeModal .pricing");
  if (!target) return;
  target.replaceChildren(
    ...planList().map((plan) => {
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
      per.textContent = ` ${plan.per}`;
      price.append(amount, per);
      section.append(price);
      if (plan.billed) {
        const billed = document.createElement("p");
        billed.className = "billed";
        billed.textContent = plan.billed;
        section.append(billed);
      }
      for (const feature of plan.features || []) {
        const item = document.createElement("p");
        item.className = "feature";
        item.textContent = `• ${feature}`;
        section.append(item);
      }
      const callout = document.createElement("p");
      callout.className = "callout";
      callout.textContent = plan.callout;
      section.append(callout);
      const buy = document.createElement("button");
      buy.type = "button";
      buy.className = "buy";
      buy.textContent = plan.cta || "Continue";
      buy.addEventListener("click", () => openCheckout(plan.checkoutUrl, plan.id));
      section.append(buy);
      return section;
    })
  );
}

function updateAuthUi(loggedIn) {
  if (openLicenseBtn) {
    openLicenseBtn.classList.toggle("logged-in", loggedIn);
    openLicenseBtn.innerHTML = loggedIn ? LOGGED_IN_LABEL : "Already have Pro?<br>Log in";
    openLicenseBtn.title = loggedIn ? `Twimark Pro (${proTier.replace("pro_", "")}) — state: ${proState}` : "";
  }
  if (authStateEl) {
    authStateEl.hidden = !loggedIn;
    authStateEl.textContent = loggedIn ? "Logged in" : "";
  }
  if (attributionToggleEl) {
    attributionToggleEl.closest(".attribution-row").hidden = !loggedIn;
    if (!loggedIn) attributionToggleEl.checked = false;
  }
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
  if (state.threadStitching?.status === "stitching") statusEl.textContent = `Research-Grade Structuring… ${state.threadStitching.completed} of ${state.threadStitching.total} conversations checked.`;
  if (state.status === "error") statusEl.textContent = `Scan failed: ${state.error || "Unknown error"}`;
  renderPaymentBanner();
}

function renderPaymentBanner() {
  if (!paymentBannerEl) return;
  const show = proEntitled && proState === "grace" && graceUntilMs && graceUntilMs > Date.now();
  if (!show) {
    paymentBannerEl.hidden = true;
    paymentBannerEl.replaceChildren();
    return;
  }
  const hoursLeft = Math.max(1, Math.ceil((graceUntilMs - Date.now()) / 3_600_000));
  paymentBannerEl.replaceChildren();
  const text = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = "Payment issue. ";
  text.append(strong, document.createTextNode(`Pro stays on for about ${hoursLeft}h. Update your card to keep full access.`));
  const action = document.createElement("a");
  action.href = portalUrl || "https://twimark.lemonsqueezy.com/billing";
  action.target = "_blank";
  action.rel = "noopener";
  action.className = "banner-button";
  action.textContent = "Fix payment →";
  action.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: portalUrl || "https://twimark.lemonsqueezy.com/billing" });
  });
  paymentBannerEl.append(text, action);
  paymentBannerEl.hidden = false;
}

// --- Entitlement ------------------------------------------------------------

async function installationId() {
  const stored = await chrome.storage.local.get(INSTALLATION_STORAGE_KEY);
  if (stored[INSTALLATION_STORAGE_KEY]) return stored[INSTALLATION_STORAGE_KEY];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALLATION_STORAGE_KEY]: id });
  return id;
}

function applyEntitlement(ent) {
  proEntitled = Boolean(ent?.pro);
  proTier = ent?.tier || "free";
  proState = ent?.state || "unpaid";
  graceUntilMs = ent?.graceUntilMs || null;
  portalUrl = ent?.portalUrl || null;
  if (ent?.email) entitlementEmail = ent.email;
  updateAuthUi(proEntitled);
  renderPaymentBanner();
}

async function refreshEntitlement({ quiet = false, force = false } = {}) {
  if (!releaseConfigured()) return proEntitled;
  const stored = await chrome.storage.local.get([ENTITLEMENT_KEY, LEGACY_LICENSE_KEY]);
  const cachedEntitlement = stored[ENTITLEMENT_KEY];
  legacyLicense = stored[LEGACY_LICENSE_KEY] || null;
  if (cachedEntitlement?.email) entitlementEmail = cachedEntitlement.email;

  const cacheFresh = cachedEntitlement?.fetchedAt && Date.now() - cachedEntitlement.fetchedAt < ENTITLEMENT_REFRESH_MS;
  if (!force && cacheFresh) {
    applyEntitlement(cachedEntitlement);
    return proEntitled;
  }

  const email = entitlementEmail || licenseEmailInput?.value?.trim() || "";
  if (!email) return proEntitled;

  try {
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, installationId: await installationId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data.error || "Entitlement verification failed.");

    if (data.claimed === false) {
      // Purchase exists for this email but not yet claimed on this device.
      await activateStoredPurchase({ email, licenseKey: legacyLicense?.key, quiet: true });
      return proEntitled;
    }
    const entitlement = { ...data, email, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [ENTITLEMENT_KEY]: entitlement });
    applyEntitlement(entitlement);
    if (!quiet) setLicenseMessage(data.pro ? "Twimark Pro is active on this browser." : "No active Pro purchase found on this browser.");
    return data.pro;
  } catch (error) {
    if (cachedEntitlement) applyEntitlement(cachedEntitlement); // serve last known state offline
    if (!quiet) setLicenseMessage(error.message);
    return proEntitled;
  }
}

async function activateStoredPurchase({ email, licenseKey, quiet = false } = {}) {
  if (!releaseConfigured() || !email) return null;
  const payload = { email, installationId: await installationId() };
  if (licenseKey) payload.licenseKey = licenseKey;
  try {
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) {
      if (!quiet) setLicenseMessage(data.error || "Could not activate Twimark Pro for this email.");
      return null;
    }
    if (data.claimed === false) {
      if (!quiet) setLicenseMessage("No Pro purchase found for this email yet.");
      return null;
    }
    const entitlement = { ...data, email, fetchedAt: Date.now() };
    await chrome.storage.local.set({ [ENTITLEMENT_KEY]: entitlement });
    applyEntitlement(entitlement);
    if (!quiet) setLicenseMessage("Twimark Pro is active on this browser.");
    return entitlement;
  } catch (error) {
    if (!quiet) setLicenseMessage(error.message);
    return null;
  }
}

// --- Scan / export ----------------------------------------------------------

async function refreshState() {
  const response = await chrome.runtime.sendMessage({ action: "get_scan_state" });
  if (!response?.ok) return;
  renderState(response.state);
  if (pendingExport && response.state?.status === "ready" && bookmarks().length && !exporting) {
    pendingExport = false;
    await exportBookmarks();
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

function postText(post) {
  const media = post.media?.length ? `\n\n**Media:**\n${post.media.map((url) => `- ${url}`).join("\n")}` : "";
  return `${post.text || "Image/video-only post."}${media}\n\n**Source:** ${post.url}`;
}

function withheldBlock(fromPost, toPost) {
  return (typeof TWIMARK_WITHHELD_BLOCK === "string" ? TWIMARK_WITHHELD_BLOCK : "")
    .replaceAll("{FROM}", String(fromPost))
    .replaceAll("{TO}", String(toPost));
}

function attributionFooter(isPro) {
  if (isPro && attributionToggleEl?.checked) return "";
  return typeof TWIMARK_ATTRIBUTION_FOOTER === "string" ? `\n---\n\n${TWIMARK_ATTRIBUTION_FOOTER}\n` : "";
}

// Free exports are never fully blocked: the first TWIMARK_FREE_POSTS_PER_THREAD
// posts of a thread export cleanly, the rest collapse into the withheld block.
function threadPostsForExport(thread, isPro) {
  const freeQuota = typeof TWIMARK_FREE_POSTS_PER_THREAD === "number" ? TWIMARK_FREE_POSTS_PER_THREAD : 3;
  if (isPro || !Array.isArray(thread) || thread.length <= freeQuota) return { posts: thread, withheld: null };
  const kept = thread.slice(0, freeQuota);
  const withheld = withheldBlock(freeQuota + 1, thread.length);
  return { posts: kept, withheld };
}

function markdown(bookmarkList, isPro) {
  const emittedThreads = new Set();
  const sections = bookmarkList.flatMap((tweet) => {
    const thread = Array.isArray(tweet.thread) && tweet.thread.length > 1 ? tweet.thread : null;
    const threadKey = tweet.threadRootId || tweet.id;
    if (thread && emittedThreads.has(threadKey)) return [];
    if (thread) {
      emittedThreads.add(threadKey);
      const { posts, withheld } = threadPostsForExport(thread, isPro);
      const parts = posts.map((post, index) => `### Post ${index + 1}\n\n${postText(post)}`);
      const suffix = withheld ? `\n\n${withheld}` : "";
      return `## Thread by ${tweet.user} (${tweet.handle})\n\n${parts.join("\n\n")}${suffix}`;
    }
    const date = tweet.date || "No date";
    const text = tweet.text || "Image/video-only bookmark.";
    const media = tweet.media?.length ? `\n\n**Media:**\n${tweet.media.map((url) => `- ${url}`).join("\n")}` : "";
    return [`## Tweet by ${tweet.user} (${tweet.handle}) — ${date}\n\n**Tweet text:**\n${text}\n\n**Source:** ${tweet.url}${media}`];
  });
  return `# Twitter Bookmark Archive\n\nExported by Twimark on ${new Date().toISOString()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n\n---\n${attributionFooter(isPro)}`;
}

async function downloadMarkdown(bookmarkList, isPro) {
  const filename = `Twimark_NotebookLM_${new Date().toISOString().slice(0, 10)}.md`;
  const url = `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown(bookmarkList, isPro))}`;
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
  document.getElementById("transformFooter").textContent = isPro ? "Full Markdown • Ready for NotebookLM" : `Preview export • ${Math.max(0, bookmarks().length - selection.length)} more in your vault`;
  setModal("transformModal", true);
}

// Truncated-thread upsell: blurred preview of the structured thread, then the
// choice between upgrading or continuing with the 3-post preview.
function showTruncationUpsell(truncatedThread, onComplete) {
  const modal = document.getElementById("truncationModal");
  if (!modal) { onComplete(); return; }
  const first = truncatedThread[0] || {};
  document.getElementById("truncationHandle").textContent = `${first.user || "Unknown"} (${first.handle || "@unknown"})`;
  document.getElementById("truncationCount").textContent = `${truncatedThread.length} posts in this thread`;
  const preview = document.getElementById("truncationPreview");
  preview.replaceChildren();
  const visible = document.createElement("p");
  visible.className = "visible";
  visible.textContent = (first.text || "Thread opening post…").slice(0, 160);
  preview.append(visible);
  for (let i = 0; i < 3; i += 1) {
    const blurred = document.createElement("p");
    blurred.className = "blurred";
    blurred.textContent = "▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒ ▒▒▒▒ ▒▒▒▒▒▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒ ▒▒▒▒▒▒▒▒▒";
    preview.append(blurred);
  }
  const primary = document.getElementById("truncationUpgrade");
  const ghost = document.getElementById("truncationContinue");
  const primaryClone = primary.cloneNode(true);
  const ghostClone = ghost.cloneNode(true);
  primary.replaceWith(primaryClone);
  ghost.replaceWith(ghostClone);
  primaryClone.addEventListener("click", () => { setModal("truncationModal", false); openCheckout(planList()[1]?.checkoutUrl || planList()[0]?.checkoutUrl, planList()[1]?.id || "annual"); });
  ghostClone.addEventListener("click", () => { setModal("truncationModal", false); onComplete(); });
  setModal("truncationModal", true);
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
      exportBtn.textContent = "Structuring sources…";
      statusEl.textContent = "Research-Grade Structuring is checking related posts from the same author.";
      const stitched = await chrome.runtime.sendMessage({ action: "stitch_threads" });
      if (!stitched?.ok) throw new Error(stitched?.error || "Structuring could not start.");
      await refreshState();
      all = bookmarks();
    }
    const selection = isPro ? all : all.slice(0, FREE_EXPORT_LIMIT);
    const truncatedThread = !isPro
      ? selection.map((tweet) => (Array.isArray(tweet.thread) ? tweet.thread : null)).find((thread) => thread && thread.length > (TWIMARK_FREE_POSTS_PER_THREAD ?? 3))
      : null;

    if (truncatedThread) {
      showTruncationUpsell(truncatedThread, () => {
        pendingDownload = { selection, isPro };
        showTransform(selection, isPro);
      });
      return;
    }
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
  const join = baseUrl.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  params.set("checkout[custom][twimark_installation_id]", pendingInstallationId || "");
  params.set("checkout[custom][twimark_plan]", planId);
  const email = licenseEmailInput?.value?.trim() || entitlementEmail;
  if (email) params.set("checkout[prefill][email]", email);
  return `${baseUrl}${join}${params.toString()}`;
}

let pendingInstallationId = "";

async function openCheckout(baseUrl, planId = "lifetime") {
  if (!baseUrl) { openUpgrade(); return; }
  pendingInstallationId = await installationId();
  chrome.tabs.create({ url: purchaseUrl(baseUrl, planId) });
}

// --- Events -----------------------------------------------------------------

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
    await downloadMarkdown(pendingDownload.selection, pendingDownload.isPro);
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
  if (!key && !entitlementEmail) return setLicenseMessage("Enter the email you used at Lemon Squeezy, or paste your legacy license key.");
  activateLicenseBtn.disabled = true;
  try {
    const entitlement = await activateStoredPurchase({ email, licenseKey: key || legacyLicense?.key });
    if (!entitlement) throw new Error(licenseMessage.textContent || "Activation failed.");
    await chrome.storage.local.set({ [ENTITLEMENT_KEY]: { ...entitlement, fetchedAt: Date.now() } });
    if (key) await chrome.storage.local.set({ [LEGACY_LICENSE_KEY]: { key, email } });
    setTimeout(() => setModal("licenseModal", false), 650);
  } catch (error) {
    setLicenseMessage(error.message);
  } finally {
    activateLicenseBtn.disabled = false;
  }
});

deactivateLicenseBtn.addEventListener("click", async () => {
  const email = licenseEmailInput.value.trim() || entitlementEmail;
  if (!email) return setLicenseMessage("There is no active Pro license on this browser.");
  deactivateLicenseBtn.disabled = true;
  try {
    const response = await fetch(`${TWIMARK_LICENSE_API_BASE}/deactivate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, installationId: await installationId() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!data?.ok) throw new Error(data.error || "Could not deactivate this device.");
    await chrome.storage.local.remove([ENTITLEMENT_KEY, LEGACY_LICENSE_KEY]);
    proEntitled = false;
    applyEntitlement({ pro: false, tier: "free", state: "unpaid" });
    setLicenseMessage("This browser has been deactivated.");
  } catch (error) {
    setLicenseMessage(error.message);
  } finally {
    deactivateLicenseBtn.disabled = false;
  }
});

buyProBtn.addEventListener("click", openUpgrade);
document.getElementById("upgradeBuy").addEventListener("click", async () => {
  const params = new URLSearchParams({ installation_id: await installationId() });
  if (entitlementEmail) params.set("email", entitlementEmail);
  chrome.tabs.create({ url: `${TWIMARK_LICENSE_API_BASE}/upgrade?${params.toString()}` });
});

if (attributionToggleEl) {
  chrome.storage.local.get(ATTRIBUTION_OPT_OUT_KEY).then((stored) => {
    attributionToggleEl.checked = Boolean(stored[ATTRIBUTION_OPT_OUT_KEY]);
  });
  attributionToggleEl.addEventListener("change", () => {
    chrome.storage.local.set({ [ATTRIBUTION_OPT_OUT_KEY]: attributionToggleEl.checked });
  });
}

// --- Init -------------------------------------------------------------------

(async () => {
  await installationId();
  const stored = await chrome.storage.local.get([ENTITLEMENT_KEY, LEGACY_LICENSE_KEY]);
  legacyLicense = stored[LEGACY_LICENSE_KEY] || null;
  const email = stored[ENTITLEMENT_KEY]?.email || legacyLicense?.email || "";
  if (email && licenseEmailInput) licenseEmailInput.value = email;
  renderPricingCards();
  await refreshState();
  await refreshEntitlement({ force: true });
})();
setInterval(refreshState, 1000);
