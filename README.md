# Twimark

Twimark exports X/Twitter bookmarks as Markdown for NotebookLM or as CSV.

This repository continues the GPLv3 licensing included in the supplied extension package; see [LICENSE](LICENSE).

## Local development

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.
4. Open `https://x.com/i/history` and select the **Bookmarks** tab, then click the Twimark toolbar icon. The legacy `/i/bookmarks` route remains supported.

The extension uses `activeTab` to inject the scanner only after the user opens the popup on their X bookmarks page. Scan data is stored in `chrome.storage.local`, so closing the popup does not discard an active scan.

## Pro licensing deployment

NotebookLM export requires an active Twimark Pro entitlement. Entitlements are decided **server-side** in the Cloudflare Worker (`workers/license-gateway`) from Lemon Squeezy webhooks and stored in a D1 database — never inside the extension. The gateway accepts product ID `904561` and three pricing variants:

| Plan | Tier | Entitlement source |
| --- | --- | --- |
| Monthly (`$6/mo`) | `pro_monthly` | `subscription_created` / lifecycle events |
| Annual (`$4.08/mo`, $49/yr) | `pro_annual` | `subscription_created` / lifecycle events |
| Founding Pass (`$69` one-time) | `pro_lifetime` | `order_created` (one-time purchase) |

Before deploying:

1. Create the D1 database: `wrangler d1 create twimark-entitlements`, paste its `database_id` into `workers/license-gateway/wrangler.toml`, and apply the schema once: `wrangler d1 execute twimark-entitlements --remote --file=./workers/schema.sql` (or let the gateway auto-create it on first request).
2. In Lemon Squeezy → **Settings → Webhooks**, create a webhook pointing at `https://<worker>/webhooks`, subscribe to `order_created`, `order_refunded`, and all `subscription_*` events, then store the signing secret: `wrangler secret put LS_WEBHOOK_SECRET`.
3. Fill in the variant IDs (`LS_VARIANT_MONTHLY_ID`, `LS_VARIANT_ANNUAL_ID`, `LS_VARIANT_LIFETIME_ID`) and the three template checkout URLs in `wrangler.toml`.
4. Deploy the Worker with Wrangler and set `ALLOWED_ORIGIN` to the production Chrome extension origin.
5. Copy its HTTPS URL into `license-config.js`.
6. Keep the exact Worker URL pattern in `manifest.json` (`host_permissions` + `externally_connectable`).

`scripts/release-check.ps1` deliberately fails until steps 5–6 are complete.

### Webhook → entitlement mapping

- `order_created` with the lifetime variant → parks a `pro_lifetime` claim (`expires_at = NULL`, no renewal checks ever).
- `subscription_created` → parks `pro_monthly` / `pro_annual` with `subscription_id`, `renews_at`, and the customer-portal URL.
- `subscription_updated` → tracks `status` (paused, past-due, retried payments).
- `subscription_cancelled` / `subscription_expired` → tier set to `unpaid` (lifetime rows are never downgraded by subscription events).
- `subscription_payment_failed` → a 72-hour grace window opens; the extension shows a "Payment issue" banner linking to the Lemon Squeezy customer portal.
- `subscription_payment_success` → clears the grace window.
- Refunds → downgrade to `unpaid`/`refunded`.

Purchases are parked by email until the customer activates a device from the extension ("Log in for Pro" → checkout email). The `GET /activate` handoff page still works for receipt-button links; legacy pre-2.7 license keys activate through the same endpoint and are bridged into `pro_lifetime`.

### Lemon Squeezy purchase handoff

For one-click activation after payment, set the Twimark Pro product's **Confirmation modal button link** and **receipt button link** in Lemon Squeezy to:

`https://twimark-license-gateway.twimarkworker.workers.dev/activate?license_key=[license_key]&email=[email]`

Lemon Squeezy replaces both variables after a successful purchase. The handoff page sends the pair only to the installed Twimark extension, which claims the parked entitlement via the gateway.

### In-extension upgrade overlay

`GET /upgrade?installation_id=…&email=…` renders the three-card pricing page (Monthly → Annual "Most Popular" → Founding Pass "Early Adopter", limited to the first 50 users). The popup opens it standalone or embeds it in an iframe; MV3's CSP forbids loading Lemon Squeezy's `lemon.js` inside extension pages, so the checkout itself opens as Lemon Squeezy's hosted `embed=1` overlay from that page — the same in-place UX without a full-page redirect.

### Free-tier truncation hook

Free exports are never hard-blocked: each thread exports its first 3 posts cleanly, then collapses the remainder into a structured "[Tweets 4–N withheld]" block that explains what Pro adds. Free Markdown also carries the Twimark attribution footer; Pro users can remove it via the "Remove Twimark attribution footer" toggle.

## Release checks

Run `scripts/release-check.ps1`, then run `scripts/package.ps1`. The resulting ZIP is the file to upload to the existing Chrome Web Store item.

Before publishing, test a full export, Smart Sync, CSV export, Markdown export, and a media-only bookmark in Chrome.

## Privacy

The v2.4 source does not contain the Analytics Measurement Protocol calls or the hard-coded Analytics credential present in the supplied v2.3 package. Any future analytics must be explicitly disclosed in the Chrome Web Store Privacy practices tab and product copy.
