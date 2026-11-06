# Daytime photo flow refresh

Approved in chat on 2026-11-04: use Picsum with a persistent local photo pool,
refresh every 24 hours while the app runs, add up to 12 distinct photos per batch,
retain at most 48 photos / 20 MiB, and keep the 16 bundled photos as fallback.
User also requested a persistent disable switch above Galaxy particle effect.

## Behavior and architecture

- `photoFlowEnabled` defaults to true for fresh and existing installations. The
  Settings switch saves immediately, hides the daytime photo flow, cancels active
  requests, and stops its scheduler when disabled. The galaxy preference is separate.
- A main-process service owns the timer, Picsum pagination, download validation,
  manifest and cache under `userData/photo-flow`. Last successful refresh and last
  attempt survive restarts. Failed refreshes retry after one hour. Startup checks
  are delayed briefly; no service continues after application exit.
- Download JPEG thumbnails from the Picsum API; retain author and original source
  URL. Only Picsum / its image CDN may receive requests. Requests have timeouts,
  redirect, size, type and decode limits. Cache filenames derive from numeric IDs.
- Publish a manifest only after files are ready; evict the oldest photos to enforce
  both limits. Failed downloads preserve the previous collection. Stale/orphan
  files are cleaned within this service's cache directory.
- Typed IPC returns cached image data, and a change event refreshes renderer state.
  The renderer preloads images, keeps visible cards stable, and introduces new
  photos at the fully faded off-screen endpoints. Endpoint clearance is at least
  260 pixels so compact windows can also replace cards outside the visible pane.
- Chinese and English settings explain the feature and immediate save behavior.

## Acceptance

Check due times, restart persistence, de-duplication, eviction, malformed responses,
network failure, cancellation, and bundled fallback. Run TypeScript and production
build, real Electron DOM checks for the switch position/effect and image loading,
and an isolated live Picsum download/cache/restart check. Distinguish those checks
from a full signed packaged release installation.

## Verified on 2026-11-04

- 35 targeted Vitest checks passed (service, Chromium transport, settings store,
  existing motion/path tests); desktop TypeScript check and production build passed.
- Live Picsum access fetched 12 JPEGs in 25 requests (one list and two hops per
  image). A reconstructed service read all 12 without another network request.
- The isolated Electron fixture used real production IPC handlers, built preload,
  SettingsDrawer and ChatPanel. It verified switch placement, immediate hide,
  persisted off state, independent galaxy preference, re-enable, cache update
  events, loaded images in the animation, light/dark transitions and English text.
  Renderer console errors: zero. Its clock advances animation frames for coverage;
  it does not wait a real 24 hours. Scheduling uses an injected clock in unit tests.
- Reproduce from the desktop workspace root with:
  `pnpm --filter @claude-desktop/desktop exec vitest run electron/main/photo-flow-fetch.test.ts electron/main/photo-flow-service.test.ts electron/main/settings-store.test.ts src/lib/photo-flow.test.ts`,
  `pnpm --filter @claude-desktop/desktop typecheck`,
  `pnpm --filter @claude-desktop/desktop build`, then
  `node scripts/verify-photo-flow.mjs`.
- No release installer was produced or installed; restart the desktop development
  process to load the new main-process downloader and preload API.
