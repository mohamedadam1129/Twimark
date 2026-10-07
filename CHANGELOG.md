# Changelog

## 2.7.0 - Unreleased

### Billing
- Moved Pro entitlements server-side: the license gateway now owns a Lemon Squeezy webhook receiver (`/webhooks`) with HMAC-SHA256 (`X-Signature`) verification and a D1-backed entitlement store.
- Added three-tier pricing: Monthly ($6/mo), Annual ($4.08/mo billed $49/yr, "Most Popular"), and Founding Pass ($69 one-time, limited to the first 50 users).
- `order_created` provisions lifetime entitlements (`expires_at = NULL`, no renewal checks); `subscription_created/updated/cancelled/expired/paused/resumed/payment_failed/payment_success` drive subscription entitlements.
- Failed payments open a 72-hour grace window with an in-extension "Payment issue" banner linking to the Lemon Squeezy customer portal; successful payments clear it.
- Purchases are parked by email and claimed per device from the extension ("Log in for Pro" by checkout email); refunds and cancellations downgrade to free, and deactivation frees the device seat.
- Added the in-extension pricing overlay at `GET /upgrade` (embedded-iframe friendly) with per-plan Lemon Squeezy checkout links and `checkout[custom]` attribution.
- Kept the receipt-button handoff page (`GET /activate?license_key=[license_key]&email=[email]`) and bridged legacy pre-2.7 license keys into account entitlements as lifetime grants.

### Paywall UX
- Free exports are no longer fully blocked: each thread exports its first 3 posts cleanly; the rest collapse into a structured "[Tweets 4–N withheld]" block that pitches Pro.
- Added the truncated-thread upsell modal with a blurred full-thread preview, a high-contrast "Export Full Thread with Pro" CTA, and a ghost "Continue with 3-tweet preview only" option.
- Renamed "Smart Thread Stitching" to **Research-Grade Structuring** across the popup, upgrade modal, and pricing copy.
- Added the three Pro micro-badges: Context Preservation, Noise Cleansing, and Audio Overview Ready.
- Added the Twimark attribution footer to free exports and a Pro-only "Remove Twimark attribution footer" toggle.

## 2.6.0 - Unreleased

- Added Pro Smart Thread Stitching: extracts same-author conversation posts from X and exports them as one Markdown thread.

## 2.5.1 - Unreleased

- Added a compact Before → After Markdown preview before an export begins.
- Moved the actual Markdown download and NotebookLM handoff to one explicit CTA after the preview.

## 2.5.0 - Unreleased

- Rebuilt the popup around one primary NotebookLM export action.
- Added a five-bookmark free Markdown sample with Twimark attribution and post-export onboarding.
- Moved license controls into a compact modal and added a Pro outcome-focused upgrade modal.
- Added Lemon Squeezy purchase handoff support for automatic in-extension activation after checkout.
- Added automatic incremental sync for returning Pro customers.

## 2.4.4 - Unreleased

- Refreshed the extension popup with Twimark branding, clearer export actions, accessible focus states, and a friendlier Pro purchase and activation area.

## 2.4.3 - Unreleased

- Added support for X's new `/i/history` Bookmarks route while retaining the legacy Bookmarks route.
- Prevented scans from running on X History's Likes, Videos, and Articles tabs.
- Added an in-extension Twimark Pro purchase button linked to Lemon Squeezy checkout.

## 2.4.2 - Unreleased

- Fixed repeat scans in the same X tab returning an empty export.
- Expanded license endpoint CORS support to valid Chrome extension origins, fixing activation errors for legitimate extension installations with a different ID.

## 2.4.1 - Unreleased

- Added server-validated lifetime-license activation for NotebookLM export.
- Added per-browser license instances and a device-deactivation control.
- Restricted validation to Lemon Squeezy product ID `904561`.

## 2.4.0 - Unreleased

- Rebuilt bookmark scanning to tolerate X's virtualized, delayed timeline.
- Persist scan results outside the extension popup.
- Added reliable Markdown and CSV downloads through the Chrome Downloads API.
- Added media URL export for media-only bookmarks.
- Reworked Smart Sync to use exported bookmark IDs rather than Tweet-ID ordering.
- Removed the bundled Analytics tracking code and hard-coded credential.

### Migration note

The first Smart Sync after updating to 2.4.0 reconciles bookmarks because the old Tweet-ID watermark is intentionally not used. Subsequent exports use the new exported-ID history.
