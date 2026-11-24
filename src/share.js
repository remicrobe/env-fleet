'use strict';
// Fichier de partage chiffré (.envfleet) : AES-256-GCM, clé dérivée du mot de passe de partage avec scrypt.
// Indépendant du mot de passe maître du coffre : on choisit un mot de passe à communiquer au destinataire.

const crypto = require('crypto');

const FORMAT = 'env-fleet-share';
const derive = (pw, salt) => crypto.scryptSync(pw, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

function encrypt(obj, password) {
  if (!password || password.length < 8) throw new Error('Le mot de passe de partage doit faire au moins 8 caractères.');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', derive(password, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return JSON.stringify({ format: FORMAT, v: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
}

function decrypt(text, password) {
  let f;
  try { f = JSON.parse(text); } catch { throw new Error('Fichier de partage invalide.'); }
  if (f.format !== FORMAT) throw new Error('Ce fichier n’est pas un partage env-fleet.');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', derive(password || '', Buffer.from(f.salt, 'base64')), Buffer.from(f.iv, 'base64'));
    d.setAuthTag(Buffer.from(f.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error('Mot de passe incorrect ou fichier corrompu.');
  }
}

module.exports = { encrypt, decrypt };
