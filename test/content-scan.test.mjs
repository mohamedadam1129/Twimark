import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createDocument, tweet } from "./helpers/fake-dom.mjs";

// Headless unit tests for content.js: status permalink parsing, media
// extraction, post scraping, the bookmark scan loop and thread stitching.
// Runs with plain `node test/content-scan.test.mjs` (no dependencies).

const SOURCE = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8");
const HOOK_ANCHOR = "chrome.runtime.onMessage.addListener(";
assert.ok(SOURCE.includes(HOOK_ANCHOR), "content.js no longer registers its message listener the way these tests expect.");
// Expose the IIFE's internals to the tests without changing production code.
const INSTRUMENTED = SOURCE.replace(
  HOOK_ANCHOR,
  `window.__twimarkTest = { canonicalStatus, mediaUrls, scrape, seenIds };\n  ${HOOK_ANCHOR}`,
);

function loadScanner({ articles = [], sendMessage } = {}) {
  const document = createDocument(articles);
  const messages = [];
  let listener;
  const window = {
    __twimarkScannerInstalled: false,
    location: { origin: "https://x.com" },
    innerHeight: 800,
    scrollY: 0,
    scrollBy({ top }) { this.scrollY += top; },
  };
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        return sendMessage ? sendMessage(message, { document, messages }) : { ok: true };
      },
      onMessage: { addListener(fn) { listener = fn; } },
    },
  };
  class MutationObserver {
    observe() {}
    disconnect() {}
  }
  // Collapse every timer to zero so the 900 ms thread wait and the 1.8 s
  // post-scroll wait run instantly while keeping production control flow.
  const fastTimeout = (fn) => setTimeout(fn, 0);
  const context = {
    chrome, document, window, MutationObserver, URL, Set, Map, Promise, BigInt,
    console: { ...console, error() {} },
    setTimeout: fastTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(INSTRUMENTED, context, { filename: "content.js" });

  const send = (request) => new Promise((resolve) => {
    // Responses are built inside the vm realm; normalise them so deepEqual
    // compares plain data rather than cross-realm prototypes.
    const reply = (value) => resolve(value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    const result = listener(request, {}, reply);
    if (result !== true) setTimeout(() => resolve(undefined), 0);
  });
  const waitForComplete = (timeoutMs = 2000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const done = messages.find((m) => m.action === "complete_scan");
      if (done) return resolve(done);
      if (Date.now() - started > timeoutMs) return reject(new Error("scan never sent complete_scan"));
      setTimeout(poll, 1);
    };
    poll();
  });
  return { api: window.__twimarkTest, window, document, messages, send, listener: () => listener, waitForComplete };
}

const recorded = (messages) => messages
  .filter((m) => m.action === "record_bookmarks")
  .flatMap((m) => m.bookmarks);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- canonicalStatus --------------------------------------------------------

test("status: uses the timestamp permalink, not a quoted post's link", () => {
  const { api } = loadScanner();
  const article = tweet({ id: "1800000000000000001", extraLinks: ["/quoted/status/42"] });
  assert.deepEqual({ ...api.canonicalStatus(article) }, {
    id: "1800000000000000001",
    url: "https://x.com/testauthor/status/1800000000000000001",
  });
});

test("status: falls back to the first status link when the timestamp is unlinked", () => {
  const { api } = loadScanner();
  const article = tweet({ id: "555", timeLinked: false });
  assert.equal(api.canonicalStatus(article).id, "555");
});

test("status: strips /photo/N and /analytics suffixes and resolves absolute URLs", () => {
  const { api } = loadScanner();
  assert.equal(api.canonicalStatus(tweet({ statusHref: "/a/status/987/photo/1" })).id, "987");
  assert.equal(api.canonicalStatus(tweet({ statusHref: "https://twitter.com/a/status/321/analytics" })).url,
    "https://twitter.com/a/status/321/analytics");
  assert.equal(api.canonicalStatus(tweet({ statusHref: "/i/web/status/777" })).id, "777");
});

test("status: returns null for articles without a numeric status link", () => {
  const { api } = loadScanner();
  assert.equal(api.canonicalStatus(tweet({ statusHref: null })), null);
  assert.equal(api.canonicalStatus(tweet({ statusHref: "/a/status/not-a-number" })), null);
  assert.equal(api.canonicalStatus(tweet({ statusHref: "/a/lists/123" })), null);
});

// --- mediaUrls --------------------------------------------------------------

test("media: collects photos, videos and photo/video links as absolute URLs", () => {
  const { api } = loadScanner();
  const article = tweet({
    id: "1",
    photos: ["https://pbs.twimg.com/media/a.jpg"],
    videos: ["https://video.twimg.com/v.mp4"],
    mediaLinks: ["/testauthor/status/1/photo/2", "/testauthor/status/1/video/1"],
  });
  assert.deepEqual([...api.mediaUrls(article)], [
    "https://pbs.twimg.com/media/a.jpg",
    "https://video.twimg.com/v.mp4",
    "https://x.com/testauthor/status/1/photo/2",
    "https://x.com/testauthor/status/1/video/1",
  ]);
});

test("media: de-duplicates repeated sources and ignores the author avatar", () => {
  const { api } = loadScanner();
  const article = tweet({ id: "1", photos: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/a.jpg"] });
  assert.deepEqual([...api.mediaUrls(article)], ["https://pbs.twimg.com/media/a.jpg"]);
});

// --- scrape -----------------------------------------------------------------

test("scrape: maps author, handle, avatar, date, text and media", () => {
  const { api } = loadScanner();
  const post = api.scrape(tweet({
    id: "10", author: "Ada Lovelace", handle: "@ada", text: "  Notes on the engine  ",
    date: "2026-01-02T03:04:05.000Z", photos: ["https://pbs.twimg.com/media/n.jpg"],
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(post)), {
    id: "10",
    url: "https://x.com/ada/status/10",
    user: "Ada Lovelace",
    handle: "@ada",
    avatar: "https://pbs.twimg.com/profile_images/avatar.jpg",
    date: "2026-01-02T03:04:05.000Z",
    text: "Notes on the engine",
    media: ["https://pbs.twimg.com/media/n.jpg"],
  });
});

test("scrape: finds the handle even when X inserts extra lines (verified badge, dot)", () => {
  const { api } = loadScanner();
  const article = tweet({ id: "11" });
  article.querySelector('[data-testid="User-Name"]').innerText = "Grace\nVerified\n@grace\n·\n2h";
  assert.equal(api.scrape(article).handle, "@grace");
  assert.equal(api.scrape(article, false).user, "Grace");
});

test("scrape: falls back to Unknown User / @unknown when the header is missing", () => {
  const { api } = loadScanner();
  const article = tweet({ id: "12", author: "", handle: "" });
  article.querySelector('[data-testid="User-Name"]').innerText = "";
  const post = api.scrape(article);
  assert.equal(post.user, "Unknown User");
  assert.equal(post.handle, "@unknown");
});

test("scrape: keeps media-only posts and drops posts with neither text nor media", () => {
  const { api } = loadScanner();
  assert.ok(api.scrape(tweet({ id: "13", text: null, photos: ["https://pbs.twimg.com/media/x.jpg"] })));
  assert.equal(api.scrape(tweet({ id: "14", text: "   " })), null);
  assert.equal(api.scrape(tweet({ id: "15", text: null })), null);
});

test("scrape: de-duplicates by status id unless deduplicate=false", () => {
  const { api } = loadScanner();
  const article = tweet({ id: "16" });
  assert.ok(api.scrape(article));
  assert.equal(api.scrape(article), null);
  assert.ok(api.scrape(article, false), "thread extraction must still see already-seen posts");
});

test("scrape: a post dropped for being empty is not marked as seen", () => {
  const { api } = loadScanner();
  api.scrape(tweet({ id: "17", text: null }));
  assert.equal(api.seenIds.has("17"), false);
});

// --- scan loop --------------------------------------------------------------

test("scan: completes when X keeps scrolling but yields no new posts (virtual timeline)", async () => {
  const scanner = loadScanner({
    articles: [tweet({ id: "123" })],
    // X recycles the last article away while the scroll container keeps moving.
    sendMessage: (message, { document }) => {
      if (message.action === "record_bookmarks") document.setArticles([]);
      return { ok: true };
    },
  });
  assert.deepEqual(await scanner.send({ action: "start_scan" }), { ok: true });
  const done = await scanner.waitForComplete();
  assert.equal(done.error, undefined);
  assert.deepEqual(recorded(scanner.messages).map((p) => p.id), ["123"]);
  assert.ok(scanner.document.scrollingElement.scrollTop > 0, "must keep scrolling the timeline");
  assert.ok(scanner.window.scrollY > 0);
});

test("scan: records each post once across rounds as new posts stream in", async () => {
  const pages = [
    [tweet({ id: "1" }), tweet({ id: "2" })],
    [tweet({ id: "2" }), tweet({ id: "3" })],
    [tweet({ id: "3" }), tweet({ id: "4" }), tweet({ id: "5", text: null })],
  ];
  let page = 0;
  const scanner = loadScanner({
    articles: pages[0],
    sendMessage: (message, { document }) => {
      if (message.action === "record_bookmarks" && page < pages.length - 1) document.setArticles(pages[++page]);
      return { ok: true };
    },
  });
  await scanner.send({ action: "start_scan" });
  await scanner.waitForComplete();
  assert.deepEqual(recorded(scanner.messages).map((p) => p.id), ["1", "2", "3", "4"]);
  const batches = scanner.messages.filter((m) => m.action === "record_bookmarks");
  assert.equal(batches.length, 3, "empty rounds must not send record_bookmarks");
});

test("scan: rejects a second start_scan while one is running, then allows a fresh one", async () => {
  const scanner = loadScanner({ articles: [tweet({ id: "1" })] });
  assert.deepEqual(await scanner.send({ action: "start_scan" }), { ok: true });
  assert.deepEqual(await scanner.send({ action: "start_scan" }), { ok: false, error: "A scan is already running." });
  await scanner.waitForComplete();
  await new Promise((r) => setTimeout(r, 5));

  scanner.messages.length = 0;
  assert.deepEqual(await scanner.send({ action: "start_scan" }), { ok: true });
  await scanner.waitForComplete();
  assert.deepEqual(recorded(scanner.messages).map((p) => p.id), ["1"], "a new scan must not inherit the previous seen set");
});

test("scan: reports the error in complete_scan if messaging fails", async () => {
  const scanner = loadScanner({
    articles: [tweet({ id: "1" })],
    sendMessage: (message) => {
      if (message.action === "record_bookmarks") throw new Error("Extension context invalidated.");
      return { ok: true };
    },
  });
  await scanner.send({ action: "start_scan" });
  const done = await scanner.waitForComplete();
  assert.equal(done.error, "Extension context invalidated.");
});

test("scan: installing the script twice registers only one listener", () => {
  const scanner = loadScanner();
  const first = scanner.listener();
  scanner.window.__twimarkScannerInstalled = true;
  assert.ok(first);
  // Re-running the IIFE with the guard set must be a no-op.
  const ctx = { window: scanner.window, chrome: { runtime: { onMessage: { addListener() { throw new Error("re-registered"); } } } } };
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(SOURCE, ctx));
});

test("messages: ignores unrelated actions", async () => {
  const scanner = loadScanner();
  assert.equal(await scanner.send({ action: "something_else" }), undefined);
  assert.equal(scanner.messages.length, 0);
});

// --- thread stitching -------------------------------------------------------

test("thread: keeps only the author's posts and orders them chronologically by id", async () => {
  const author = { author: "Ada", handle: "@ada" };
  const scanner = loadScanner({
    articles: [
      tweet({ id: "1000", ...author, text: "part 3" }),
      tweet({ id: "999", ...author, text: "part 2" }),        // shorter id, earlier post
      tweet({ id: "1001", author: "Bob", handle: "@bob", text: "reply" }),
      tweet({ id: "998", ...author, text: "part 1" }),
      tweet({ id: "999", ...author, text: "part 2" }),        // duplicate render
      tweet({ id: "1002", ...author, text: null }),           // empty, skipped
    ],
  });
  const result = await scanner.send({ action: "extract_thread", targetId: "999" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.posts.map((p) => p.text), ["part 1", "part 2", "part 3"]);
  assert.ok(result.posts.every((p) => p.handle === "@ada"));
});

test("thread: sorts 64-bit snowflake ids without precision loss", async () => {
  const ids = ["1849000000000000002", "1849000000000000001", "1849000000000000010"];
  const scanner = loadScanner({ articles: ids.map((id) => tweet({ id, text: id })) });
  const result = await scanner.send({ action: "extract_thread", targetId: ids[0] });
  assert.deepEqual(result.posts.map((p) => p.id), [
    "1849000000000000001", "1849000000000000002", "1849000000000000010",
  ]);
});

test("thread: works for posts the scan already marked as seen", async () => {
  const scanner = loadScanner({ articles: [tweet({ id: "50" }), tweet({ id: "51" })] });
  scanner.api.scrape(tweet({ id: "50" }));
  const result = await scanner.send({ action: "extract_thread", targetId: "50" });
  assert.deepEqual(result.posts.map((p) => p.id), ["50", "51"]);
});

test("thread: returns a clear error when the bookmarked post is not on the page", async () => {
  const scanner = loadScanner({ articles: [tweet({ id: "1" })] });
  assert.deepEqual(await scanner.send({ action: "extract_thread", targetId: "2" }), {
    ok: false,
    error: "Could not locate the bookmarked post in this conversation.",
  });
});

// --- runner -----------------------------------------------------------------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`not ok - ${name}\n  ${error.stack?.split("\n").slice(0, 3).join("\n  ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} content.js tests passed.`);
// Exit explicitly: a regressed scan loop can leave timers running forever.
process.exit(failed ? 1 : 0);
