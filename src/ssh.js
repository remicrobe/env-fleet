'use strict';
const { Client, utils } = require('ssh2');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const expandHome = (p) => (p && p.startsWith('~') ? os.homedir() + p.slice(1) : p);
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Chemin distant -> expression shell (gère ~ et ~/...)
function quotePath(p) {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${sq(p.slice(2))}`;
  return sq(p);
}

// hostStore : { get(id), set(id, fingerprint) } — empreinte mémorisée à la 1re connexion, refus si elle change.
function connect(server, hostStore, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!server.host || !server.username) return reject(new Error('Hôte ou utilisateur manquant.'));
    const c = new Client();
    const id = `${server.host}:${Number(server.port) || 22}`;
    let mismatch = null;
    const cfg = {
      host: server.host,
      port: Number(server.port) || 22,
      username: server.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 10000,
      hostVerifier: (key) => {
        const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
        const known = hostStore.get(id);
        if (!known) { hostStore.set(id, fp); return true; }
        if (known !== fp) { mismatch = `Empreinte SSH de ${id} changée (attendue ${known}, reçue ${fp}). Connexion refusée.`; return false; }
        return true;
      },
    };
    if (server.authType === 'key') {
      try { cfg.privateKey = fs.readFileSync(expandHome(server.keyPath)); } catch (e) { return reject(new Error(`Clé illisible : ${e.message}`)); }
      if (server.keyPassphrase) cfg.passphrase = server.keyPassphrase;
    } else if (server.authType === 'agent') {
      cfg.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
    } else if (server.authType === 'password') {
      cfg.password = server.password || '';
      cfg.tryKeyboard = true;
    } else {
      // Automatique : agent SSH, puis clé par défaut de ~/.ssh (sans passphrase), puis mot de passe s'il est renseigné.
      const sock = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      if (sock) cfg.agent = sock;
      for (const name of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
        try {
          const buf = fs.readFileSync(`${os.homedir()}/.ssh/${name}`);
          if (!(utils.parseKey(buf) instanceof Error)) { cfg.privateKey = buf; break; }
        } catch { /* clé absente */ }
      }
      if (server.password) { cfg.password = server.password; cfg.tryKeyboard = true; }
    }
    c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => server.password || '')));
    c.on('ready', () => resolve(c));
    c.on('error', (e) => reject(new Error(mismatch || e.message)));
    c.connect(cfg);
  });
}

function exec(c, command, { input, onData, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    c.exec(command, (err, stream) => {
      if (err) return reject(err);
      let timer;
      if (timeoutMs) {
        timer = setTimeout(() => {
          stream.close();
          reject(new Error(`Délai dépassé (${Math.round(timeoutMs / 1000)} s)`));
        }, timeoutMs);
      }
      stream.setEncoding('utf8');
      stream.stderr.setEncoding('utf8');
      stream.on('data', (d) => onData && onData('out', d));
      stream.stderr.on('data', (d) => onData && onData('err', d));
      stream.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 128 : 0), signal });
      });
      stream.end(input != null ? input : undefined);
    });
  });
}

async function withClient(server, hostStore, fn) {
  const c = await connect(server, hostStore);
  try { return await fn(c); } finally { c.end(); }
}

async function readFile(server, hostStore) {
  if (!server.envPath) throw new Error('Chemin du .env non renseigné.');
  return withClient(server, hostStore, async (c) => {
    let out = '';
    let err = '';
    const r = await exec(c, `cat -- ${quotePath(server.envPath)}`, { onData: (k, d) => (k === 'out' ? (out += d) : (err += d)) });
    if (r.code !== 0) throw new Error(err.trim() || `cat a échoué (code ${r.code})`);
    return out;
  });
}

// Sauvegarde l'ancien fichier en <fichier>.bak-AAAAMMJJ-HHMMSS avant d'écrire (cat > conserve droits et propriétaire).
async function writeFile(server, hostStore, content) {
  if (!server.envPath) throw new Error('Chemin du .env non renseigné.');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-');
  const cmd = `f=${quotePath(server.envPath)}; if [ -f "$f" ]; then cp -p "$f" "$f.bak-${ts}" || exit 1; fi; cat > "$f"`;
  return withClient(server, hostStore, async (c) => {
    let err = '';
    const r = await exec(c, cmd, { input: content, onData: (k, d) => k === 'err' && (err += d) });
    if (r.code !== 0) throw new Error(err.trim() || `écriture échouée (code ${r.code})`);
  });
}

async function test(server, hostStore) {
  return withClient(server, hostStore, async (c) => {
    let out = '';
    const cmd = server.envPath ? `test -f ${quotePath(server.envPath)} && echo EXISTS || echo MISSING` : 'echo NOPATH';
    await exec(c, cmd, { onData: (k, d) => k === 'out' && (out += d) });
    return { envFile: out.trim() };
  });
}

module.exports = { connect, exec, readFile, writeFile, test, sq };
