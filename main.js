'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Vault = require('./src/vault');
const ssh = require('./src/ssh');
const share = require('./src/share');
const envfile = require('./src/envfile');
const { parseMremoteng } = require('./src/mremoteng');

// Mode portable : données à côté de l'exécutable (Windows portable) ou dans ENV_FLEET_DATA.
const dataDir =
  process.env.ENV_FLEET_DATA ||
  (process.env.PORTABLE_EXECUTABLE_DIR ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'env-fleet-data') : app.getPath('userData'));
const vault = new Vault(dataDir);
let win = null;
const runs = new Map(); // runId -> Set<Client>

const hostStore = {
  get: (id) => vault.data.hostKeys[id],
  set: (id, fp) => { vault.data.hostKeys[id] = fp; vault.save(); },
};

const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_e, payload) => {
    try { return { ok: true, data: await fn(payload || {}) }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

const getServer = (id) => {
  const s = vault.data.servers.find((x) => x.id === id);
  if (!s) throw new Error('Serveur introuvable.');
  return s;
};

async function mapLimit(items, limit, fn) {
  const res = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return res;
}

handle('vault:status', () => ({ exists: vault.exists(), unlocked: vault.isUnlocked(), dir: dataDir }));
handle('vault:create', ({ password }) => vault.create(password));
handle('vault:unlock', ({ password }) => vault.unlock(password));
handle('vault:lock', () => vault.lock());
handle('data:save', ({ servers, history }) => {
  vault.data.servers = servers;
  vault.data.history = history || [];
  vault.save();
});

handle('mrng:import', async ({ password }) => {
  const r = await dialog.showOpenDialog(win, { title: 'Fichier mRemoteNG (confCons.xml)', properties: ['openFile'], filters: [{ name: 'XML', extensions: ['xml'] }, { name: 'Tous', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return parseMremoteng(fs.readFileSync(r.filePaths[0], 'utf8'), password);
});

// Partage chiffré : par défaut sans mots de passe / passphrases (includeSecrets les ajoute).
handle('share:export', async ({ servers, password, includeSecrets }) => {
  const payload = { exportedAt: new Date().toISOString(), servers: servers.map((s) => (includeSecrets ? s : { ...s, password: '', keyPassphrase: '' })) };
  const content = share.encrypt(payload, password);
  const r = await dialog.showSaveDialog(win, { title: 'Exporter un partage chiffré', defaultPath: 'env-fleet-partage.envfleet', filters: [{ name: 'Partage env-fleet', extensions: ['envfleet'] }] });
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, content);
  return { path: r.filePath, count: payload.servers.length };
});
handle('share:import', async ({ password }) => {
  const r = await dialog.showOpenDialog(win, { title: 'Importer un partage chiffré', properties: ['openFile'], filters: [{ name: 'Partage env-fleet', extensions: ['envfleet'] }, { name: 'Tous', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return share.decrypt(fs.readFileSync(r.filePaths[0], 'utf8'), password);
});

handle('ssh:test', ({ id }) => ssh.test(getServer(id), hostStore));
handle('env:read', ({ id }) => ssh.readFile(getServer(id), hostStore));
handle('env:write', ({ id, content }) => ssh.writeFile(getServer(id), hostStore, content));
handle('env:setVars', ({ content, vars }) => envfile.setVars(content, vars));

// Lecture + calcul de l'uniformisation, sans rien écrire.
handle('env:plan', async ({ ids, referenceId, applyVars }) => {
  let reference = null;
  if (referenceId) reference = await ssh.readFile(getServer(referenceId), hostStore);
  return mapLimit(ids, 6, async (id) => {
    const s = getServer(id);
    try {
      const before = await ssh.readFile(s, hostStore);
      const n = envfile.normalize(before, reference);
      let after = n.content;
      const warnings = [...n.warnings];
      if (applyVars && s.vars && s.vars.length) {
        const v = envfile.setVars(after, s.vars);
        after = v.content;
        warnings.push(...v.changes.map((c) => `Info spécifique ${c}`));
      }
      return { id, name: s.name, changed: before !== after, warnings, diff: envfile.diffContext(before, after), after };
    } catch (err) {
      return { id, name: s.name, error: err.message };
    }
  });
});

handle('env:apply', ({ items }) =>
  mapLimit(items, 6, async ({ id, content }) => {
    try { await ssh.writeFile(getServer(id), hostStore, content); return { id, ok: true }; }
    catch (err) { return { id, ok: false, error: err.message }; }
  })
);

handle('exec:run', async ({ runId, ids, command, login, timeoutSec }) => {
  const clients = new Set();
  runs.set(runId, clients);
  const send = (msg) => win && !win.isDestroyed() && win.webContents.send('exec:event', { runId, ...msg });
  const cmd = login ? `bash -lc ${ssh.sq(command)}` : command;
  await mapLimit(ids, 10, async (id) => {
    const s = getServer(id);
    send({ id, kind: 'start' });
    let c;
    try {
      c = await ssh.connect(s, hostStore);
      clients.add(c);
      const r = await ssh.exec(c, cmd, { timeoutMs: (timeoutSec || 60) * 1000, onData: (k, d) => send({ id, kind: k, data: d }) });
      send({ id, kind: 'end', code: r.code });
    } catch (err) {
      send({ id, kind: 'end', error: err.message });
    } finally {
      if (c) { clients.delete(c); c.end(); }
    }
  });
  runs.delete(runId);
});

handle('exec:cancel', ({ runId }) => {
  for (const c of runs.get(runId) || []) c.destroy();
});

// Terminal interactif : vrai PTY distant via ssh2 (JS pur), affiché par xterm.js côté fenêtre.
const terms = new Map(); // termId -> { c, stream }
handle('term:open', async ({ termId, id, cols, rows }) => {
  const c = await ssh.connect(getServer(id), hostStore);
  const send = (m) => win && !win.isDestroyed() && win.webContents.send('term:event', { termId, ...m });
  await new Promise((resolve, reject) =>
    c.shell({ term: 'xterm-256color', cols: cols || 80, rows: rows || 24 }, (err, stream) => {
      if (err) { c.end(); return reject(err); }
      stream.setEncoding('utf8');
      terms.set(termId, { c, stream });
      stream.on('data', (d) => send({ kind: 'data', data: d }));
      stream.on('close', () => { terms.delete(termId); c.end(); send({ kind: 'close' }); });
      resolve();
    })
  );
});
handle('term:write', ({ termId, data }) => { const t = terms.get(termId); if (t) t.stream.write(data); });
handle('term:resize', ({ termId, cols, rows }) => { const t = terms.get(termId); if (t) t.stream.setWindow(rows, cols, 0, 0); });
handle('term:close', ({ termId }) => { const t = terms.get(termId); if (t) { t.stream.close(); t.c.end(); terms.delete(termId); } });

app.whenReady().then(() => {
  const iconPath = path.join(__dirname, 'renderer', 'icon.png'); // dans le paquet (le dossier build/ n'y est pas)
  if (process.platform === 'darwin' && app.dock) { try { app.dock.setIcon(iconPath); } catch { /* icône facultative */ } }
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600, title: 'env-fleet', icon: iconPath,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, level, message, line, source) => console.log(`[renderer:${level}] ${message} (${source}:${line})`));
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, err));
  win.webContents.on('did-fail-load', (_e, code, desc) => console.log('[did-fail-load]', code, desc));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
