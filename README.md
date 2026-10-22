# DPP Desktop (Windows/Mac)

Electron shell around the DPP web app (`dpp.innosynch.com` by default). Everything works exactly like the browser version, with one difference: **RFID (Impinj R700) connects directly from this machine over LLRP/TCP**, bypassing the backend and Tailscale entirely — no different from the mobile app's native direct-connection mode, just running on a desktop instead of a phone.

## How the RFID path works

- `impinjLlrpMain.js` runs in Electron's **main process** (real Node.js) and speaks LLRP straight to the reader with `llrpjs` — the same library the backend and the mobile app both use, unmodified (no socket-compatibility shims needed here, unlike the mobile app's `react-native-tcp-socket` bridge, since the main process already has Node's real `net` module).
- `preload.js` exposes that as `window.electronImpinj` to the page via `contextBridge`.
- `app/src/native/impinjRfid.web.ts` (in the main `app` repo) checks for `window.electronImpinj` and calls straight through to it when present, instead of fetching the backend's `/impinj-llrp/*` routes. No other app code changed — `CorporateScannerScreen.tsx`/`ShipmentInspectionScreen.tsx` use the same `getImpinjReaderStatus`/`connectImpinjReader`/etc. functions regardless of which path is actually active, including the existing reader-settings dialog (IP/port) — it just works here too.

**Requirement:** this computer must be on the **same local network as the reader** (same as the phone needs to be on its WiFi). There's no Tailscale/remote-network bridging in this path — that was only ever needed because the *backend* runs on a remote hosting server.

## Run it

```bash
npm install
npm start
```

Point it at a different build (e.g. a local dev server) with:
```bash
DPP_DESKTOP_URL=http://localhost:3001 npm start
```

## Build an installer

```bash
npm run dist:win   # Windows .exe (nsis)
npm run dist:mac   # macOS .dmg — must run on a Mac
```

## Status

First working version — connect/start/stop/tag-polling/settings are wired end-to-end but **not yet tested against a real R700** from this shell specifically (the LLRP logic itself is already proven via the backend and mobile app). Test the same way: Connect → Start → check Passing Tags updates, same as on the other two platforms.
