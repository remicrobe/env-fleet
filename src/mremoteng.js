'use strict';
// Import d'un fichier mRemoteNG (confCons.xml). Ne garde que les connexions SSH1/SSH2.
// Les dossiers deviennent : 1er niveau = projet, 2e niveau = type d'environnement.

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const DEFAULT_MASTER = 'mR3m'; // mot de passe maître par défaut de mRemoteNG

function decrypt(b64, password, { mode, iterations }) {
  if (!b64) return '';
  const buf = Buffer.from(b64, 'base64');
  if (mode === 'GCM') {
    const salt = buf.subarray(0, 16);
    const nonce = buf.subarray(16, 32);
    const rest = buf.subarray(32);
    const tag = rest.subarray(rest.length - 16);
    const ct = rest.subarray(0, rest.length - 16);
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha1');
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(salt);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  if (mode === 'CBC' || mode === '') {
    const iv = buf.subarray(0, 16);
    const key = crypto.createHash('md5').update(password).digest();
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8');
  }
  throw new Error(`Mode de chiffrement non supporté : ${mode}`);
}

function parseMremoteng(xml, masterPassword) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => n === 'Node' });
  const doc = parser.parse(xml);
  const rootKey = Object.keys(doc).find((k) => !k.startsWith('?'));
  if (!rootKey) throw new Error('Fichier mRemoteNG invalide (racine introuvable).');
  const root = doc[rootKey];
  if (String(root['@_FullFileEncryption']).toLowerCase() === 'true')
    throw new Error('Fichier entièrement chiffré non supporté : dans mRemoteNG, désactiver « Chiffrer tout le fichier » puis réexporter.');

  const opts = {
    mode: root['@_BlockCipherMode'] || '',
    iterations: Number(root['@_KdfIterations']) || 1000,
  };
  const master = masterPassword || DEFAULT_MASTER;
  const stats = { total: 0, skippedProtocol: 0, passwordFailed: 0 };
  const servers = [];

  const pw = (n) => {
    const enc = n['@_Password'];
    if (!enc) return '';
    try { return decrypt(enc, master, opts); } catch { stats.passwordFailed++; return ''; }
  };
  const flag = (n, name) => String(n['@_Inherit' + name]).toLowerCase() === 'true';

  const walk = (nodes, folders, ctx) => {
    for (const n of nodes || []) {
      const username = flag(n, 'Username') ? ctx.username : n['@_Username'] || '';
      const password = flag(n, 'Password') ? ctx.password : pw(n);
      if (n['@_Type'] === 'Container') {
        walk(n.Node, [...folders, String(n['@_Name'] || '')], { username, password });
      } else if (n['@_Type'] === 'Connection') {
        stats.total++;
        if (!/^SSH/i.test(String(n['@_Protocol'] || ''))) { stats.skippedProtocol++; continue; }
        servers.push({
          name: String(n['@_Name'] || n['@_Hostname']),
          project: folders[0] || 'Importé',
          env: folders[1] || 'DEFAULT',
          host: String(n['@_Hostname'] || ''),
          port: Number(n['@_Port']) || 22,
          username,
          authType: 'password',
          password,
        });
      }
    }
  };
  walk(root.Node, [], { username: '', password: '' });
  return { servers, stats };
}

module.exports = { parseMremoteng, decrypt, DEFAULT_MASTER };
