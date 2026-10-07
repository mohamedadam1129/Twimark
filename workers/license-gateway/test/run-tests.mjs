// Run: node workers/license-gateway/test/run-tests.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { default: worker } = await import("../src/index.js");
const WORKER_URL = "http://worker.internal/";

// ---------------------------------------------------------------------------
// Fake D1: supports exactly the SQL the worker issues.
// ---------------------------------------------------------------------------

function fakeD1() {
  const tables = {
    device_entitlements: new Map(),
    unclaimed_orders: new Map(),
  };

  function findTable(sql) {
    if (/device_entitlements/i.test(sql)) return "device_entitlements";
    if (/unclaimed_orders/i.test(sql)) return "unclaimed_orders";
    throw new Error(`Unknown table in: ${sql.slice(0, 60)}`);
  }

  function runSelect(sql, bindings) {
    const table = findTable(sql);
    let rows = [...tables[table].values()];
    if (/WHERE\s+installation_id\s*=\s*\?/i.test(sql)) {
      rows = rows.filter((row) => row.installation_id === bindings[0]);
    } else if (/WHERE\s+lemon_ref\s*=\s*\?/i.test(sql)) {
      rows = rows.filter((row) => row.lemon_ref === bindings[0]);
    } else if (/WHERE\s+user_email\s*=\s*\?/i.test(sql)) {
      rows = rows.filter((row) => row.user_email === bindings[0]);
    }
    return rows;
  }

  function runUpdate(sql, bindings) {
    const table = findTable(sql);
    if (/SET\s+claimed_by\s*=\s*NULL/i.test(sql)) {
      let changed = 0;
      for (const row of tables[table].values()) {
        if (row.claimed_by === bindings[0]) {
          row.claimed_by = null;
          row.updated_at = bindings[1];
          changed += 1;
        }
        void table;
      }
      return { meta: { changes: changed } };
    }
    if (/SET\s+claimed_by\s*=\s*\?/i.test(sql)) {
      // UPDATE unclaimed_orders SET claimed_by = ?2, updated_at = ?3 WHERE lemon_ref = ?1 AND claimed_by IS NULL
      const [lemonRef, installationId, timestamp] = bindings;
      const row = tables.unclaimed_orders.get(lemonRef);
      if (!row || row.claimed_by) return { meta: { changes: 0 } };
      row.claimed_by = installationId;
      row.updated_at = timestamp;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unsupported UPDATE: ${sql.slice(0, 80)}`);
  }

  async function run(sql, bindings) {
    if (/^CREATE/i.test(sql)) return { meta: {} };
    if (/^INSERT/i.test(sql)) {
      const table = findTable(sql);
      const columns = sql.match(/\(([^)]+)\)\s*VALUES/i)[1].split(",").map((c) => c.trim());
      const values = {};
      columns.forEach((column, index) => { values[column] = bindings[index]; });
      const isUpsert = /ON CONFLICT/i.test(sql);
      if (isUpsert) {
        // ON CONFLICT(pk) DO UPDATE SET col = excluded.col ... (worker always sends every column)
        tables[table].set(values[Object.keys(values)[0]] && values.installation_id ? values.installation_id : values.lemon_ref, values);
        return { meta: { changes: 1 } };
      }
      tables[table].set(values.lemon_ref, values);
      return { meta: { changes: 1 } };
    }
    if (/^UPDATE/i.test(sql)) return runUpdate(sql, bindings);
    if (/^DELETE/i.test(sql)) {
      const table = findTable(sql);
      const existed = tables[table].delete(bindings[0]);
      return { meta: { changes: existed ? 1 : 0 } };
    }
    throw new Error(`Unsupported SQL: ${sql.slice(0, 60)}`);
  }

  return {
    tables,
    prepare(sql) {
      const bindings = [];
      const statement = {
        bind(...values) {
          bindings.push(...values);
          return statement; // mirrors real D1: bind() returns the statement
        },
        first: async () => (await runSelect(sql, bindings))[0] || null,
        all: async () => ({ results: await runSelect(sql, bindings) }),
        run: () => run(sql, bindings),
      };
      return statement;
    },
  };
}

// ---------------------------------------------------------------------------
// Env + helpers
// ---------------------------------------------------------------------------

const SECRET = "whsec_test_123";
const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const env = {
  DB: fakeD1(),
  LS_WEBHOOK_SECRET: SECRET,
  LS_PRODUCT_ID: "904561",
  LS_VARIANT_MONTHLY_ID: "111111",
  LS_VARIANT_ANNUAL_ID: "222222",
  LS_VARIANT_LIFETIME_ID: "333333",
  LS_CHECKOUT_MONTHLY_URL: "https://twimark.lemonsqueezy.com/checkout/buy/monthly",
  LS_CHECKOUT_ANNUAL_URL: "https://twimark.lemonsqueezy.com/checkout/buy/annual",
  LS_CHECKOUT_LIFETIME_URL: "https://twimark.lemonsqueezy.com/checkout/buy/lifetime",
  LS_STORE_URL: "https://twimark.lemonsqueezy.com/",
  LEMON_API_KEY: "",
  ALLOWED_ORIGIN: ORIGIN,
  ALLOWED_ORIGIN_DEV: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  EXTENSION_ID: ORIGIN.replace("chrome-extension://", ""),
};

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
}

function webhookBody(eventName, attributes, id) {
  return JSON.stringify({
    meta: { event_name: eventName, test_mode: false },
    data: { type: "orders", id, attributes },
  });
}

async function postWebhook(eventName, attributes, id = "1") {
  const body = webhookBody(eventName, attributes, id);
  const response = await worker.fetch(new Request(`${WORKER_URL}webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": sign(body) },
    body,
  }), env);
  if (response.status !== 200) {
    throw new Error(`webhook ${eventName} failed: ${await response.text()}`);
  }
  return response.json();
}

async function post(route, payload, origin = ORIGIN) {
  return worker.fetch(new Request(`${WORKER_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(payload),
  }), env);
}

async function readJson(response) {
  return response.json();
}

const INSTALLATION = "01234567-89ab-cdef-0123-456789abcdef";
const INSTALLATION2 = "fedcba98-7654-3210-fedcba98-76543210";
const EMAIL = "researcher@example.com";

const LIFETIME_ORDER = {
  id: "7001",
  store_id: 1,
  user_email: EMAIL,
  user_name: "Researcher",
  status: "paid",
  product_id: 904561,
  first_order_item: { product_id: 904561, variant_id: 333333, variant_name: "Lifetime" },
};

const MONTHLY_SUB = {
  id: "8001",
  store_id: 1,
  order_id: 42,
  product_id: 904561,
  variant_id: 111111,
  user_email: EMAIL,
  user_name: "Researcher",
  status: "active",
  cancelled: false,
  pause: null,
  renews_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  ends_at: null,
  urls: { customer_portal: "https://twimark.lemonsqueezy.com/billing?expires=1&signature=x" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("rejects webhooks with a bad signature", async () => {
  const body = webhookBody("order_created", LIFETIME_ORDER, "9001");
  const response = await worker.fetch(new Request(`${WORKER_URL}webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": "deadbeef" },
    body,
  }), env);
  assert.equal(response.status, 401);
});

test("rejects webhooks with a missing signature", async () => {
  const response = await worker.fetch(new Request(`${WORKER_URL}webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: webhookBody("order_created", LIFETIME_ORDER, "9002"),
  }), env);
  assert.equal(response.status, 401);
});

test("ignores events for other products", async () => {
  const payload = await postWebhook("order_created", { ...LIFETIME_ORDER, product_id: 999, first_order_item: { product_id: 999, variant_id: 333333 } }, "7000");
  assert.equal(payload.ok, true);
  const validate = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION }));
  assert.equal(validate.claimed, false);
});

test("rejects device routes from disallowed origins", async () => {
  const response = await post("validate", { email: EMAIL, installationId: INSTALLATION }, "https://evil.example.com");
  assert.equal(response.status, 403);
});

test("GET /activate renders the receipt handoff page", async () => {
  const response = await worker.fetch(new Request(`${WORKER_URL}activate?license_key=LSN-S-TEST&email=${encodeURIComponent(EMAIL)}`), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Activating Twimark Pro/);
  assert.match(html, /activate_purchase/);
});

test("order_created for the lifetime variant parks a claim, /activate claims it", async () => {
  await postWebhook("order_created", LIFETIME_ORDER, "7001");
  const before = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION }));
  assert.equal(before.claimed, false);

  const activation = await readJson(await post("activate", { email: EMAIL, installationId: INSTALLATION }));
  assert.equal(activation.ok, true);
  assert.equal(activation.pro, true);
  assert.equal(activation.tier, "pro_lifetime");
  assert.equal(activation.state, "lifetime");

  const after = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION }));
  assert.equal(after.pro, true);
  assert.equal(after.tier, "pro_lifetime");
});

test("subscription_created parks a monthly claim, /activate claims it", async () => {
  await postWebhook("subscription_created", { ...MONTHLY_SUB }, "8001");
  const activation = await readJson(await post("activate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(activation.pro, true);
  assert.equal(activation.tier, "pro_monthly");
  assert.equal(activation.state, "active");
  assert.equal(activation.portalUrl, MONTHLY_SUB.urls.customer_portal);
});

test("subscription_cancelled downgrades the device to free", async () => {
  await postWebhook("subscription_cancelled", {
    ...MONTHLY_SUB,
    status: "cancelled",
    cancelled: true,
    ends_at: new Date(Date.now() - 86_400_000).toISOString(),
  }, "8001");
  const data = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(data.pro, false);
  assert.equal(data.tier, "free");
  assert.equal(data.state, "cancelled");
});

test("payment failure opens a 72h grace window; recovery closes it", async () => {
  await postWebhook("subscription_payment_failed", { ...MONTHLY_SUB, status: "past_due" }, "8001");
  const during = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(during.pro, true);
  assert.equal(during.state, "grace");
  assert.ok(during.graceUntilMs > Date.now());

  await postWebhook("subscription_payment_success", { ...MONTHLY_SUB, status: "active" }, "8001");
  const after = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(after.pro, true);
  assert.equal(after.state, "active");
  assert.equal(after.graceUntilMs, null);
});

test("pause keeps access, resume restores active state", async () => {
  await postWebhook("subscription_paused", {
    ...MONTHLY_SUB, status: "paused", pause: { mode: "void", resumes_at: null },
  }, "8001");
  const during = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(during.pro, true);
  assert.equal(during.state, "paused");

  await postWebhook("subscription_resumed", { ...MONTHLY_SUB, status: "active", pause: null }, "8001");
  const after = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(after.state, "active");
  assert.equal(after.tier, "pro_monthly");
});

test("refund downgrades a lifetime device to free", async () => {
  const refundEmail = "refundee@example.com";
  await postWebhook("order_created", {
    ...LIFETIME_ORDER, id: "7100", user_email: refundEmail,
  }, "7100");
  const claimed = await readJson(await post("activate", { email: refundEmail, installationId: "aabbccdd-0011-2233-4455-66778899aabb" }));
  assert.equal(claimed.pro, true);
  await postWebhook("order_refunded", {
    ...LIFETIME_ORDER, id: "7100", user_email: refundEmail,
  }, "7100");
  const data = await readJson(await post("validate", { email: refundEmail, installationId: "aabbccdd-0011-2233-4455-66778899aabb" }));
  assert.equal(data.pro, false);
  assert.equal(data.tier, "free");
});

test("deactivate frees the seat and unclaims the purchase", async () => {
  const response = await post("deactivate", { email: EMAIL, installationId: INSTALLATION2 });
  const data = await readJson(response);
  assert.equal(data.ok, true);
  const validate = await readJson(await post("validate", { email: EMAIL, installationId: INSTALLATION2 }));
  assert.equal(validate.claimed, false);
});

test("GET /upgrade renders the three anchored pricing cards", async () => {
  const response = await worker.fetch(new Request(`${WORKER_URL}upgrade`), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /\$6/);
  assert.match(html, /\$4\.08/);
  assert.match(html, /Billed as \$49 annually/);
  assert.match(html, /Saves 32% compared to monthly/);
  assert.match(html, /Founding Pass/);
  assert.match(html, /first 50 users/);
  assert.match(html, /\$69/);
  assert.match(html, /Claim Pass/);
  assert.match(html, /Upgrade to Pro/);
  assert.match(html, /Select Pro/);
  assert.match(html, /embed=1/);
  // Order of the cards in the DOM: monthly, annual, lifetime.
  assert.ok(html.indexOf("Monthly") < html.indexOf("Annual") && html.indexOf("Annual") < html.indexOf("Founding Pass"));
});

test("legacy license-key activation fails cleanly when Lemon Squeezy is unreachable", async () => {
  const response = await post("activate", { email: "legacy@example.com", installationId: INSTALLATION, licenseKey: "LSN-S-TEST" });
  const data = await readJson(response);
  assert.notEqual(response.status, 500);
  assert.equal(data.ok, undefined);
  assert.ok(data.error);
});

test("CORS preflight is honored for the dev extension origin", async () => {
  const response = await worker.fetch(new Request(`${WORKER_URL}validate`, {
    method: "OPTIONS",
    headers: { Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${name}\n      ${error.message}`);
  }
}

console.log(failures === 0 ? "\nAll tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
