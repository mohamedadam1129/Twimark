# Changelog

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
