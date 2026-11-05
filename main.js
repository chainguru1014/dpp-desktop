// Yometel DPP desktop app: the DPP web app (dpp.innosynch.com by default) in
// the shared desktop window (shell.js), with direct Impinj R700 access.
const { startShell } = require('./shell');

startShell({ url: process.env.DPP_DESKTOP_URL || 'https://dpp.innosynch.com' });
