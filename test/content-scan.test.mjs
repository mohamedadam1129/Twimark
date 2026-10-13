import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Reproduces the X virtual-timeline failure mode: scrollTop continues to grow
// after the last unique post has been seen. The scanner must still complete.
const scannerSource = fs.readFileSync(new URL("../content.js", import.meta.url), "utf8")
  .replace("const MAX_NO_NEW_ROUNDS = 12;", "const MAX_NO_NEW_ROUNDS = 3;")
  // Keep the production scan loop but skip its real 1.8-second DOM wait in
  // this deterministic unit test.
  .replace(
    /async function waitForTimelineChange\(previousCount\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function scan/,
    "async function waitForTimelineChange() {}\n\n  async function scan"
  );

const records = [];
let onMessage;
let complete;
let feedHasArticle = true;

const statusLink = { getAttribute: () => "/test/status/123" };
const time = {
  closest: () => statusLink,
  getAttribute: () => "2026-10-14T00:00:00.000Z",
};
const user = {
  innerText: "Test Author\n@testauthor",
  querySelector: () => ({ currentSrc: "https://example.invalid/avatar.png" }),
};
const article = {
  querySelector(selector) {
    if (selector === "time") return time;
    if (selector === '[data-testid="User-Name"]') return user;
    if (selector === '[data-testid="tweetText"]') return { innerText: "A saved post" };
    return null;
  },
  querySelectorAll: () => [],
};

const scrollingElement = {
  scrollTop: 0,
  scrollHeight: 10_000,
  clientHeight: 800,
  scrollBy({ top }) { this.scrollTop += top; },
};
const document = {
  body: {},
  scrollingElement,
  querySelector(selector) {
    if (selector === '[data-testid="primaryColumn"]') return null;
    return null;
  },
  querySelectorAll(selector) {
    return selector === 'article[data-testid="tweet"]' && feedHasArticle ? [article] : [];
  },
};
const window = {
  __twimarkScannerInstalled: false,
  location: { origin: "https://x.com" },
  innerHeight: 800,
  scrollY: 0,
  scrollBy({ top }) { this.scrollY += top; },
};

class MutationObserver {
  constructor() {}
  observe() {}
  disconnect() {}
}

const chrome = {
  runtime: {
    sendMessage: async (message) => {
      records.push(message);
      // Simulate X recycling away the final article while it continues to let
      // the scroll container move.
      if (message.action === "record_bookmarks") feedHasArticle = false;
      if (message.action === "complete_scan") complete();
      return { ok: true };
    },
    onMessage: { addListener(listener) { onMessage = listener; } },
  },
};

const context = { chrome, document, window, MutationObserver, URL, Set, Promise, console, setTimeout, clearTimeout };
vm.createContext(context);
vm.runInContext(scannerSource, context, { filename: "content.js" });

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Scanner did not complete after the timeline stopped yielding unique posts.")), 250);
  complete = () => { clearTimeout(timeout); resolve(); };
  onMessage({ action: "start_scan" }, {}, (result) => assert.equal(JSON.stringify(result), JSON.stringify({ ok: true })));
});

assert.equal(records.filter((record) => record.action === "record_bookmarks").length, 1);
assert.equal(records.at(-1)?.action, "complete_scan");
assert.ok(scrollingElement.scrollTop > 0, "The test must keep scrolling to cover the virtual-timeline condition.");
console.log("ok - scanner completes when X keeps scrolling but produces no new bookmarks");
