// Yometel DPP Manager desktop app: the admin site (admin.innosynch.com by
// default) in the shared desktop window (shell.js). Its RFID Scan page
// reaches the Impinj R700 directly, like the DPP desktop app.
const { startShell } = require('./shell');

startShell({
  url: process.env.DPP_ADMIN_DESKTOP_URL || 'https://admin.innosynch.com/admin',
  openLinksOutside: true,
});
