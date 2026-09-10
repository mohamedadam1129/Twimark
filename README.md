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

NotebookLM export requires an active Lemon Squeezy Twimark Pro license. The Cloudflare Worker source is in `workers/license-gateway` and only accepts Lemon Squeezy product ID `904561`.

Before building v2.4.1:

1. Deploy the Worker with Wrangler and set `ALLOWED_ORIGIN` to the production Chrome extension origin.
2. Copy its HTTPS URL into `license-config.js`.
3. Replace the broad `https://*.workers.dev/*` entry in `manifest.json` with that exact Worker URL pattern.

`scripts/release-check.ps1` deliberately fails until steps 2–3 are complete.

## Release checks

Run `scripts/release-check.ps1`, then run `scripts/package.ps1`. The resulting ZIP is the file to upload to the existing Chrome Web Store item.

Before publishing, test a full export, Smart Sync, CSV export, Markdown export, and a media-only bookmark in Chrome.

## Privacy

The v2.4 source does not contain the Analytics Measurement Protocol calls or the hard-coded Analytics credential present in the supplied v2.3 package. Any future analytics must be explicitly disclosed in the Chrome Web Store Privacy practices tab and product copy.
