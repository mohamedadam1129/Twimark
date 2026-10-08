// Twimark license gateway for Lemon Squeezy.
//
// Entitlements are decided HERE via webhooks, never inside the extension.
// The extension only reports which installation ID (device) is asking, and the
// gateway returns the entitlement state for that device.
//
// Cloudflare bindings (wrangler.toml):
//   DB                       D1 database (entitlement tables are created on demand)
//   LS_WEBHOOK_SECRET        Lemon Squeezy "Signing secret" (Settings → Webhooks)
//   LS_PRODUCT_ID            Lemon Squeezy product id (allow-list)
//   LS_VARIANT_MONTHLY_ID    Lemon Squeezy monthly subscription variant id
//   LS_VARIANT_ANNUAL_ID     Lemon Squeezy annual subscription variant id
//   LS_VARIANT_LIFETIME_ID   Lemon Squeezy lifetime (one-time) variant id
//   LS_CHECKOUT_MONTHLY_URL  Hosted / overlay checkout URL for the monthly plan
//   LS_CHECKOUT_ANNUAL_URL   Hosted / overlay checkout URL for the annual plan
//   LS_CHECKOUT_LIFETIME_URL Hosted / overlay checkout URL for the lifetime plan
//   LS_STORE_URL             Public Lemon Squeezy store URL (shown in copy only)
//   LEMON_API_KEY            Optional API key, used to look up live prices
//   ALLOWED_ORIGIN           Production Chrome extension origin
//   ALLOWED_ORIGIN_DEV       Packaged-but-unsigned dev extension origin (optional)
//
// Routes:
//   POST /webhooks          Lemon Squeezy webhook receiver. HMAC-SHA256 verified.
//   GET  /upgrade           Pricing page (monthly / annual / lifetime). Opens the
//                           Lemon Squeezy checkout in an embedded iframe when run
//                           standalone, or postMessages the checkout URL to the
//                           iframe's parent (the extension page) when embedded.
//   POST /activate          { email, installationId } → claims the parked purchase
//                           (lifetime order or subscription) for this device.
//   POST /validate          { email, installationId } → current entitlement state.
//   POST /deactivate        { email, installationId } → frees the device seat.

const GRACE_PERIOD_MS = 72 * 60 * 60 * 1000;           // 72h to update the card after a failed payment
const PAUSED_ACCESS_MS = 30 * 24 * 60 * 60 * 1000;     // max pro access while the subscription is paused
const CLAIM_LIMIT = 3;                                 // devices per purchase at most
const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;        // live price lookup refresh
const MEMORY_CACHE_LIMIT = 100;
const RATE_LIMIT = { windowMs: 60_000, max: 300 };     // per-IP, per-isolate soft limit

const SUBSCRIPTION_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_expired",
  "subscription_paused",
  "subscription_resumed",
  "subscription_payment_failed",
  "subscription_payment_success",
]);

const PAID_TIERS = new Set(["pro_monthly", "pro_annual", "pro_lifetime"]);

const PRICING_FALLBACK = {
  monthly: { cents: 600, price: "$6", per: "/ month", billed: null, callout: "Cancel anytime" },
  annual: { cents: 4900, price: "$4.08", per: "/ month", billed: "Billed as $49 annually", callout: "Saves 32% compared to monthly" },
  lifetime: { cents: 6900, price: "$69", per: "one-time", billed: null, callout: "No recurring charges. Only available during initial launch window." },
};

const priceCache = new Map();      // per-isolate memoization (pricing, claim-race guard, rate limit)

function jsonOf(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra },
  });
}

function errorJson(message, status = 400, extra = {}) {
  return jsonOf({ error: message }, status, extra);
}

const escapeHtml = (value, fallback = "") =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function timingSafeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cacheGet(key) {
  const entry = priceCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    priceCache.delete(key);
    return null;
  }
  return entry.value;
}

function cachePut(key, value, ttlMs) {
  if (priceCache.size >= MEMORY_CACHE_LIMIT) priceCache.clear();
  priceCache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

// Rate limiting: soft per-IP guard kept in the isolate's RAM. Real hard limits
// would need a Durable Object; this is enough for an accidental runaway loop.
const rateBuckets = new Map();
function rateLimitCheck(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, reset: now + RATE_LIMIT.windowMs };
  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + RATE_LIMIT.windowMs;
  }
  bucket.count += 1;
  if (rateBuckets.size >= MEMORY_CACHE_LIMIT) rateBuckets.clear();
  rateBuckets.set(ip, bucket);
  return bucket.count <= RATE_LIMIT.max;
}

// ---------------------------------------------------------------------------
// Emits a JSON response with CORS headers for the extension /dashboard origin.
// ---------------------------------------------------------------------------

function corsHeadersFor(request, env) {
  const origin = request.headers.get("Origin") || "";
  const isChromeExtension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (isChromeExtension || origin === env.ALLOWED_ORIGIN || origin === env.ALLOWED_ORIGIN_DEV) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
  }
  return null;
}

async function withCors(request, env, makeBody) {
  const headers = corsHeadersFor(request, env);
  if (!headers) return errorJson("Origin not allowed.", 403);
  const response = await makeBody();
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

// ---------------------------------------------------------------------------
// D1 access
// ---------------------------------------------------------------------------

async function readDeviceRow(db, installationId) {
  const row = await db
    .prepare("SELECT * FROM device_entitlements WHERE installation_id = ? LIMIT 1")
    .bind(installationId)
    .first();
  if (!row) return null;
  return {
    installationId: row.installation_id,
    email: row.user_email,
    proTier: row.pro_tier,
    expiresAtMs: row.expires_at_ms == null ? null : Number(row.expires_at_ms),
    subscriptionStatus: row.subscription_status || null,
    subscriptionId: row.subscription_id || null,
    renewsAt: row.renews_at || null,
    endsAt: row.ends_at || null,
    pauseMode: row.pause_mode || null,
    pauseResumesAt: row.pause_resumes_at || null,
    pauseStartedAtMs: row.pause_started_at_ms == null ? null : Number(row.pause_started_at_ms),
    graceUntilMs: row.grace_until_ms == null ? null : Number(row.grace_until_ms),
    lemonRef: row.lemon_ref || null,
    variantId: row.variant_id || null,
    customerPortalUrl: row.customer_portal_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeviceRow(row) {
  if (!row) return null;
  return {
    installationId: row.installation_id,
    email: row.user_email,
    proTier: row.pro_tier,
    expiresAtMs: row.expires_at_ms == null ? null : Number(row.expires_at_ms),
    subscriptionStatus: row.subscription_status || null,
    subscriptionId: row.subscription_id || null,
    renewsAt: row.renews_at || null,
    endsAt: row.ends_at || null,
    pauseMode: row.pause_mode || null,
    pauseResumesAt: row.pause_resumes_at || null,
    pauseStartedAtMs: row.pause_started_at_ms == null ? null : Number(row.pause_started_at_ms),
    graceUntilMs: row.grace_until_ms == null ? null : Number(row.grace_until_ms),
    lemonRef: row.lemon_ref || null,
    variantId: row.variant_id || null,
    customerPortalUrl: row.customer_portal_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readDeviceRowsByEmail(db, email) {
  const result = await db
    .prepare("SELECT * FROM device_entitlements WHERE user_email = ? ORDER BY updated_at DESC")
    .bind(email)
    .all();
  return (result.results || []).map(mapDeviceRow).filter(Boolean);
}

async function readUnclaimedByRef(db, lemonRef) {
  const row = await db
    .prepare("SELECT * FROM unclaimed_orders WHERE lemon_ref = ? LIMIT 1")
    .bind(lemonRef)
    .first();
  if (!row) return null;
  return {
    lemonRef: row.lemon_ref,
    email: row.user_email,
    proTier: row.pro_tier,
    variantId: row.variant_id || null,
    subscriptionId: row.subscription_id || null,
    renewsAt: row.renews_at || null,
    endsAt: row.ends_at || null,
    pauseMode: row.pause_mode || null,
    pauseResumesAt: row.pause_resumes_at || null,
    graceUntilMs: row.grace_until_ms == null ? null : Number(row.grace_until_ms),
    customerPortalUrl: row.customer_portal_url || null,
    status: row.status || null,
    claimedBy: row.claimed_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readUnclaimedByEmail(db, email) {
  const result = await db
    .prepare("SELECT * FROM unclaimed_orders WHERE user_email = ? ORDER BY created_at DESC")
    .bind(email)
    .all();
  return (result.results || []).filter(Boolean).map((row) => ({
    lemonRef: row.lemon_ref,
    email: row.user_email,
    proTier: row.pro_tier,
    variantId: row.variant_id || null,
    subscriptionId: row.subscription_id || null,
    renewsAt: row.renews_at || null,
    endsAt: row.ends_at || null,
    pauseMode: row.pause_mode || null,
    pauseResumesAt: row.pause_resumes_at || null,
    graceUntilMs: row.grace_until_ms == null ? null : Number(row.grace_until_ms),
    customerPortalUrl: row.customer_portal_url || null,
    status: row.status || null,
    claimedBy: row.claimedBy || row.claimed_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function upsertUnclaimedOrders(db, entry) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO unclaimed_orders (
         lemon_ref, user_email, pro_tier, variant_id, subscription_id, renews_at, ends_at,
         pause_mode, pause_resumes_at, grace_until_ms, customer_portal_url, status, claimed_by, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT(lemon_ref) DO UPDATE SET
         user_email = excluded.user_email,
         pro_tier = excluded.pro_tier,
         variant_id = excluded.variant_id,
         subscription_id = excluded.subscription_id,
         renews_at = excluded.renews_at,
         ends_at = excluded.ends_at,
         pause_mode = excluded.pause_mode,
         pause_resumes_at = excluded.pause_resumes_at,
         grace_until_ms = excluded.grace_until_ms,
         customer_portal_url = COALESCE(excluded.customer_portal_url, customer_portal_url),
         status = excluded.status,
         claimed_by = COALESCE(excluded.claimed_by, claimed_by),
         updated_at = excluded.updated_at`
    )
    .bind(
      entry.lemonRef,
      entry.email,
      entry.proTier,
      entry.variantId ?? null,
      entry.subscriptionId ?? null,
      entry.renewsAt ?? null,
      entry.endsAt ?? null,
      entry.pauseMode ?? null,
      entry.pauseResumesAt ?? null,
      entry.graceUntilMs ?? null,
      entry.customerPortalUrl ?? null,
      entry.status ?? null,
      entry.claimedBy ?? null,
      entry.createdAt || now,
      now
    )
    .run();
}

async function upsertDeviceEntitlement(db, claimed) {
  const now = new Date().toISOString();
  await db
    .prepare(upsertDeviceSql())
    .bind(
      claimed.installationId,
      claimed.email,
      claimed.proTier,
      claimed.expiresAtMs,
      claimed.subscriptionStatus,
      claimed.subscriptionId,
      claimed.renewsAt,
      claimed.endsAt,
      claimed.pauseMode,
      claimed.pauseResumesAt,
      claimed.pauseStartedAtMs,
      claimed.graceUntilMs,
      claimed.lemonRef,
      claimed.variantId,
      claimed.customerPortalUrl,
      claimed.createdAt || now,
      now
    )
    .run();
}

function upsertDeviceSql() {
  return `INSERT INTO device_entitlements (
      installation_id, user_email, pro_tier, expires_at_ms, subscription_status,
      subscription_id, renews_at, ends_at, pause_mode, pause_resumes_at, pause_started_at_ms,
      grace_until_ms, lemon_ref, variant_id, customer_portal_url, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    ON CONFLICT(installation_id) DO UPDATE SET
      user_email = excluded.user_email,
      pro_tier = excluded.pro_tier,
      expires_at_ms = excluded.expires_at_ms,
      subscription_status = excluded.subscription_status,
      subscription_id = excluded.subscription_id,
      renews_at = excluded.renews_at,
      ends_at = excluded.ends_at,
      pause_mode = excluded.pause_mode,
      pause_resumes_at = excluded.pause_resumes_at,
      pause_started_at_ms = excluded.pause_started_at_ms,
      grace_until_ms = excluded.grace_until_ms,
      lemon_ref = excluded.lemon_ref,
      variant_id = excluded.variant_id,
      customer_portal_url = excluded.customer_portal_url,
      updated_at = excluded.updated_at`;
}

async function claimUnclaimedOrder(db, lemonRef, installationId) {
  const result = await db
    .prepare("UPDATE unclaimed_orders SET claimed_by = ?2, updated_at = ?3 WHERE lemon_ref = ?1 AND claimed_by IS NULL")
    .bind(lemonRef, installationId, new Date().toISOString())
    .run();
  return result.meta?.changes === 1; // someone else claimed it concurrently if 0
}

async function releaseClaimedOrder(db, installationId) {
  await db
    .prepare("UPDATE unclaimed_orders SET claimed_by = NULL, updated_at = ?2 WHERE claimed_by = ?1")
    .bind(installationId, new Date().toISOString())
    .run();
}

async function deleteDeviceRow(db, installationId) {
  await db.prepare("DELETE FROM device_entitlements WHERE installation_id = ?").bind(installationId).run();
}

async function ensureEntitlementsSchema(db) {
  if (cacheGet("schema_ok")) return;
  for (const statement of SCHEMA_STATEMENTS) await db.prepare(statement).run();
  cachePut("schema_ok", true, 10 * 60_000);
}

// D1's prepare() accepts a single statement, so the schema is a list.
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS device_entitlements (
    installation_id TEXT PRIMARY KEY NOT NULL,
    user_email TEXT NOT NULL,
    pro_tier TEXT NOT NULL DEFAULT 'unpaid',
    expires_at_ms INTEGER,
    subscription_status TEXT,
    subscription_id TEXT,
    renews_at TEXT,
    ends_at TEXT,
    pause_mode TEXT,
    pause_resumes_at TEXT,
    pause_started_at_ms INTEGER,
    grace_until_ms INTEGER,
    lemon_ref TEXT,
    variant_id TEXT,
    customer_portal_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_device_entitlements_user_email ON device_entitlements (user_email)",
  "CREATE INDEX IF NOT EXISTS idx_device_entitlements_lemon_ref ON device_entitlements (lemon_ref)",
  `CREATE TABLE IF NOT EXISTS unclaimed_orders (
    lemon_ref TEXT PRIMARY KEY NOT NULL,
    user_email TEXT NOT NULL,
    pro_tier TEXT NOT NULL DEFAULT 'unpaid',
    variant_id TEXT,
    subscription_id TEXT,
    renews_at TEXT,
    ends_at TEXT,
    pause_mode TEXT,
    pause_resumes_at TEXT,
    grace_until_ms INTEGER,
    customer_portal_url TEXT,
    status TEXT,
    claimed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_unclaimed_orders_user_email ON unclaimed_orders (user_email)",
];

// ---------------------------------------------------------------------------
// Legacy Lemon Squeezy license-key bridge
// ---------------------------------------------------------------------------
// Products configured to issue license keys keep working: a receipt-button
// handoff or manual entry activates with { licenseKey, email } and is converted
// into the same unclaimed-order row a webhook would have created, then claimed
// for this installation. Email-only activations skip this entirely.
const LEMON_LICENSE_API = "https://api.lemonsqueezy.com/v1/licenses";

async function legacyLicenseValidate(env, licenseKey, email) {
  let response;
  try {
    response = await fetch(LEMON_LICENSE_API, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ license_key: licenseKey }),
    });
  } catch {
    return { ok: false, error: "Could not reach Lemon Squeezy to verify this license key. Try again shortly." };
  }
  const data = await response.json().catch(() => ({}));
  if (!data.valid && !data.activated) {
    return { ok: false, error: data.error || "This Twimark Pro license key is not valid." };
  }
  const meta = data.meta || {};
  if (String(meta.product_id) !== String(env.LS_PRODUCT_ID)) {
    return { ok: false, error: "This license key belongs to a different Twimark product." };
  }
  if (normalizeEmail(meta.customer_email || "") !== normalizeEmail(email)) {
    return { ok: false, error: "The checkout email does not match this license key." };
  }
  return { ok: true, license: data.license_key || {}, orderId: meta.order_id || null };
}

async function parkLegacyLicense(db, env, licenseKey, email) {
  const found = await legacyLicenseValidate(env, licenseKey, email);
  if (!found.ok) return found;
  const entry = {      lemonRef: `licenses/${licenseKey}`,
      email: normalizeEmail(email),
      proTier: "pro_lifetime", // legacy keys predate the three-tier pricing
      variantId: null,
      subscriptionId: null,
      renewsAt: null,
      endsAt: null,
      pauseMode: null,
      pauseResumesAt: null,
      graceUntilMs: null,
      customerPortalUrl: null,
      status: "active",
      claimedBy: null,
      createdAt: null,
      updatedAt: null,
  };
  await ensureEntitlementsSchema(db);
  await upsertUnclaimedOrders(db, entry);
  return found;
}

// ---------------------------------------------------------------------------
// Entitlement service (webhook → D1, claim → device row)
// ---------------------------------------------------------------------------

function tierForVariantId(env, variantId) {
  const id = variantId == null ? null : String(variantId);
  if (id === String(env.LS_VARIANT_LIFETIME_ID)) return "pro_lifetime";
  if (id === String(env.LS_VARIANT_ANNUAL_ID)) return "pro_annual";
  if (id === String(env.LS_VARIANT_MONTHLY_ID)) return "pro_monthly";
  return null;
}

function isTwimarkProduct(env, attributes) {
  const orderItemProductId = attributes.first_order_item?.product_id;
  return (
    String(attributes.product_id) === String(env.LS_PRODUCT_ID) ||
    String(orderItemProductId) === String(env.LS_PRODUCT_ID)
  );
}

// Extract { variantId, subscriptionId } from either a subscriptions payload or a
// subscription_invoices payload (LS uses different shapes per event).
function subscriptionIdentifiers(attributes) {
  if (attributes.subscription_id != null && attributes.type !== "subscriptions") {
    return { variantId: attributes.variant_id ?? null, subscriptionId: attributes.subscription_id };
  }
  return { variantId: attributes.variant_id ?? null, subscriptionId: attributes.id ?? null };
}

async function onOrderCreated(db, env, attributes) {
  const variantId = attributes.first_order_item?.variant_id;
  const tier = tierForVariantId(env, variantId);
  if (!tier) return; // paid for another product/variant we don't sell

  const entry = {
    lemonRef: `orders/${attributes.id}`,
    email: String(attributes.user_email).trim().toLowerCase(),
    proTier: tier,
    variantId: String(variantId),
    subscriptionId: null,
    renewsAt: null,
    endsAt: null,
    pauseMode: null,
    pauseResumesAt: null,
    graceUntilMs: null,
    status: attributes.status || "paid",
    claimedBy: null,
    createdAt: attributes.created_at,
    updatedAt: attributes.updated_at,
  };
  await ensureEntitlementsSchema(db);
  await upsertUnclaimedOrders(db, entry);
}

async function onSubscriptionEvent(db, env, eventName, attributes) {
  const { variantId, subscriptionId } = subscriptionIdentifiers(attributes);
  const lemonRef = `subscriptions/${subscriptionId}`;
  const email = String(attributes.user_email || "").trim().toLowerCase();
  const webhookTier = tierForVariantId(env, variantId);

  await ensureEntitlementsSchema(db);

  const deviceRow = await readDeviceRowByLemonRef(db, lemonRef);
  const parked = await readUnclaimedByRef(db, lemonRef);

  const patch = {
    subscriptionStatus: String(attributes.status || "").toLowerCase() || null,
    renewsAt: attributes.renews_at || null,
    endsAt: attributes.ends_at || null,
    pauseMode: attributes.pause?.mode || null,
    pauseResumesAt: attributes.pause?.resumes_at || null,
    graceUntilMs: webhookTier === "pro_lifetime" ? null : null,
    variantId: variantId == null ? null : String(variantId),
    customerPortalUrl: attributes.urls?.customer_portal || null,
  };

  if (!deviceRow && !parked) {
    const tier = webhookTier || tierFromStoredVariant(env, null);
    if (!tier || !SUBSCRIPTION_EVENTS.has(eventName)) return;
    // A subscription event showed up for an email we've never parked: create the
    // claim row so a later /activate can pick it up (typical final flow).
    await upsertUnclaimedOrders(db, {
      lemonRef,
      email,
      proTier: tier,
      variantId: patch.variantId,
      subscriptionId: String(subscriptionId),
      renewsAt: patch.renewsAt,
      endsAt: patch.endsAt,
      pauseMode: patch.pauseMode,
      pauseResumesAt: patch.pauseResumesAt,
      graceUntilMs: null,
      customerPortalUrl: patch.customerPortalUrl,
      status: patch.subscriptionStatus,
      claimedBy: null,
      createdAt: attributes.created_at,
      updatedAt: attributes.updated_at,
    });
    return;
  }

  // Payment-specific handling first, generic else.
  if (eventName === "subscription_payment_failed") {
    patch.subscriptionStatus = "payment_failed";
    patch.graceUntilMs = Date.now() + GRACE_PERIOD_MS;
  }
  if (eventName === "subscription_payment_success") {
    patch.subscriptionStatus = "active";
    patch.graceUntilMs = null;
  }

  const downgrade =
    eventName === "subscription_cancelled" ||
    eventName === "subscription_expired" ||
    ((patch.subscriptionStatus === "cancelled" || patch.subscriptionStatus === "expired") &&
      (patch.endsAt != null || attributes.cancelled === true));
  if (downgrade) patch.proTier = "unpaid";
  else if (webhookTier) patch.proTier = webhookTier;
  else patch.proTier = null; // keep the row's existing tier

  const pausePatch = attributes.pause || null;
  if (pausePatch) {
    patch.pauseMode = pausePatch.mode || "void";
    patch.pauseResumesAt = pausePatch.resumes_at || null;
    patch.pauseStartedAtMs = Date.now();
  } else if (eventName === "subscription_resumed" || patch.pauseMode === null) {
    patch.pauseMode = null;
    patch.pauseResumesAt = null;
    patch.pauseStartedAtMs = null;
  }

  if (deviceRow) {
    await upsertDeviceEntitlement(db, mergeDevicePatch(deviceRow, patch));
  }
  // Always refresh the parked row too, so re-claiming on a new device gets
  // current truth (renews_at, portal link, cancelled state …).
  await upsertUnclaimedOrders(db, {
    lemonRef,
    email: deviceRow?.email || parked.email,
    proTier: patch.proTier || deviceRow?.proTier || parked.proTier,
    variantId: patch.variantId || deviceRow?.variantId || parked.variantId,
    subscriptionId: String(subscriptionId),
    renewsAt: patch.renewsAt,
    endsAt: patch.endsAt,
    pauseMode: patch.pauseMode,
    pauseResumesAt: patch.pauseResumesAt,
    graceUntilMs: patch.graceUntilMs,
    customerPortalUrl: patch.customerPortalUrl,
    status: patch.subscriptionStatus,
    claimedBy: deviceRow ? String(deviceRow.installationId) : parked.claimedBy,
    createdAt: parked.createdAt,
    updatedAt: attributes.updated_at,
  });
}

function tierFromStoredVariant() {
  return null; // unsupported variant id: cannot infer a tier
}

async function readDeviceRowByLemonRef(db, lemonRef) {
  const result = await db
    .prepare("SELECT * FROM device_entitlements WHERE lemon_ref = ? LIMIT 1")
    .bind(lemonRef)
    .first();
  if (!result) return null;
  return {
    installationId: result.installation_id,
    email: result.user_email,
    proTier: result.pro_tier,
    expiresAtMs: result.expires_at_ms == null ? null : Number(result.expires_at_ms),
    subscriptionStatus: result.subscription_status || null,
    subscriptionId: result.subscription_id || null,
    renewsAt: result.renews_at || null,
    endsAt: result.ends_at || null,
    pauseMode: result.pause_mode || null,
    pauseResumesAt: result.pause_resumes_at || null,
    pauseStartedAtMs: result.pause_started_at_ms == null ? null : Number(result.pause_started_at_ms),
    graceUntilMs: result.grace_until_ms == null ? null : Number(result.grace_until_ms),
    lemonRef: result.lemon_ref || null,
    variantId: result.variant_id || null,
    customerPortalUrl: result.customer_portal_url || null,
    createdAt: result.created_at,
    updatedAt: result.updated_at,
  };
}

// The webhook patch is the source of truth for refreshable fields: an explicit
// null in the patch CLEARS the stored value (e.g. pause fields on resume,
// grace on payment_success). Only identity fields fall back to the row.
function mergeDevicePatch(existing, patch) {
  return {
    ...existing,
    proTier: patch.proTier || existing.proTier,
    expiresAtMs: patch.proTier === "unpaid" ? Date.now() : existing.expiresAtMs,
    subscriptionStatus: patch.subscriptionStatus,
    subscriptionId: patch.subscriptionId || existing.subscriptionId,
    renewsAt: patch.renewsAt,
    endsAt: patch.endsAt,
    pauseMode: patch.pauseMode,
    pauseResumesAt: patch.pauseResumesAt,
    pauseStartedAtMs: patch.pauseStartedAtMs,
    graceUntilMs: patch.graceUntilMs,
    variantId: patch.variantId || existing.variantId,
    customerPortalUrl: patch.customerPortalUrl || existing.customerPortalUrl,
    createdAt: existing.createdAt,
    updatedAt: existing.updatedAt,
  };
}

// Derive the public entitlement state for a device row.
function entitlementState(ent, now = Date.now()) {
  if (!ent?.proTier || ent.proTier === "unpaid") {
    const status = String(ent?.subscriptionStatus || "").toLowerCase();
    const ended = ["cancelled", "expired", "refunded", "payment_failed", "suspended"].includes(status)
      && (!(ent?.graceUntilMs) || ent.graceUntilMs <= now);
    return { pro: false, tier: "free", state: ended ? status : "unpaid" };
  }
  if (ent.proTier === "pro_lifetime") {
    return { pro: true, tier: ent.proTier, state: "lifetime" };
  }

  const status = String(ent.subscriptionStatus || "").toLowerCase();
  const endsAtMs = ent.endsAt ? new Date(ent.endsAt).getTime() : null;

  if (status === "paused") {
    const resumesAtMs = ent.pauseResumesAt ? new Date(ent.pauseResumesAt).getTime() : null;
    const pauseAlive = !resumesAtMs || resumesAtMs > now;
    const withinPauseWindow = !ent.pauseStartedAtMs || now - ent.pauseStartedAtMs <= PAUSED_ACCESS_MS;
    if (pauseAlive && withinPauseWindow) {
      return { pro: true, tier: ent.proTier, state: "paused" };
    }
    return { pro: false, tier: "free", state: "paused" };
  }

  if (status === "payment_failed") {
    if (ent.graceUntilMs && ent.graceUntilMs > now) {
      return { pro: true, tier: ent.proTier, state: "grace" };
    }
    return { pro: false, tier: "free", state: "suspended" };
  }

  const cancelledDone =
    (status === "cancelled" || status === "expired") && (endsAtMs == null || endsAtMs <= now);
  if (cancelledDone) {
    return { pro: false, tier: "free", state: "expired" };
  }

  const pastDue = status === "past_due" || status === "unpaid";
  if (pastDue && !(ent.graceUntilMs && ent.graceUntilMs > now)) {
    return { pro: false, tier: "free", state: "suspended" };
  }

  // active / on_trial / past_due-with-grace: pro while the period end is live.
  const periodEndMs = ent.renewsAt ? new Date(ent.renewsAt).getTime() : ent.expiresAtMs;
  if (!periodEndMs || periodEndMs > now) {
    return { pro: true, tier: ent.proTier, state: status === "on_trial" ? "trial" : "active" };
  }
  if (now - periodEndMs <= GRACE_PERIOD_MS) {
    // Renewal webhook lag / card retry: don't cut a paying customer off abruptly.
    return { pro: true, tier: ent.proTier, state: "grace" };
  }
  return { pro: false, tier: "free", state: status || "expired" };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

async function verifyLemonSignature(request, rawBody, env) {
  const provided = (request.headers.get("X-Signature") || "").toLowerCase();
  if (!provided) return false;
  const expected = await hmacHex(env.LS_WEBHOOK_SECRET, rawBody);
  return timingSafeEqual(expected, provided);
}

async function webhookHandler(request, env) {
  try {
    if (!env.LS_WEBHOOK_SECRET) return errorJson("Webhook signing secret is not configured.", 500);

    const rawBody = await request.text();
    if (!rawBody || rawBody.length > 1_000_000) return errorJson("Invalid webhook body.", 400);

    if (!(await verifyLemonSignature(request, rawBody, env))) {
      return errorJson("Invalid webhook signature.", 401);
    }

    const payload = JSON.parse(rawBody);
    const eventName = payload?.meta?.event_name;
    const attributes = payload?.data?.attributes || {};
    const db = env.DB;

    if (eventName === "order_created") {
      if (isTwimarkProduct(env, attributes)) await onOrderCreated(db, env, attributes);
      return jsonOf({ ok: true });
    }
    if (eventName === "order_refunded" || eventName === "subscription_payment_refunded") {
      await onRefund(db, env, attributes);
      return jsonOf({ ok: true });
    }
    if (SUBSCRIPTION_EVENTS.has(eventName)) {
      if (isTwimarkProduct(env, attributes)) await onSubscriptionEvent(db, env, eventName, attributes);
      return jsonOf({ ok: true });
    }
    return jsonOf({ ok: true, ignored: eventName || "unknown_event" });
  } catch (error) {
    return errorJson(`Webhook failed: ${error?.message || "unknown error"}`, 500);
  }
}

async function onRefund(db, env, attributes) {
  const variantId = attributes.first_order_item?.variant_id ?? attributes.variant_id ?? null;
  const email = String(attributes.user_email || "").trim().toLowerCase();
  const tier = tierForVariantId(env, variantId);
  if (!email) return;

  await ensureEntitlementsSchema(db);
  const deviceRows = await readDeviceRowsByEmail(db, email);
  for (const row of deviceRows) {
    if (tier && row.proTier !== tier) continue; // refund hit another plan
    if (!tier && row.lemonRef !== `orders/${attributes.id}`) continue;
    await upsertDeviceEntitlement(db, {
      ...row,
      proTier: "unpaid",
      expiresAtMs: Date.now(),
      graceUntilMs: null,
      subscriptionStatus: "refunded",
    });
  }
  const parkedRows = await readUnclaimedByEmail(db, email);
  for (const row of parkedRows) {
    if (tier && row.proTier !== tier) continue;
    if (!tier && row.lemonRef !== `orders/${attributes.id}`) continue;
    await upsertUnclaimedOrders(db, { ...row, proTier: "unpaid", status: "refunded", claimedBy: row.claimedBy });
  }
}

// ---------------------------------------------------------------------------
// Extension-facing routes
// ---------------------------------------------------------------------------

const INSTALLATION_ID_PATTERN = /^[0-9a-fA-F-]{16,100}$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function readDeviceEntitlement(document, installationId, email) {
  return null;
}

async function activationHandler(request, env) {
  return withCors(request, env, async () => {
    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    if (!email.includes("@")) return errorJson("A valid email is required.", 400);
    const installationId = String(body.installationId || "");
    if (!INSTALLATION_ID_PATTERN.test(installationId)) {
      return errorJson("A valid installation identifier is required.", 400);
    }

    const db = env.DB;
    await ensureEntitlementsSchema(db);

    const already = await readDeviceRow(db, installationId);
    if (already && normalizeEmail(already.email) === email) {
      return jsonOf(profResponse(already));
    }
    if (already && normalizeEmail(already.email) !== email) {
      return errorJson("This device is already registered to a different email.", 409);
    }

    const parkedRows = await readUnclaimedByEmail(db, email);

    // Legacy bridge: a receipt-button handoff (or manual "Log in") may present
    // a { licenseKey, email } pair. Validate it against Lemon Squeezy, park it
    // as a lifetime-equivalent purchase, and let the normal claim flow proceed.
    if (typeof body.licenseKey === "string" && body.licenseKey.trim() && parkedRows.length === 0) {
      const parkedLegacy = await parkLegacyLicense(db, env, body.licenseKey.trim(), email);
      if (!parkedLegacy.ok) return errorJson(parkedLegacy.error, 403);
      parkedRows.push(...(await readUnclaimedByEmail(db, email)));
    }

    const claimable =
      parkedRows.find((row) => !row.claimedBy && row.proTier === "pro_lifetime") ||
      parkedRows.find((row) => !row.claimedBy && row.proTier === "pro_annual") ||
      parkedRows.find((row) => !row.claimedBy && row.proTier === "pro_monthly") ||
      parkedRows.find((row) => !row.claimedBy) ||
      null;

    if (!claimable) {
      const friends = parkedRows.filter((row) => row.claimedBy === installationId);
      const existingElsewhere = await readDeviceRow(db, installationId);
      if (!existingElsewhere) {
        return jsonOf({
          ok: true,
          claimed: false,
          pro: false,
          tier: "free",
          state: "no_purchase_found",
        });
      }
      return jsonOf(profResponse(existingElsewhere));
    }

    const emailDeviceCount = (await readDeviceRowsByEmail(db, email)).filter(
      (row) => row.installationId !== installationId
    ).length;
    if (emailDeviceCount >= CLAIM_LIMIT) {
      return errorJson(
        `This email has already activated Twimark Pro on ${CLAIM_LIMIT} devices. Deactivate one first or contact support.`,
        409
      );
    }

    const claimedNow = await claimUnclaimedOrder(db, claimable.lemonRef, installationId);
    if (!claimedNow) {
      return errorJson("Someone just claimed this purchase. Try again or contact support.", 409);
    }

    const entitlement = {
      installationId,
      email,
      proTier: claimable.proTier,
      expiresAtMs: claimable.renewsAt ? new Date(claimable.renewsAt).getTime() : null,
      subscriptionStatus: claimable.status || null,
      subscriptionId: claimable.subscriptionId,
      renewsAt: claimable.renewsAt,
      endsAt: claimable.endsAt,
      pauseMode: claimable.pauseMode,
      pauseResumesAt: claimable.pauseResumesAt,
      pauseStartedAtMs: claimable.pauseMode ? Date.now() : null,
      graceUntilMs: claimable.graceUntilMs ?? null,
      lemonRef: claimable.lemonRef,
      variantId: claimable.variantId,
      customerPortalUrl: claimable.customerPortalUrl || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await upsertDeviceEntitlement(db, entitlement);

    const saved = await readDeviceRow(db, installationId);
    return jsonOf(profResponse(saved || entitlement));
  });
}

function profResponse(ent) {
  const state = entitlementState(ent);
  return {
    ok: true,
    claimed: true,
    pro: state.pro,
    tier: state.tier,
    state: state.state,
    renewsAt: ent.renewsAt || null,
    endsAt: ent.endsAt || null,
    graceUntilMs: state.state === "grace" ? ent.graceUntilMs : null,
    portalUrl: ent.customerPortalUrl || null,
    variantId: ent.variantId || null,
  };
}

async function validateHandler(request, env) {
  return withCors(request, env, async () => {
    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const installationId = String(body?.installationId || "");
    if (!email.includes("@") || !INSTALLATION_ID_PATTERN.test(installationId)) {
      return errorJson("A valid email and installation identifier are required.", 400);
    }

    const db = env.DB;
    await ensureEntitlementsSchema(db);
    const row = await readDeviceRow(db, installationId);
    if (!row || normalizeEmail(row.email) !== email) {
      return jsonOf({
        ok: true,
        claimed: false,
        pro: false,
        tier: "free",
        state: row ? "email_mismatch" : "no_purchase_found",
      });
    }
    return jsonOf(profResponse(row));
  });
}

async function deactivateHandler(request, env) {
  return withCors(request, env, async () => {
    const body = await request.json().catch(() => null);
    const email = normalizeEmail(body?.email);
    const installationId = String(body?.installationId || "");
    if (!email.includes("@") || !INSTALLATION_ID_PATTERN.test(installationId)) {
      return errorJson("A valid email and installation identifier are required.", 400);
    }

    const db = env.DB;
    await ensureEntitlementsSchema(db);
    const row = await readDeviceRow(db, installationId);
    if (!row || normalizeEmail(row.email) !== email) {
      return errorJson("No active Pro license on this device.", 404);
    }

    await deleteDeviceRow(db, installationId);
    await releaseClaimedOrder(db, installationId);
    return jsonOf({ ok: true, deactivated: true });
  });
}

// ---------------------------------------------------------------------------
// /upgrade — in-place overlay pricing page (Monthly / Annual / Lifetime)
// ---------------------------------------------------------------------------

const UPGRADE_PLANS = [
  {
    id: "monthly",
    title: "Monthly",
    badge: null,
    cta: "Select Pro",
    per: "/ month",
    billed: null,
    callout: "Cancel anytime",
    features: ["Research-Grade Structuring", "Unlimited bookmark exports"],
    envName: "LS_CHECKOUT_MONTHLY_URL",
  },
  {
    id: "annual",
    title: "Annual",
    badge: "Most Popular",
    cta: "Upgrade to Pro",
    per: "/ month",
    billed: "Billed as $49 annually",
    callout: "Saves 32% compared to monthly",
    features: ["Research-Grade Structuring", "Unlimited bookmark exports"],
    envName: "LS_CHECKOUT_ANNUAL_URL",
  },
  {
    id: "lifetime",
    title: "Founding Pass",
    badge: "Early Adopter",
    cta: "Claim Pass",
    features: ["Lifetime access", "All future Twimark perks"],
    callout: "No recurring charges. Limited to the first 50 users.",
    envName: "LS_CHECKOUT_LIFETIME_URL",
  },
];

async function fetchLivePrices(env) {
  if (!env.LEMON_API_KEY) return {};
  const cached = cacheGet("live_prices");
  if (cached) return cached;
  const livePrices = {};
  const pairs = [
    ["monthly", env.LS_VARIANT_MONTHLY_ID],
    ["annual", env.LS_VARIANT_ANNUAL_ID],
    ["lifetime", env.LS_VARIANT_LIFETIME_ID],
  ];
  for (const [tier, variantId] of pairs) {
    if (!variantId) continue;
    const response = await fetch(`https://api.lemonsqueezy.com/v1/variants/${variantId}`, {
      headers: { Authorization: `Bearer ${env.LEMON_API_KEY}`, Accept: "application/json" },
    }).catch(() => null);
    if (!response?.ok) continue;
    const data = await response.json().catch(() => null);
    const cents = Math.round(Number(data?.data?.attributes?.price));
    if (!Number.isFinite(cents) || cents <= 0) continue;
    livePrices[tier] = { cents };
  }
  if (Object.keys(livePrices).length === pairs.filter(([tier, id]) => !!id).length) {
    livePrices.annual.perMonth = Math.round((livePrices.annual.cents / 12) * 100) / 100;
    cachePut("live_prices", livePrices, PRICE_CACHE_TTL_MS);
  }
  return livePrices;
}

function planCopy(tier, live, plan) {
  const fallback = PRICING_FALLBACK[tier];
  if (live) {
    const dollars = (live.cents / 100).toFixed(2).replace(/\.00$/, "");
    return {
      price: dollars,
      per: plan?.per || fallback.per,
      billed: plan?.billed || fallback.billed,
      callout: plan?.callout || fallback.callout,
    };
  }
  return {
    price: fallback.price,
    per: plan?.per || fallback.per,
    billed: plan?.billed || fallback.billed,
    callout: plan?.callout || fallback.callout,
  };
}

function renderUpgradePage(request, env, livePrices) {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id") || "";
  const email = url.searchParams.get("email") || "";
  const emailPresent = email.includes("@");

  const cards = UPGRADE_PLANS.map((plan) => {
    const live = livePrices[plan.id];
    const copy = planCopy(plan.id, live, plan);
    const checkoutUrl = env[plan.envName] || env.LS_STORE_URL || "";
    if (!checkoutUrl) return ""; // no checkout configured: hide the card
    const featureItems = (plan.features || []).map((feature) => `<li>${escapeHtml(feature)}</li>`).join("");
    return `
      <section class="plan${plan.badge ? " anchor" : ""}" data-plan="${plan.id}">
        ${plan.badge ? `<span class="badge">${escapeHtml(plan.badge)}</span>` : ""}
        <h2>${escapeHtml(plan.title)}</h2>
        <p class="price">${escapeHtml(copy.price)} <small>${escapeHtml(copy.per)}</small></p>
        ${copy.billed ? `<p class="billed">${escapeHtml(copy.billed)}</p>` : ""}
        <ul class="features">${featureItems}</ul>
        <p class="callout">${escapeHtml(copy.callout)}</p>
        <button class="buy" type="button" data-checkout="${escapeHtml(checkoutUrl)}" data-plan="${plan.id}">
          ${escapeHtml(plan.cta)}
        </button>
      </section>`;
  }).join("");

  const lsStore = escapeHtml(env.LS_STORE_URL || "");
  const csp = [
    "default-src 'self'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    `frame-src https://*.lemonsqueezy.com ${lsStore ? `https://${lsStore.replace(/^https?:\/\//, "")}` : ""}`.trim(),
    "connect-src https://*.lemonsqueezy.com",
  ].join("; ");

  const script = `
    (function () {
      var email = ${JSON.stringify(emailPresent ? email : "")};
      var installationId = ${JSON.stringify(installationId)};
      function checkoutUrl(baseUrl, plan) {
        var url = baseUrl;
        var join = url.indexOf('?') === -1 ? '?' : '&';
        url += join + 'checkout%5Bcustom%5D%5Btwimark_installation_id%5D=' + encodeURIComponent(installationId);
        url += '&checkout%5Bcustom%5D%5Btwimark_plan%5D=' + encodeURIComponent(plan);
        if (email) url += '&checkout%5Bprefill%5D%5Bemail%5D=' + encodeURIComponent(email);
        url += '&embed=1';
        return url;
      }
      function open(plan, baseUrl, me) {
        if (me !== window.parent && window.parent) {
          window.parent.postMessage({ type: 'twimark:openCheckout', url: checkoutUrl(baseUrl, plan) }, '*');
        } else {
          window.open(checkoutUrl(baseUrl, plan), '_blank');
        }
      }
      document.querySelectorAll('.buy').forEach(function (btn) {
        btn.addEventListener('click', function (event) {
          open(event.currentTarget.dataset.plan, event.currentTarget.dataset.checkout, window);
        });
      });
    })();
  `;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upgrade to Twimark Pro</title>
<style>
  body { margin:0; background:#f4f7fb; color:#172033; font:14px system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:760px; margin:0 auto; padding:26px 20px; }
  .eyebrow { color:#177bc5; font-size:11px; font-weight:800; letter-spacing:.8px; text-transform:uppercase; margin:0 0 6px; text-align:center; }
  h1 { margin:0 0 6px; font-size:24px; letter-spacing:-.4px; text-align:center; }
  .sub { margin:0 0 20px; color:#607084; font-size:13px; text-align:center; }
  .plans { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; align-items:stretch; }
  .plan { display:flex; flex-direction:column; padding:16px; border:1px solid #dbe5f1; border-radius:16px; background:#fff; position:relative; }
  .plan.anchor { border:2px solid #1d9bf0; box-shadow:0 14px 30px rgba(29,155,240,.18); }
  .plan .badge { position:absolute; top:-11px; left:14px; border-radius:99px; padding:3px 10px; background:#1d9bf0; color:#fff; font-size:10px; font-weight:800; letter-spacing:.5px; }
  .plan h2 { margin:10px 0 0; font-size:15px; }
  .price { margin:10px 0 2px; font-size:28px; font-weight:850; }
  .price small { font-size:12px; color:#607084; font-weight:600; }
  .billed, .callout { color:#607084; font-size:11px; margin:2px 0; }
  .callout { margin-top:auto; padding-top:10px; font-weight:600; color:#236241; }
  .features { margin:8px 0 0; padding:0 0 0 16px; color:#42546a; font-size:11px; }
  .features li { margin:3px 0; }
  .buy { margin-top:12px; min-height:40px; border:0; border-radius:10px; font:inherit; font-weight:750; cursor:pointer; background:linear-gradient(135deg,#1d9bf0,#2572d6); color:#fff; }
  .plan:not(.anchor) .buy { background:#fff; color:#172033; border:1px solid #d8e2ec; }
  @media (max-width:640px) { .plans { grid-template-columns:1fr; } }
  .note { margin-top:18px; color:#76869a; font-size:11px; text-align:center; }
</style></head><body><div class="wrap">
<p class="eyebrow">Twimark Pro</p>
<h1>Unlock your entire bookmark vault</h1>
<p class="sub">Full-library exports, Smart Thread Stitching, and one-click incremental sync for NotebookLM.</p>
<div class="plans">${cards}</div>
<p class="note">Prices shown are estimates. Checkout displays the final price including tax.</p>
</div><script>${script}</script></body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": csp,
        "Referrer-Policy": "no-referrer",
      },
    }
  );
}

async function upgradeHandler(request, env) {
  const livePrices = await fetchLivePrices(env);
  return renderUpgradePage(request, env, livePrices);
}

// ---------------------------------------------------------------------------
// GET /activate — Lemon Squeezy receipt-button handoff page.
// The store replaces [license_key] / [email] placeholders after purchase; this
// page relays the pair to the installed extension, which activates the device.
// ---------------------------------------------------------------------------

function handoffPage(env, licenseKey, email) {
  const data = JSON.stringify({ licenseKey, email }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activating Twimark Pro</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#f4f7fb;color:#172033;font:16px system-ui}.card{max-width:440px;margin:20px;padding:28px;border:1px solid #dbe5f1;border-radius:18px;background:#fff;box-shadow:0 16px 35px #23415a20}h1{margin:0 0 8px}p{line-height:1.5;color:#526477}</style><div class="card"><h1 id="title">Activating Twimark Pro…</h1><p id="message">Please keep this page open for a moment.</p></div><script>const purchase=${data};const title=document.getElementById('title');const message=document.getElementById('message');if(!globalThis.chrome?.runtime?.sendMessage){title.textContent='Open Twimark to activate';message.textContent='Twimark is not installed in this browser. Install it, then use the license key in your receipt.'}else{chrome.runtime.sendMessage('${env.EXTENSION_ID}',{action:'activate_purchase',...purchase},(result)=>{if(chrome.runtime.lastError||!result?.ok){title.textContent='Activation needs a quick retry';message.textContent=result?.error||'Open Twimark, choose “Log in for Pro”, and enter the email (and optional license key) from your receipt.';return}title.textContent='Twimark Pro is active!';message.textContent='Return to Twimark and export your full bookmark library.'})}</script></html>`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const ROOT_INFO = { ok: true, name: "twimark-license-gateway", version: 2 };

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "OPTIONS") {
    const headers = corsHeadersFor(request, env);
    return new Response(null, { status: headers ? 204 : 403, headers });
  }

  if (path === "/webhooks" && request.method === "POST") {
    return webhookHandler(request, env);
  }

  if (path === "/upgrade" && request.method === "GET") {
    return upgradeHandler(request, env);
  }

  if (path === "/activate" && request.method === "GET") {
    const licenseKey = url.searchParams.get("license_key") || "";
    const email = url.searchParams.get("email") || "";
    return new Response(handoffPage(env, licenseKey, email), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  }

  if (path === "/" && request.method === "GET") return jsonOf(ROOT_INFO);

  if (request.method !== "POST") return errorJson("Not found.", 404);
  if (!rateLimitCheck(request)) return errorJson("Too many activation checks. Try again shortly.", 429);

  if (path === "/activate") return activationHandler(request, env);
  if (path === "/validate") return validateHandler(request, env);
  if (path === "/deactivate") return deactivateHandler(request, env);
  return errorJson("Not found.", 404);
}

export default {
  async fetch(request, env) {
    try {
      if (!env || !env.DB) return errorJson("Server is not configured: missing D1 binding.", 500);
      return await handleRequest(request, env);
    } catch (error) {
      return errorJson(`Request failed: ${error?.message || "unknown error"}`, 500);
    }
  },
};
