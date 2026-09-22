# Changelog

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
