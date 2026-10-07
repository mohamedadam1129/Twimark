// Twimark Pro licensing — shared between popup.js, background.js and tests.
// Checkout URLs and plan copy for the three pricing tiers.
// TS/JS shared so the same config drives both the pricing UI and background.js.

// The gateway Worker that verifies entitlements and owns the webhook receiver.
const TWIMARK_LICENSE_API_BASE = "https://twimark-license-gateway.twimarkworker.workers.dev";

// Pricing table anchors (psychological anchor: monthly left, annual center, lifetime right).
// Checkout URLs here must match the Lemon Squeezy store admin template links.
const TWIMARK_PLANS = [
  {
    id: "monthly",
    checkoutUrl: "https://twimark.lemonsqueezy.com/checkout/buy/MONTHLY-PLAN-UUID",
    title: "Monthly",
    badge: null,
    price: "$6",
    per: "/ month",
    billed: null,
    callout: "Cancel anytime",
  },
  {
    id: "annual",
    checkoutUrl: "https://twimark.lemonsqueezy.com/checkout/buy/ANNUAL-PLAN-UUID",
    title: "Annual",
    badge: "Most Popular",
    price: "$4.08",
    per: "/ month",
    billed: "Billed as $49 annually",
    callout: "Saves 32% compared to monthly",
  },
  {
    id: "lifetime",
    checkoutUrl: "https://twimark.lemonsqueezy.com/checkout/buy/LIFETIME-PLAN-UUID",
    title: "Lifetime",
    badge: "Early Adopter",
    price: "$69",
    per: "one-time",
    billed: null,
    callout: "No recurring charges. Only activation-based. Only available during initial launch window.",
  },
];

// After a failed payment, Lemon Squeezy fires subscription_payment_failed; the
// gateway opens a 72h grace window and the popup shows a Payment issue banner
// pointing at the Lemon Squeezy customer portal for card updates.
const TWIMARK_GRACE_HOURS = 72;

// How often the popup re-syncs entitlement state while open (ms).
const TWIMARK_LICENSE_SYNC_INTERVAL_MS = 60_000;
