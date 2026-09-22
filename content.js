(() => {
  if (window.__twimarkScannerInstalled) return;
  window.__twimarkScannerInstalled = true;

  const MAX_STALLED_ROUNDS = 8;
  const WAIT_AFTER_SCROLL_MS = 1800;
  const seenIds = new Set();
  let running = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function canonicalStatus(article) {
    const time = article.querySelector("time");
    const timeLink = time?.closest('a[href*="/status/"]');
    const link = timeLink || article.querySelector('a[href*="/status/"]');
    const href = link?.getAttribute("href") || "";
    const match = href.match(/\/status\/(\d+)/);
    if (!match) return null;
    return { id: match[1], url: new URL(href, window.location.origin).href };
  }

  function mediaUrls(article) {
    const urls = new Set();
    article.querySelectorAll('[data-testid="tweetPhoto"] img[src], video[src], a[href*="/photo/"], a[href*="/video/"]')
      .forEach((element) => {
        const value = element.currentSrc || element.src || element.getAttribute("href");
        if (value) urls.add(new URL(value, window.location.origin).href);
      });
    return [...urls];
  }

  function scrape(article) {
    const status = canonicalStatus(article);
    if (!status || seenIds.has(status.id)) return null;

    const userEl = article.querySelector('[data-testid="User-Name"]');
    const lines = userEl?.innerText?.split("\n") || [];
    const avatar = userEl?.querySelector("img")?.currentSrc || userEl?.querySelector("img")?.src || "";
    const text = article.querySelector('[data-testid="tweetText"]')?.innerText?.trim() || "";
    const media = mediaUrls(article);
    if (!text && media.length === 0) return null;

    seenIds.add(status.id);
    return {
      ...status,
      user: lines[0] || "Unknown User",
      handle: lines.find((line) => line.startsWith("@")) || "@unknown",
      avatar,
      date: article.querySelector("time")?.getAttribute("datetime") || null,
      text,
      media
    };
  }

  function scrollTarget() {
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    const candidates = [document.scrollingElement, primary, primary?.parentElement, document.querySelector('main[role="main"]')];
    return candidates.find((element) => element && element.scrollHeight > element.clientHeight + 10) || document.scrollingElement;
  }

  async function waitForTimelineChange(previousCount) {
    await Promise.race([
      new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (document.querySelectorAll('article[data-testid="tweet"]').length !== previousCount) {
            observer.disconnect();
            resolve();
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(); }, WAIT_AFTER_SCROLL_MS);
      }),
      sleep(WAIT_AFTER_SCROLL_MS)
    ]);
  }

  async function scan() {
    let stalledRounds = 0;
    try {
      while (stalledRounds < MAX_STALLED_ROUNDS) {
        const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
        const batch = articles.map(scrape).filter(Boolean);
        if (batch.length) await chrome.runtime.sendMessage({ action: "record_bookmarks", bookmarks: batch });

        const target = scrollTarget();
        const beforeTop = target?.scrollTop || window.scrollY;
        const beforeCount = articles.length;
        window.scrollBy({ top: Math.max(window.innerHeight * 0.9, 700), behavior: "auto" });
        target?.scrollBy?.({ top: Math.max(window.innerHeight * 0.9, 700), behavior: "auto" });
        await waitForTimelineChange(beforeCount);

        const moved = (target?.scrollTop || window.scrollY) > beforeTop;
        if (batch.length || moved) stalledRounds = 0;
        else stalledRounds += 1;
      }
      await chrome.runtime.sendMessage({ action: "complete_scan" });
    } catch (error) {
      console.error("Twimark scan failed", error);
      await chrome.runtime.sendMessage({ action: "complete_scan", error: error.message });
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== "start_scan") return;
    if (running) {
      sendResponse({ ok: false, error: "A scan is already running." });
      return;
    }
    // The script remains installed in the X tab after a scan. A fresh scan
    // must not inherit the previous run's deduplication set.
    seenIds.clear();
    running = true;
    scan();
    sendResponse({ ok: true });
  });
})();
