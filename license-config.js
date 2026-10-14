// Twimark Pro licensing — shared between popup.js, background.js and tests.
// Checkout URLs and plan copy for the three pricing tiers.

// The gateway Worker that verifies entitlements and owns the webhook receiver.
const TWIMARK_LICENSE_API_BASE = "https://twimark-license-gateway.twimarkworker.workers.dev";

// Pricing table anchors: monthly left, annual center ("Most Popular"),
// Founding Pass right. Each tier has its own hosted Lemon Squeezy checkout so
// the plan selected in Twimark is the plan paid for at checkout.
const TWIMARK_PLANS = [
  {
    id: "monthly",
    checkoutUrl: "https://twimark.lemonsqueezy.com/checkout/buy/2ab824b7-c7ea-4654-970c-5ffb88a92390",
    title: "Monthly",
    badge: null,
    cta: "Select Pro",
    price: "$6",
    per: "/ month",
    billed: null,
    features: ["Research-Grade Structuring", "Unlimited bookmark exports"],
    callout: "Cancel anytime",
  },
  {
    id: "annual",
    checkoutUrl: "https://twimark.lemonsqueezy.com/checkout/buy/5e5bce00-0c50-40aa-9341-2d50e34ec31a",
    title: "Annual",
    badge: "Most Popular",
    cta: "Upgrade to Pro",
    price: "$4.08",
    per: "/ month",
    billed: "Billed as $49 annually",
    features: ["Research-Grade Structuring", "Unlimited bookmark exports"],
    callout: "Saves 32% compared to monthly",
  },
  {
    id: "lifetime",
    checkoutUrl: "https://twimark.lemonsqueezy.com/checkout/buy/607ea3fb-e923-4304-8037-a866c3a6e1c9",
    title: "Founding Pass",
    badge: "Early Adopter",
    cta: "Claim Pass",
    price: "$69",
    per: "one-time",
    billed: null,
    features: ["Lifetime access", "All future Twimark perks"],
    callout: "No recurring charges. Limited to the first 50 users.",
  },
];

// After a failed payment, Lemon Squeezy fires subscription_payment_failed; the
// gateway opens a 72h grace window and the popup shows a Payment issue banner
// pointing at the Lemon Squeezy customer portal for card updates.
const TWIMARK_GRACE_HOURS = 72;

// How often the popup re-syncs entitlement state while open (ms).
const TWIMARK_LICENSE_SYNC_INTERVAL_MS = 60_000;

// --- Free-tier truncation hook ----------------------------------------------
// Free exports are never fully blocked: the first posts of every thread are
// exported cleanly, later posts are replaced with a structured preview block.
const TWIMARK_FREE_POSTS_PER_THREAD = 3;

const TWIMARK_WITHHELD_BLOCK = [
  "---",
  "[Tweets {FROM}–{TO} withheld]",
  "💡 NotebookLM requires the full thread context to generate hallucination-free Audio Overviews and complete study guides.",
  "👉 Unlock complete thread structuring with Twimark Pro: https://twimark.lemonsqueezy.com/",
  "---",
].join("\n");

// --- Viral footer -------------------------------------------------------------
// Appended to every free export. Pro users can remove it in the popup.
const TWIMARK_ATTRIBUTION_FOOTER =
  "*Source compiled from X via [Twimark](https://twimark.app) — One-click research-grade exports for NotebookLM.*";
