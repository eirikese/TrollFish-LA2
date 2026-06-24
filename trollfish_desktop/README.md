# TrollFish — Desktop Edition

An Electron wrapper around the TrollFish Session Explorer web app. The web app
lives unchanged (aside from the native-file integration) under `renderer/`.

## Why a desktop build

On macOS/Safari the web app cannot use persistent file handles, so it copied
GoPro videos into the browser's OPFS storage — which Safari evicts (its ~7‑day
script‑writable storage cap, and disk-pressure eviction of multi‑GB blobs).
Result: a debrief prepared the day before would lose its videos overnight.

The desktop edition fixes this by referencing videos **by absolute disk path**
instead of copying them into evictable storage:

- Native file picker (`main.js` → `tf:pickFiles`) returns real paths.
- Paths are persisted in the existing `fileHandles` IndexedDB table.
- Playback streams from disk via the `trollfish-file://` protocol (range
  requests, no full-blob load).
- On next-day reopen, `file-manager.js` rebuilds files from those paths.

So a project set up the day before is fully intact the next morning, as long as
the source video files have not been moved or deleted on disk.

## Develop / run

```bash
cd trollfish_desktop
npm install
npm start
```

## Build installers

```bash
npm run dist:win    # Windows NSIS installer (run on Windows)
npm run dist:mac    # macOS .dmg (must run on macOS; sign with an Apple cert)
```

Output lands in `dist/`. macOS builds must be produced on a Mac and ideally
code-signed (Apple Developer cert) to avoid Gatekeeper warnings.
