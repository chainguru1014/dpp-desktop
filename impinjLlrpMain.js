// Runs in Electron's MAIN process (real Node.js, not the sandboxed
// renderer) — connects straight to the Impinj R700 over LLRP/TCP, the same
// way backend/controllers/impinjLlrpController.ts and the mobile app's
// src/native/impinjRfid.ts do. This version needs none of the native app's
// react-native-tcp-socket compatibility shims (no `writable` polyfill, no
// write/end argument patching) — llrpjs already targets Node's real `net`
// module, and the main process *is* real Node, so it works unmodified.
//
// Exposes the same status/connect/disconnect/start/stop/tags/recentTags/
// clearTags/settings contract as impinjLlrpController.ts and impinjRfid.ts,
// with the exact same ImpinjReaderStatus/ImpinjTagRead/ImpinjReaderSettings
// field shapes, so the shared web UI code (CorporateScannerScreen.tsx,
// ShipmentInspectionScreen.tsx) behaves identically regardless of which of
// the three is actually running underneath.
const { LLRPClient, LLRPCore } = require('llrpjs');
const fs = require('fs');
const path = require('path');

// Same two llrpjs bugs patched in impinjLlrpController.ts and
// src/native/impinjRfid.ts — not specific to any one transport, so still
// needed here even with a real Node socket:
//  - its socket 'data' handler decodes only ONE message per chunk, so when
//    the reader sends several together (a response plus tag reports) the
//    rest sit in the buffer until more data happens to arrive;
//  - its transact() awaits the same receive promise in a `while (true)`
//    loop, so if any other message (a tag report, a keepalive) arrives
//    before the response it spins forever and never resolves.
const { LLRPNet } = require('llrpjs/dist/src/net/base');
const { LLRPProxyMessage } = require('llrpjs/dist/src/proxy/message');
const { LLRPError } = require('llrpjs/dist/src/base/error');
if (LLRPNet && !LLRPNet.prototype.__drainsAllMessages) {
  LLRPNet.prototype.onData = async function (data) {
    try {
      this._scanner.addBuffer(data);
      let msgBuf;
      while ((msgBuf = this._scanner.getNext())) {
        const msg = new LLRPProxyMessage(msgBuf).decode();
        this._ee.emit('message', msg);
        this._ee.emit(msg.getName(), msg);
      }
    } catch (e) {
      if (e instanceof LLRPError) this._ee.emit('error', e);
      else throw e;
    }
  };
  LLRPNet.prototype.__drainsAllMessages = true;
}

function transact(reader, message, timeoutMs) {
  const responseName = message.getResponseName();
  return new Promise((resolve, reject) => {
    let timer = null;
    const onResponse = (response) => {
      cleanup();
      resolve(response);
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (responseName) reader.off(responseName, onResponse);
    };
    if (responseName) {
      reader.on(responseName, onResponse);
      timer = setTimeout(() => {
        cleanup();
        reject(new LLRPError('ERR_LLRP_READER_TIMEOUT'));
      }, timeoutMs);
    }
    reader.send(message).then(
      () => {
        if (!responseName) resolve(null);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const ROSPEC_ID = 123;
const CONNECT_TIMEOUT_MS = 8000;
const TRANSACT_TIMEOUT_MS = 8000;
const TAG_IN_VIEW_WINDOW_MS = 10000;

const DEFAULT_SETTINGS = {
  readerName: 'Main RFID Reader',
  ipAddress: '192.168.1.10',
  port: 5084,
  connectionTimeoutMs: 10000,
  autoReconnect: true,
  reconnectIntervalMs: 5000,
  maxReconnectAttempts: 10,
  unlimitedReconnectAttempts: false,
  autoConnectOnStartup: true,
};

// Set once from main.js via initSettingsPath(), after `app.getPath('userData')`
// is available — can't call that at module-load time (before Electron's
// `ready` event), so settings load lazily on first use instead.
let settingsFilePath = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;

function initSettingsPath(userDataDir) {
  settingsFilePath = path.join(userDataDir, 'impinj-reader-settings.json');
}

function loadSettings() {
  if (settingsLoaded) return settings;
  try {
    if (settingsFilePath && fs.existsSync(settingsFilePath)) {
      const raw = fs.readFileSync(settingsFilePath, 'utf8');
      settings = { ...settings, ...JSON.parse(raw) };
    }
  } catch {
    // Fall back to defaults — the settings form will just show them.
  }
  settingsLoaded = true;
  return settings;
}

function saveSettings() {
  try {
    if (settingsFilePath) fs.writeFileSync(settingsFilePath, JSON.stringify(settings), 'utf8');
  } catch {
    // Non-fatal — settings just won't survive an app restart this time.
  }
}

let client = null;
let connected = false;
let started = false;
let lastError = null;
let lastErrorAtUtc = null;

function recordError(message) {
  lastError = message;
  lastErrorAtUtc = new Date().toISOString();
}

function describeLlrpError(error, fallback) {
  const code = error?.name || error?.code || '';
  const where = settings.ipAddress ? `${settings.ipAddress}:${settings.port}` : 'the reader';
  if (code === 'ERR_LLRP_READER_TIMEOUT') {
    return `The reader at ${where} did not answer in time. Check that it is on, in LLRP mode, and that no other app is connected to it.`;
  }
  if (code === 'ERR_LLRP_READER_OFFLINE') {
    return `Lost the connection to the reader at ${where}.`;
  }
  const message = error?.message || (typeof error === 'string' ? error : '');
  if (/ECONNREFUSED|refused/i.test(message)) {
    return `The reader at ${where} refused the connection. Check that its RFID interface is set to LLRP.`;
  }
  if (/EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timed out|unreachable/i.test(message)) {
    return `Could not reach ${where}. Check that this computer is on the same network as the reader.`;
  }
  return message || (code && code !== 'Error' ? `${fallback} (${code})` : fallback);
}

function buildStatus() {
  return {
    isConnected: connected && !!client?.socketWritable,
    isStarted: started,
    address: settings.ipAddress ? `${settings.ipAddress}:${settings.port}` : null,
    firmwareVersion: null,
    modelName: null,
    temperatureInCelsius: null,
    lastError,
    lastErrorAtUtc,
  };
}

function microsToIso(micros) {
  if (micros == null) return null;
  try {
    return new Date(Number(micros) / 1000).toISOString();
  } catch {
    return null;
  }
}
function microsFromTimestampParam(param) {
  return param?.getMicroseconds ? param.getMicroseconds() : undefined;
}

function buildRoSpec() {
  return new LLRPCore.ROSpec({
    data: {
      ROSpecID: ROSPEC_ID,
      Priority: 0,
      CurrentState: 'Disabled',
      ROBoundarySpec: {
        ROSpecStartTrigger: { ROSpecStartTriggerType: 'Null' },
        ROSpecStopTrigger: { ROSpecStopTriggerType: 'Null', DurationTriggerValue: 0 },
      },
      AISpec: {
        AntennaIDs: [0],
        AISpecStopTrigger: { AISpecStopTriggerType: 'Null', DurationTrigger: 0 },
        InventoryParameterSpec: { InventoryParameterSpecID: 1234, ProtocolID: 'EPCGlobalClass1Gen2' },
      },
      ROReportSpec: {
        ROReportTrigger: 'Upon_N_Tags_Or_End_Of_AISpec',
        N: 1,
        TagReportContentSelector: {
          EnableROSpecID: false,
          EnableSpecIndex: false,
          EnableInventoryParameterSpecID: false,
          EnableAntennaID: true,
          EnableChannelIndex: false,
          EnablePeakRSSI: true,
          EnableFirstSeenTimestamp: true,
          EnableLastSeenTimestamp: true,
          EnableTagSeenCount: false,
          EnableAccessSpecID: false,
        },
      },
    },
  });
}

let tagsByEpc = new Map();

function stripInternal(tag) {
  const { _lastSeenAtMs, ...rest } = tag;
  return rest;
}

function attachTagReportListener(reader) {
  reader.on('RO_ACCESS_REPORT', (msg) => {
    let list = msg.getTagReportData();
    if (!Array.isArray(list)) list = [list];
    const nowMs = Date.now();
    for (const tagReportData of list) {
      const epc = tagReportData.getEPCParameter?.()?.getEPC?.();
      if (!epc) continue;
      const existing = tagsByEpc.get(epc);
      const lastSeenTimeUtc =
        microsToIso(microsFromTimestampParam(tagReportData.getLastSeenTimestampUTC?.())) ||
        new Date(nowMs).toISOString();
      tagsByEpc.set(epc, {
        epc,
        antennaPort: tagReportData.getAntennaID?.()?.getAntennaID?.() ?? null,
        peakRssiInDbm: tagReportData.getPeakRSSI?.()?.getPeakRSSI?.() ?? null,
        tagSeenCount: null,
        firstSeenTimeUtc:
          existing?.firstSeenTimeUtc ??
          microsToIso(microsFromTimestampParam(tagReportData.getFirstSeenTimestampUTC?.())) ??
          lastSeenTimeUtc,
        lastSeenTimeUtc,
        phaseAngleInRadians: null,
        _lastSeenAtMs: nowMs,
      });
    }
  });
  reader.on('KEEPALIVE', () => {
    reader.send(new LLRPCore.KEEPALIVE_ACK());
  });
  reader.on('disconnect', () => {
    connected = false;
    started = false;
  });
  reader.on('error', () => {
    connected = false;
    started = false;
  });
}

async function closeClient() {
  const old = client;
  connected = false;
  started = false;
  if (!old) return;
  try {
    await Promise.race([old.disconnect(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  } catch {
    // Fall through to destroy().
  }
  try {
    old._tcp?.destroy?.();
  } catch {
    // Already gone.
  }
}

async function ensureConnected() {
  if (connected && client?.socketWritable) return client;
  loadSettings();
  if (!settings.ipAddress) {
    throw new Error('No reader IP address configured — set it in the reader settings.');
  }

  await closeClient();
  client = new LLRPClient({ host: settings.ipAddress, port: settings.port });
  attachTagReportListener(client);
  await client.connect();

  try {
    const notif = await client.recv(CONNECT_TIMEOUT_MS);
    if (!(notif instanceof LLRPCore.READER_EVENT_NOTIFICATION)) {
      throw new Error(`Unexpected message while confirming connection: ${notif?.getName?.() ?? notif}`);
    }
    const status = notif.getReaderEventNotificationData().getConnectionAttemptEvent()?.getStatus();
    if (status === 'Failed_A_Client_Initiated_Connection_Already_Exists') {
      throw new Error('The reader is already connected to another app or device (it allows only one at a time). Disconnect it there, or restart the reader, then try again.');
    }
    if (status !== 'Success') {
      throw new Error(`Reader rejected the LLRP connection: ${status}`);
    }
  } catch (error) {
    await closeClient();
    throw error;
  }

  connected = true;
  lastError = null;
  lastErrorAtUtc = null;
  return client;
}

async function getStatus() {
  loadSettings();
  return buildStatus();
}

async function connectReader() {
  try {
    await ensureConnected();
  } catch (error) {
    await closeClient();
    recordError(describeLlrpError(error, 'Could not connect to the Impinj R700 reader over LLRP'));
  }
  return buildStatus();
}

async function disconnectReader() {
  try {
    if (client?.socketWritable) {
      await transact(client, new LLRPCore.CLOSE_CONNECTION(), TRANSACT_TIMEOUT_MS).catch(() => null);
    }
    await closeClient();
  } catch (error) {
    recordError(describeLlrpError(error, 'Could not disconnect from the Impinj R700 reader'));
  } finally {
    connected = false;
    started = false;
  }
  return buildStatus();
}

async function startReading() {
  try {
    const reader = await ensureConnected();
    await transact(reader, new LLRPCore.DELETE_ROSPEC({ data: { ROSpecID: 0 } }), TRANSACT_TIMEOUT_MS);

    const roSpec = buildRoSpec();
    const addRsp = await transact(reader, new LLRPCore.ADD_ROSPEC().setROSpec(roSpec), TRANSACT_TIMEOUT_MS);
    const addStatus = addRsp?.getLLRPStatus?.()?.getStatusCode?.();
    if (addStatus && addStatus !== 'M_Success') {
      throw new Error(`ADD_ROSPEC failed: ${addStatus}`);
    }

    await transact(reader, new LLRPCore.ENABLE_ROSPEC({ data: { ROSpecID: ROSPEC_ID } }), TRANSACT_TIMEOUT_MS);
    const startRsp = await transact(reader, new LLRPCore.START_ROSPEC({ data: { ROSpecID: ROSPEC_ID } }), TRANSACT_TIMEOUT_MS);
    const startStatus = startRsp?.getLLRPStatus?.()?.getStatusCode?.();
    if (startStatus && startStatus !== 'M_Success') {
      throw new Error(`START_ROSPEC failed: ${startStatus}`);
    }

    tagsByEpc = new Map();
    started = true;
  } catch (error) {
    await closeClient();
    recordError(describeLlrpError(error, 'Could not start the Impinj R700 reader over LLRP'));
  }
  return buildStatus();
}

async function stopReading() {
  try {
    const reader = await ensureConnected();
    await transact(reader, new LLRPCore.STOP_ROSPEC({ data: { ROSpecID: ROSPEC_ID } }), TRANSACT_TIMEOUT_MS);
    await transact(reader, new LLRPCore.DELETE_ROSPEC({ data: { ROSpecID: ROSPEC_ID } }), TRANSACT_TIMEOUT_MS);
  } catch (error) {
    recordError(describeLlrpError(error, 'Could not stop the Impinj R700 reader over LLRP'));
  } finally {
    started = false;
  }
  return buildStatus();
}

async function getTagsInView() {
  const cutoff = Date.now() - TAG_IN_VIEW_WINDOW_MS;
  return Array.from(tagsByEpc.values())
    .filter((t) => t._lastSeenAtMs >= cutoff)
    .sort((a, b) => b._lastSeenAtMs - a._lastSeenAtMs)
    .map(stripInternal);
}

async function getRecentTags(count = 100) {
  return Array.from(tagsByEpc.values())
    .sort((a, b) => b._lastSeenAtMs - a._lastSeenAtMs)
    .slice(0, count)
    .map(stripInternal);
}

async function clearTags() {
  tagsByEpc = new Map();
}

async function getSettings() {
  return { ...loadSettings() };
}

async function updateSettings(next) {
  loadSettings();
  const addressChanged = next.ipAddress !== settings.ipAddress || next.port !== settings.port;
  settings = { ...settings, ...next };
  saveSettings();
  if (addressChanged && client?.socketWritable) {
    await closeClient();
  }
  return { ...settings };
}

module.exports = {
  initSettingsPath,
  getStatus,
  connectReader,
  disconnectReader,
  startReading,
  stopReading,
  getTagsInView,
  getRecentTags,
  clearTags,
  getSettings,
  updateSettings,
};
