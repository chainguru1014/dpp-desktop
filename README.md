# DPP Desktop (Windows/Mac)

Two desktop apps share this code (`shell.js`):

- **Yometel DPP** (`main.js`): the DPP web app, `dpp.innosynch.com` by default.
- **Yometel DPP Manager** (`admin-main.js`, built with `electron-builder.admin.json`): the admin site, `admin.innosynch.com/admin` by default. Links to other websites open in the computer's browser. Its RFID Scan page (`frontend/src/features/rfid/rfidReader.js`) uses the same direct reader bridge.

Each is an Electron shell around its site. Everything works exactly like the browser version, with one difference: **RFID (Impinj R700) connects directly from this machine over LLRP/TCP**, bypassing the backend and Tailscale entirely — no different from the mobile app's native direct-connection mode, just running on a desktop instead of a phone.

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

The admin app: `npm run start:admin` (`DPP_ADMIN_DESKTOP_URL` to change its site).

## Build an installer

```bash
npm run dist:win         # Yometel DPP, Windows .exe (nsis)
npm run dist:mac         # Yometel DPP, macOS .dmg — must run on a Mac
npm run dist:admin:win   # Yometel DPP Manager, Windows .exe
npm run dist:admin:mac   # Yometel DPP Manager, macOS .dmg (Intel and Apple-chip) — must run on a Mac
```

GitHub Actions (`.github/workflows/build-mac.yml`) builds all four on every push to main; the installers are under the run's Artifacts. They are not code-signed, so Windows SmartScreen and macOS Gatekeeper warn on first open.

## Status

First working version — connect/start/stop/tag-polling/settings are wired end-to-end but **not yet tested against a real R700** from this shell specifically (the LLRP logic itself is already proven via the backend and mobile app). Test the same way: Connect → Start → check Passing Tags updates, same as on the other two platforms.
