# Changelog

All notable changes to this project are documented in this file.

## [0.1.3] - 2026-09-21

_(`0.1.1` and `0.1.2` were published/unpublished during this same release cycle and never saw stable use — all of it ships together here as `0.1.3`.)_

### Added

- Configurable API host: defaults to `https://octivo.shplinks.com`, overridable via `data-host="..."` on the `<script>` tag or `init({ host: '...' })`.
- `examples/index.html` usage example page, wired to the jsDelivr CDN build, including a `?host=` override param for testing against a non-default instance.

### Fixed

- `init()` no longer falls back to the `<script>` tag's own origin (e.g. `cdn.jsdelivr.net`) when resolving the API host. Since this widget always ships from a CDN, that fallback made every request 404 unless `data-host`/`init({ host })` was explicitly set. It now falls straight through to the default host (`https://octivo.shplinks.com`).

### Changed

- Doc comments and usage examples updated to reflect CDN-only distribution (no more references to a local CRM install path).

## [0.1.0] - 2026-09-19

Initial release.
