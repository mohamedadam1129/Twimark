// Minimal, dependency-free DOM for exercising content.js under node:vm.
// Supports the selector subset content.js uses: tag names, [attr], [attr="v"],
// [attr*="v"], descendant combinators and comma-separated selector lists.

function parseCompound(text) {
  const match = text.match(/^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])*)$/);
  if (!match) throw new Error(`fake-dom: unsupported selector "${text}"`);
  const attrs = [...(match[2] || "").matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)]
    .map(([, name, op, value]) => ({ name, op, value }));
  return { tag: match[1]?.toLowerCase() || null, attrs };
}

function parseSelector(selector) {
  return selector.split(",").map((part) => part.trim().split(/\s+/).map(parseCompound));
}

function matchesCompound(el, { tag, attrs }) {
  if (tag && el.tagName !== tag) return false;
  return attrs.every(({ name, op, value }) => {
    const actual = el.getAttribute(name);
    if (actual === null) return false;
    if (!op) return true;
    return op === "=" ? actual === value : actual.includes(value);
  });
}

function matchesChain(el, chain) {
  if (!matchesCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let node = el.parentElement; node && i >= 0; node = node.parentElement) {
    if (matchesCompound(node, chain[i])) i -= 1;
  }
  return i < 0;
}

export class FakeElement {
  constructor(tag, attrs = {}, children = [], props = {}) {
    this.tagName = tag.toLowerCase();
    this.attributes = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    Object.assign(this, props);
    children.forEach((child) => this.append(child));
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null;
  }

  get src() { return this.getAttribute("src") || ""; }

  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  matches(selector) {
    return parseSelector(selector).some((chain) => matchesChain(this, chain));
  }

  querySelectorAll(selector) {
    const chains = parseSelector(selector);
    return [...this.descendants()].filter((el) => chains.some((chain) => matchesChain(el, chain)));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
}

export const h = (tag, attrs, children, props) => new FakeElement(tag, attrs, children, props);

// Builds an X-style <article data-testid="tweet"> element.
export function tweet({
  id,
  author = "Test Author",
  handle = "@testauthor",
  text = "A saved post",
  date = "2026-10-14T00:00:00.000Z",
  statusHref = id ? `/${handle.replace(/^@/, "")}/status/${id}` : null,
  avatar = "https://pbs.twimg.com/profile_images/avatar.jpg",
  photos = [],
  videos = [],
  mediaLinks = [],
  extraLinks = [],
  timeLinked = true,
} = {}) {
  const userInner = [author, handle].filter(Boolean).join("\n");
  const user = h("div", { "data-testid": "User-Name" }, avatar ? [h("img", { src: avatar }, [], { currentSrc: avatar })] : [], { innerText: userInner });
  const time = h("time", { datetime: date });
  const children = [user];
  // Links that appear before the timestamp (e.g. a quoted post) must not be
  // mistaken for the post's own permalink.
  extraLinks.forEach((href) => children.push(h("a", { href })));
  if (statusHref && timeLinked) children.push(h("a", { href: statusHref }, [time]));
  else {
    children.push(time);
    if (statusHref) children.push(h("a", { href: statusHref }));
  }
  if (text !== null) children.push(h("div", { "data-testid": "tweetText" }, [], { innerText: text }));
  photos.forEach((src) => children.push(h("div", { "data-testid": "tweetPhoto" }, [h("img", { src }, [], { currentSrc: src })])));
  videos.forEach((src) => children.push(h("video", { src })));
  mediaLinks.forEach((href) => children.push(h("a", { href })));
  return h("article", { "data-testid": "tweet" }, children);
}

export function createDocument(articles = []) {
  const timeline = h("div", { "data-testid": "primaryColumn" });
  const body = h("body", {}, [h("main", { role: "main" }, [timeline])]);
  const scrollingElement = h("html", {}, [], {
    scrollTop: 0,
    scrollHeight: 10_000,
    clientHeight: 800,
    scrollBy({ top }) { this.scrollTop += top; },
  });
  const document = {
    body,
    scrollingElement,
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    setArticles(list) {
      timeline.children = [];
      list.forEach((article) => timeline.append(article));
    },
  };
  document.setArticles(articles);
  return document;
}
