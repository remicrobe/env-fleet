'use strict';
// Coffre local chiffré (AES-256-GCM, clé dérivée du mot de passe maître avec scrypt).
// Le fichier vault.json est copiable d'une machine à l'autre : seul le mot de passe maître le déverrouille.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const emptyData = () => ({ version: 1, servers: [], history: [], hostKeys: {} });

class Vault {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'vault.json');
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  exists() { return fs.existsSync(this.file); }
  isUnlocked() { return !!this.data; }

  _derive(password, salt) {
    return crypto.scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  }

  create(password) {
    if (!password || password.length < 8) throw new Error('Le mot de passe maître doit faire au moins 8 caractères.');
    if (this.exists()) throw new Error('Un coffre existe déjà.');
    fs.mkdirSync(this.dir, { recursive: true });
    this.salt = crypto.randomBytes(16);
    this.key = this._derive(password, this.salt);
    this.data = emptyData();
    this.save();
    return this.data;
  }

  unlock(password) {
    const f = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const salt = Buffer.from(f.salt, 'base64');
    const key = this._derive(password, salt);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(f.iv, 'base64'));
      d.setAuthTag(Buffer.from(f.tag, 'base64'));
      const json = Buffer.concat([d.update(Buffer.from(f.data, 'base64')), d.final()]).toString('utf8');
      this.data = Object.assign(emptyData(), JSON.parse(json));
    } catch {
      throw new Error('Mot de passe maître incorrect.');
    }
    this.salt = salt;
    this.key = key;
    return this.data;
  }

  save() {
    if (!this.key) throw new Error('Coffre verrouillé.');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify(this.data), 'utf8'), c.final()]);
    const out = { v: 1, salt: this.salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: enc.toString('base64') };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, this.file);
  }

  lock() { this.key = null; this.data = null; }
}

module.exports = Vault;
