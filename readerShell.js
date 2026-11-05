// Frees the Impinj R700 for this app when another device or app holds its
// only LLRP connection. The reader accepts one LLRP client at a time and
// refuses newcomers (ConnectionAttemptEvent
// Failed_A_Client_Initiated_Connection_Already_Exists); the only thing that
// can drop the current one, besides that client itself, is the reader's own
// admin shell (RShell, over SSH): `config rfid llrp connclose`.
// RShell answers every command with a Status='<code>,<text>' line: 0 means
// the connection was closed, 8 (Permission-Denied) means none was open.
const { Client } = require('ssh2');

const SHELL_TIMEOUT_MS = 12000;

function closeLlrpConnection({ host, username, password }) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    let sent = false;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch (e) { /* already closed */ }
      if (err) reject(err); else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`The reader's admin shell at ${host} did not answer in time.`)),
      SHELL_TIMEOUT_MS
    );

    conn
      .on('ready', () => {
        conn.shell({ term: 'dumb' }, (err, stream) => {
          if (err) return finish(err);
          stream.on('data', (chunk) => {
            output += chunk.toString('utf8');
            // Send the command once RShell shows its prompt.
            if (!sent && />\s*$/.test(output)) {
              sent = true;
              output = '';
              stream.write('config rfid llrp connclose\r\n');
              return;
            }
            const m = sent && output.match(/Status='(\d+),([^']*)'/);
            if (m) {
              stream.write('exit\r\n');
              const code = Number(m[1]);
              if (code === 0 || code === 8) finish(null, { closed: code === 0, status: `${m[1]},${m[2]}` });
              else finish(new Error(`The reader refused to close its LLRP connection (Status ${m[1]}, ${m[2]}).`));
            }
          });
          stream.on('close', () => finish(new Error('The reader\'s admin shell closed before answering.')));
        });
      })
      .on('error', (err) => {
        const msg = err?.level === 'client-authentication'
          ? 'The reader rejected the admin login. Set the reader\'s admin password in Reader settings.'
          : `Could not open the reader's admin shell at ${host}: ${err?.message || err}`;
        finish(new Error(msg));
      })
      .connect({
        host,
        port: 22,
        username,
        password,
        tryKeyboard: true,
        readyTimeout: 8000,
      });
    // Some RShell builds ask for the password through keyboard-interactive.
    conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, reply) => reply(prompts.map(() => password)));
  });
}

module.exports = { closeLlrpConnection };
