'use strict';
// Manipulation de fichiers .env : parsing, uniformisation, injection de variables, diff.
// Module pur (aucun accès réseau/disque) pour pouvoir être testé seul.

const KV = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function parse(content) {
  const text = String(content).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((raw) => {
    const t = raw.replace(/\s+$/, '');
    if (t.trim() === '') return { type: 'blank' };
    if (t.trim().startsWith('#')) return { type: 'comment', text: t.trim() };
    const m = KV.exec(t);
    if (m) return { type: 'kv', exp: !!m[2], key: m[3], value: m[4] };
    return { type: 'other', text: t };
  });
}

function fmt(e) {
  if (e.type === 'kv') return `${e.exp ? 'export ' : ''}${e.key}=${e.value}`;
  if (e.type === 'blank') return '';
  return e.text;
}

// Sortie canonique : LF, pas d'espaces en fin de ligne, `KEY=value`, un seul saut de ligne
// entre deux blocs, une ligne vide avant un bloc de commentaires qui suit une variable,
// pas de ligne vide en début/fin, un seul \n final.
function render(entries) {
  const out = [];
  let prev = null;
  for (const e of entries) {
    if (e.type === 'blank') {
      if (out.length && out[out.length - 1] !== '') out.push('');
    } else {
      if (e.type === 'comment' && prev && prev.type === 'kv' && out[out.length - 1] !== '') out.push('');
      out.push(fmt(e));
    }
    prev = e;
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out.join('\n') + '\n' : '';
}

function reorder(target, ref, warnings) {
  const tgt = new Map();
  const attached = new Map();
  const others = [];
  let pending = [];
  for (const e of target) {
    if (e.type === 'comment') pending.push(e);
    else if (e.type === 'kv') {
      if (tgt.has(e.key)) warnings.push(`Clé dupliquée : ${e.key} (dernière valeur conservée)`);
      tgt.set(e.key, e);
      attached.set(e.key, pending);
      pending = [];
    } else {
      if (e.type === 'other') others.push(e);
      pending = [];
    }
  }

  const sections = [];
  let cur = [];
  for (const e of ref) {
    if (e.type === 'blank') {
      if (cur.length) sections.push(cur);
      cur = [];
    } else cur.push(e);
  }
  if (cur.length) sections.push(cur);

  const used = new Set();
  const out = [];
  for (const sec of sections) {
    const block = [];
    let pend = [];
    let hadKv = false;
    let keptKv = false;
    for (const e of sec) {
      if (e.type === 'comment') pend.push(e);
      else if (e.type === 'kv') {
        hadKv = true;
        if (tgt.has(e.key)) {
          keptKv = true;
          used.add(e.key);
          block.push(...pend, tgt.get(e.key));
        }
        pend = [];
      }
    }
    if (!hadKv) block.push(...pend);
    if (hadKv && !keptKv) continue;
    out.push(...block, { type: 'blank' });
  }

  const extras = [...tgt.keys()].filter((k) => !used.has(k));
  if (extras.length) {
    warnings.push(`${extras.length} variable(s) absente(s) de la référence, ajoutée(s) en fin de fichier : ${extras.join(', ')}`);
    for (const k of extras) out.push(...(attached.get(k) || []), tgt.get(k));
    out.push({ type: 'blank' });
  }
  const missing = [];
  for (const e of ref) if (e.type === 'kv' && !tgt.has(e.key)) missing.push(e.key);
  if (missing.length) warnings.push(`Variable(s) de la référence absente(s) de ce fichier (non ajoutées) : ${[...new Set(missing)].join(', ')}`);
  if (others.length) out.push(...others);
  return out;
}

// referenceContent (optionnel) : réordonne et regroupe comme ce fichier. Les valeurs restent celles du serveur.
function normalize(content, referenceContent) {
  const warnings = [];
  const entries = parse(content);
  let out = entries;
  if (referenceContent != null) {
    out = reorder(entries, parse(referenceContent), warnings);
  } else {
    const seen = new Set();
    const dup = new Set();
    for (const e of entries) if (e.type === 'kv') (seen.has(e.key) ? dup : seen).add(e.key);
    for (const k of dup) warnings.push(`Clé dupliquée : ${k}`);
  }
  return { content: render(out), warnings };
}

// Applique des opérations sur des variables sans toucher au reste du fichier.
// ops : [{ key, action: 'set' | 'add' | 'delete', value }]
//   set    = crée ou met à jour ; add = crée seulement si absente ; delete = supprime toutes les lignes de cette clé.
function applyOps(content, ops) {
  const nl = String(content).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(content).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const changes = [];
  for (const op of ops || []) {
    if (!op || !KEY_RE.test(op.key || '')) continue;
    const action = op.action || 'set';
    const idxs = [];
    lines.forEach((l, i) => {
      const m = KV.exec(l);
      if (m && m[3] === op.key) idxs.push(i);
    });
    if (action === 'delete') {
      if (idxs.length) {
        for (let k = idxs.length - 1; k >= 0; k--) lines.splice(idxs[k], 1);
        changes.push(`${op.key} : supprimée`);
      }
    } else if (idxs.length) {
      if (action === 'add') continue;
      const i = idxs[idxs.length - 1];
      const m = KV.exec(lines[i]);
      if (m[4].trim() !== String(op.value)) {
        lines[i] = `${m[1]}${m[2] || ''}${m[3]}=${op.value}`;
        changes.push(`${op.key} : modifiée`);
      }
    } else {
      lines.push(`${op.key}=${op.value}`);
      changes.push(`${op.key} : ajoutée`);
    }
  }
  if (!changes.length) return { content, changes };
  return { content: lines.length ? lines.join(nl) + nl : '', changes };
}

const setVars = (content, vars) => applyOps(content, (vars || []).map((v) => ({ key: v.key, value: v.value, action: 'set' })));

// Clé -> valeur (la dernière occurrence gagne). Sert au tableau comparatif.
function toMap(content) {
  const out = {};
  for (const e of parse(content)) if (e.type === 'kv') out[e.key] = e.value.trim();
  return out;
}

// Diff ligne à ligne (LCS) avec `ctx` lignes de contexte. Retourne [{t:' '|'+'|'-'|'…', l}].
function diffContext(a, b, ctx = 2) {
  const x = String(a).replace(/\r\n?/g, '\n').split('\n');
  const y = String(b).replace(/\r\n?/g, '\n').split('\n');
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { ops.push({ t: ' ', l: x[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ t: '-', l: x[i++] });
    else ops.push({ t: '+', l: y[j++] });
  }
  while (i < n) ops.push({ t: '-', l: x[i++] });
  while (j < m) ops.push({ t: '+', l: y[j++] });

  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => {
    if (o.t !== ' ') for (let d = -ctx; d <= ctx; d++) if (k + d >= 0 && k + d < ops.length) keep[k + d] = true;
  });
  const res = [];
  let gap = false;
  ops.forEach((o, k) => {
    if (keep[k]) { if (gap) res.push({ t: '…', l: '' }); res.push(o); gap = false; }
    else gap = res.length > 0;
  });
  return res;
}

module.exports = { parse, render, normalize, setVars, applyOps, toMap, diffContext, KEY_RE };
