'use strict';
const { createApp, ref, reactive, computed, nextTick, watch } = Vue;
const bridge = window.api;
const call = async (ch, payload) => {
  // Les objets réactifs Vue (proxies) ne passent pas par l'IPC : on envoie une copie JSON pure.
  const r = await bridge.invoke(ch, payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)));
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const newServer = () => ({ id: crypto.randomUUID(), name: '', project: '', env: '', host: '', port: 22, username: '', authType: 'auto', password: '', keyPath: '', keyPassphrase: '', envPath: '', vars: [] });
const clone = (o) => JSON.parse(JSON.stringify(o));

createApp({
  setup() {
    // ----- thème (clair / sombre / système), mémorisé dans le navigateur de l'app -----
    const vtheme = Vuetify.useTheme();
    const themeModes = [
      { value: 'system', title: 'Système', icon: 'mdi-theme-light-dark' },
      { value: 'light', title: 'Clair', icon: 'mdi-white-balance-sunny' },
      { value: 'dark', title: 'Sombre', icon: 'mdi-weather-night' },
    ];
    let saved = 'system';
    try { saved = localStorage.getItem('env-fleet-theme') || 'system'; } catch { /* stockage indisponible */ }
    const themeMode = ref(saved);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => { vtheme.global.name.value = themeMode.value === 'system' ? (media.matches ? 'dark' : 'light') : themeMode.value; };
    const setTheme = (m) => { themeMode.value = m; try { localStorage.setItem('env-fleet-theme', m); } catch { /* ignoré */ } applyTheme(); };
    media.addEventListener('change', applyTheme);
    applyTheme();

    // ----- état global -----
    const unlocked = ref(false);
    const vaultExists = ref(true);
    const vaultDir = ref('');
    const pw = ref('');
    const pw2 = ref('');
    const servers = ref([]);
    const history = ref([]);
    const checked = ref([]);
    const collapsed = ref([]);
    const filter = ref('');
    const view = ref('server');
    const draft = ref(null);
    const envText = ref('');
    const showPw = ref(false);
    const busy = ref('');
    const snack = reactive({ show: false, text: '', color: 'info', timeout: 5000 });

    const authTypes = [{ title: 'Automatique (agent + clés ~/.ssh + mot de passe)', value: 'auto' }, { title: 'Mot de passe', value: 'password' }, { title: 'Clé SSH', value: 'key' }, { title: 'Agent SSH', value: 'agent' }];
    const byId = (id) => servers.value.find((s) => s.id === id);
    const serverName = (id) => (byId(id) ? byId(id).name : id);

    // Un seul snackbar : un nouveau message remplace le précédent (pas d'empilement).
    const notify = (text, color = 'info') => {
      snack.show = false;
      nextTick(() => { snack.text = text; snack.color = color; snack.timeout = color === 'error' ? 9000 : 4000; snack.show = true; });
    };
    const run = async (name, fn) => {
      busy.value = name;
      try { await fn(); } catch (e) { notify(e.message, 'error'); } finally { busy.value = ''; }
    };
    const persist = () => call('data:save', { servers: clone(servers.value), history: history.value });

    call('vault:status').then((st) => { vaultExists.value = st.exists; vaultDir.value = st.dir; });

    // ----- verrouillage -----
    const submitLock = () => run('lock', async () => {
      if (!vaultExists.value && pw.value !== pw2.value) throw new Error('Les deux mots de passe diffèrent.');
      const data = await call(vaultExists.value ? 'vault:unlock' : 'vault:create', { password: pw.value });
      // Migration silencieuse : un serveur « Mot de passe » sans mot de passe enregistré passe en « Automatique » (agent / clés ~/.ssh).
      let migrated = false;
      servers.value = data.servers.map((s) => {
        if (s.authType === 'password' && !s.password) { migrated = true; return { ...s, authType: 'auto' }; }
        return s;
      });
      history.value = data.history;
      pw.value = pw2.value = '';
      unlocked.value = true;
      if (migrated) persist().catch(() => {});
    });
    const lockVault = async () => {
      for (const t of [...terms.value]) await closeTerminal(t.termId);
      await call('vault:lock');
      servers.value = []; draft.value = null; checked.value = [];
      vaultExists.value = true; unlocked.value = false;
    };

    // ----- arbre -----
    const rows = computed(() => {
      const f = (filter.value || '').toLowerCase();
      const tree = new Map();
      for (const s of servers.value) {
        if (f && !`${s.name} ${s.host} ${s.project} ${s.env}`.toLowerCase().includes(f)) continue;
        const p = s.project || '(sans projet)';
        const e = s.env || '(sans type)';
        if (!tree.has(p)) tree.set(p, new Map());
        if (!tree.get(p).has(e)) tree.get(p).set(e, []);
        tree.get(p).get(e).push(s);
      }
      const out = [];
      for (const [p, envs] of [...tree].sort((a, b) => a[0].localeCompare(b[0]))) {
        const pIds = [...envs.values()].flat().map((s) => s.id);
        const pc = collapsed.value.includes(p);
        out.push({ kind: 'p', key: p, label: p, project: p === '(sans projet)' ? '' : p, ids: pIds, collapsed: pc });
        if (pc) continue;
        for (const [e, list] of [...envs].sort((a, b) => a[0].localeCompare(b[0]))) {
          const k = p + '\u0000' + e;
          const ec = collapsed.value.includes(k);
          out.push({ kind: 'e', key: k, label: e, project: p === '(sans projet)' ? '' : p, env: e === '(sans type)' ? '' : e, ids: list.map((s) => s.id), collapsed: ec });
          if (ec) continue;
          for (const s of [...list].sort((a, b) => a.name.localeCompare(b.name)))
            out.push({ kind: 's', key: s.id, id: s.id, label: s.name, sub: `${s.username}@${s.host}`, ids: [s.id] });
        }
      }
      return out;
    });
    const checkState = (r) => {
      const n = r.ids.filter((i) => checked.value.includes(i)).length;
      return n === 0 ? 'none' : n === r.ids.length ? 'all' : 'some';
    };
    const toggle = (r, v) => {
      const set = new Set(checked.value);
      r.ids.forEach((i) => (v ? set.add(i) : set.delete(i)));
      checked.value = [...set];
    };
    const rowClick = (r) => {
      if (justDragged) return;
      if (r.kind === 's') return openServer(r.id);
      const i = collapsed.value.indexOf(r.key);
      if (i >= 0) collapsed.value.splice(i, 1); else collapsed.value.push(r.key);
    };
    // Glisser-déposer maison (souris) : un serveur (ou tous les cochés), un type ou un projet se déposent
    // sur un projet (change le projet) ou sur un type (change projet + type). Pas de DnD natif (image fantôme).
    const dragging = ref(null);
    const dragOver = ref(null);
    const ghost = reactive({ show: false, x: 0, y: 0, text: '' });
    let press = null;
    let justDragged = false;
    const dragDown = (e, r) => {
      if (e.button !== 0 || e.target.closest('.v-selection-control, .v-btn')) return;
      press = { r, x: e.clientX, y: e.clientY };
    };
    const endDrag = () => { press = null; dragging.value = null; dragOver.value = null; ghost.show = false; };
    const moveTo = (ids, r) => run('move', async () => {
      let n = 0;
      for (const s of servers.value) {
        if (!ids.includes(s.id)) continue;
        const env = r.kind === 'e' ? r.env : s.env;
        if (s.project === r.project && s.env === env) continue;
        s.project = r.project; s.env = env; n++;
        if (draft.value && draft.value.id === s.id) { draft.value.project = r.project; draft.value.env = env; }
      }
      if (!n) return notify('Déjà à cet endroit.', 'info');
      await persist();
      notify(`${n} serveur(s) déplacé(s) vers ${r.label}.`, 'success');
    });
    window.addEventListener('mousemove', (e) => {
      if (!press) return;
      if (!dragging.value) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
        const r = press.r;
        const ids = r.kind === 's' && checked.value.includes(r.id) ? [...checked.value] : [...r.ids];
        dragging.value = { ids };
        ghost.text = r.kind === 's' && ids.length === 1 ? r.label : `${r.kind === 's' ? '' : r.label + ' — '}${ids.length} serveur(s)`;
        ghost.show = true;
      }
      ghost.x = e.clientX + 14;
      ghost.y = e.clientY + 10;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el && el.closest('[data-i]') ? rows.value[Number(el.closest('[data-i]').dataset.i)] : null;
      dragOver.value = row && row.kind !== 's' ? row.key : null;
    });
    window.addEventListener('mouseup', () => {
      if (!press) return;
      const was = dragging.value;
      const target = dragOver.value ? rows.value.find((x) => x.key === dragOver.value) : null;
      endDrag();
      if (!was) return;
      justDragged = true;
      setTimeout(() => { justDragged = false; }, 0);
      if (target) moveTo(was.ids, target);
    });
    window.addEventListener('keydown', (e) => e.key === 'Escape' && endDrag());
    // ----- clic droit sur l'arbre -----
    const ctx = reactive({ show: false, x: 0, y: 0, row: null });
    const ren = reactive({ show: false, row: null, value: '' });
    const openCtx = (e, r) => { ctx.row = r; ctx.x = e.clientX; ctx.y = e.clientY; ctx.show = true; };
    const ctxTarget = computed(() => (ctx.row ? ctx.row.ids : []));
    const ctxCheckOnly = () => { checked.value = [...ctxTarget.value]; };
    const ctxUniform = () => { ctxCheckOnly(); openUniform(); };
    const ctxBulk = () => { ctxCheckOnly(); openBulk(ctxTarget.value); };
    const ctxMatrix = () => { ctxCheckOnly(); mx.loaded = false; openMatrix(); };
    const ctxCommands = () => { ctxCheckOnly(); view.value = 'commands'; };
    const ctxDuplicate = () => run('dup', async () => {
      const c = clone(byId(ctx.row.id));
      c.id = crypto.randomUUID(); c.name += ' (copie)';
      servers.value.push(c);
      await persist();
      openServer(c.id);
    });
    const ctxDelete = () => run('del', async () => {
      const r = ctx.row;
      const label = r.kind === 's' ? `« ${r.label} »` : `les ${r.ids.length} serveur(s) de « ${r.label} »`;
      if (!confirm(`Supprimer ${label} ? Cette action ne touche que env-fleet, pas les serveurs eux-mêmes.`)) return;
      servers.value = servers.value.filter((s) => !r.ids.includes(s.id));
      checked.value = checked.value.filter((i) => !r.ids.includes(i));
      if (draft.value && r.ids.includes(draft.value.id)) draft.value = null;
      await persist();
      notify('Supprimé.', 'success');
    });
    const ctxRename = () => { ren.row = ctx.row; ren.value = ctx.row.kind === 'p' ? ctx.row.project : ctx.row.env; ren.show = true; };
    const confirmRename = () => run('ren', async () => {
      const r = ren.row;
      const v = (ren.value || '').trim();
      if (!v) throw new Error('Le nom ne peut pas être vide.');
      for (const s of servers.value) {
        if (!r.ids.includes(s.id)) continue;
        if (r.kind === 'p') s.project = v; else s.env = v;
        if (draft.value && draft.value.id === s.id) { draft.value.project = s.project; draft.value.env = s.env; }
      }
      await persist();
      ren.show = false;
      notify('Renommé.', 'success');
    });

    const checkedServers = computed(() => checked.value.map(byId).filter(Boolean));

    // ----- détail serveur -----
    const isNew = computed(() => draft.value && !byId(draft.value.id));
    const projects = computed(() => [...new Set(servers.value.map((s) => s.project).filter(Boolean))]);
    const envTypes = computed(() => [...new Set(['PRODUCTION', 'DEVELOPMENT', 'STAGING', ...servers.value.map((s) => s.env).filter(Boolean)])]);
    const knownKeys = computed(() => [...new Set(servers.value.flatMap((s) => (s.vars || []).map((v) => v.key)))]);

    const openServer = (id) => { view.value = 'server'; draft.value = id ? clone(byId(id)) : newServer(); envText.value = ''; };
    const setVarType = (v, t) => { v.type = t; if (t === 'bool') v.value = 'false'; };
    const duplicate = () => { const c = clone(draft.value); c.id = crypto.randomUUID(); c.name += ' (copie)'; draft.value = c; };

    const saveDraft = async () => {
      const d = draft.value;
      if (!d.name || !d.host || !d.username) throw new Error('Nom, hôte et utilisateur sont obligatoires.');
      const c = clone(d);
      c.project = c.project || ''; c.env = c.env || '';
      c.vars = c.vars.filter((v) => v.key);
      const i = servers.value.findIndex((s) => s.id === c.id);
      if (i >= 0) servers.value[i] = c; else servers.value.push(c);
      await persist();
    };
    const save = async () => { await saveDraft(); notify('Serveur enregistré.', 'success'); };
    const testConn = async () => {
      await saveDraft();
      const r = await call('ssh:test', { id: draft.value.id });
      if (r.envFile === 'MISSING') notify('Connexion OK, mais le .env est INTROUVABLE à ce chemin.', 'warning');
      else notify('Connexion OK' + (r.envFile === 'EXISTS' ? ' — .env trouvé.' : ' (chemin du .env non renseigné).'), 'success');
    };
    const removeServer = async () => {
      if (!confirm(`Supprimer « ${draft.value.name} » ?`)) return;
      const id = draft.value.id;
      servers.value = servers.value.filter((s) => s.id !== id);
      checked.value = checked.value.filter((i) => i !== id);
      draft.value = null;
      await persist();
    };
    const loadEnv = async () => { await saveDraft(); envText.value = await call('env:read', { id: draft.value.id }); notify('.env chargé.', 'success'); };
    const applyVars = async () => {
      const r = await call('env:setVars', { content: envText.value, vars: draft.value.vars.filter((v) => v.key) });
      envText.value = r.content;
      notify(r.changes.length ? r.changes.join(' · ') : 'Rien à changer.', 'success');
    };
    const writeEnv = async () => {
      if (!envText.value) throw new Error('Contenu vide : rien n’a été écrit.');
      await saveDraft();
      if (!confirm(`Écrire ce contenu dans ${draft.value.envPath} sur ${draft.value.name} ?`)) return;
      await call('env:write', { id: draft.value.id, content: envText.value });
      notify('.env écrit.', 'success');
    };

    // ----- modifier une variable sur plusieurs serveurs -----
    const bulk = reactive({ show: false, ids: [], ops: [], plans: null, picks: [] });
    const bulkActions = [{ title: 'Définir (créer ou modifier)', value: 'set' }, { title: 'Ajouter si absente', value: 'add' }, { title: 'Supprimer', value: 'delete' }];
    const openBulk = (ids, firstOp) => {
      const list = (ids || checked.value).filter((i) => byId(i));
      if (!list.length) return notify('Cochez d’abord les serveurs concernés dans l’arbre.', 'warning');
      Object.assign(bulk, { show: true, ids: list, plans: null, picks: [], ops: [firstOp || { key: '', action: 'set', value: '' }] });
    };
    const planBulk = async () => {
      const ops = bulk.ops.filter((o) => o.key);
      if (!ops.length) throw new Error('Renseignez au moins une clé.');
      bulk.plans = null;
      const plans = await call('env:planOps', { ids: bulk.ids, ops: ops.map((o) => ({ key: o.key.trim(), action: o.action, value: o.value })) });
      bulk.plans = plans;
      bulk.picks = plans.filter((p) => p.changed).map((p) => p.id);
    };
    const pickBulk = (id, v) => { bulk.picks = v ? [...new Set([...bulk.picks, id])] : bulk.picks.filter((i) => i !== id); };
    const applyBulk = async () => {
      const items = bulk.plans.filter((p) => bulk.picks.includes(p.id)).map((p) => ({ id: p.id, content: p.after }));
      if (!confirm(`Écrire ${items.length} fichier(s) .env sur les serveurs ?`)) return;
      const res = await call('env:apply', { items });
      const bad = res.filter((r) => !r.ok);
      if (bad.length) notify(`${res.length - bad.length} écrit(s), ${bad.length} échec(s) : ${bad.map((b) => `${serverName(b.id)} (${b.error})`).join(' ; ')}`, 'error');
      else { notify(`${res.length} fichier(s) écrit(s).`, 'success'); bulk.show = false; }
    };

    // ----- tableau comparatif des variables -----
    const SECRET_RE = /(PASS|SECRET|TOKEN|KEY|PWD|CREDENTIAL|PRIVATE)/i;
    const mx = reactive({ loading: false, loaded: false, cols: [], rows: [], onlyDiff: true, filter: '', secrets: false });
    const cellKey = (r, id) => (r.values[id] === undefined ? '\u0000missing' : r.values[id]);
    const loadMatrix = async () => {
      const ids = checked.value.filter((i) => byId(i));
      if (!ids.length) throw new Error('Cochez d’abord les serveurs à comparer dans l’arbre.');
      mx.loading = true;
      try {
        const res = await call('env:matrix', { ids });
        const keys = new Set();
        res.forEach((r) => r.vars && Object.keys(r.vars).forEach((k) => keys.add(k)));
        mx.cols = res.map((r) => ({ id: r.id, name: r.name, error: r.error }));
        mx.rows = [...keys].sort().map((key) => {
          const values = {};
          const count = new Map();
          for (const r of res) {
            if (r.error) continue;
            values[r.id] = r.vars[key];
            const k = r.vars[key] === undefined ? '\u0000missing' : r.vars[key];
            count.set(k, (count.get(k) || 0) + 1);
          }
          let maj = null;
          let best = -1;
          for (const [k, n] of count) if (n > best) { best = n; maj = k; }
          return { key, values, maj, diff: count.size > 1, secret: SECRET_RE.test(key) };
        });
        mx.loaded = true;
      } finally { mx.loading = false; }
    };
    const mxRows = computed(() => mx.rows.filter((r) => (!mx.onlyDiff || r.diff) && (!mx.filter || r.key.toLowerCase().includes(mx.filter.toLowerCase()))));
    const mxText = (r, c) => (c.error ? '?' : r.values[c.id] === undefined ? '—' : r.secret && !mx.secrets ? '••••••' : r.values[c.id]);
    const mxOdd = (r, c) => r.diff && !c.error && cellKey(r, c.id) !== r.maj;
    const mxEdit = (r) => openBulk(mx.cols.filter((c) => !c.error).map((c) => c.id), { key: r.key, action: 'set', value: '' });
    const allKeys = computed(() => [...new Set([...knownKeys.value, ...mx.rows.map((r) => r.key)])]);
    const openMatrix = () => { view.value = 'matrix'; if (checked.value.length && !mx.loaded) run('matrix', loadMatrix); };

    // ----- partage chiffré -----
    const shExp = reactive({ show: false, pw: '', pw2: '', secrets: false, scope: 'all' });
    const shImp = reactive({ show: false, pw: '', data: null, picks: [] });
    const openShareExport = () => Object.assign(shExp, { show: true, pw: '', pw2: '', secrets: false, scope: checked.value.length ? 'checked' : 'all' });
    const shExpCount = computed(() => (shExp.scope === 'checked' ? checked.value.filter((i) => byId(i)).length : servers.value.length));
    const doShareExport = async () => {
      if (shExp.pw !== shExp.pw2) throw new Error('Les deux mots de passe diffèrent.');
      const list = shExp.scope === 'checked' ? checked.value.map(byId).filter(Boolean) : servers.value;
      if (!list.length) throw new Error('Aucun serveur à exporter.');
      const r = await call('share:export', { servers: list, password: shExp.pw, includeSecrets: shExp.secrets });
      if (r.canceled) return;
      shExp.show = false;
      notify(`${r.count} serveur(s) exporté(s) : ${r.path}`, 'success');
    };
    const openShareImport = () => Object.assign(shImp, { show: true, pw: '', data: null, picks: [] });
    const pickShare = async () => {
      const r = await call('share:import', { password: shImp.pw });
      if (r.canceled) return;
      shImp.data = r.servers.map((s) => ({ ...s, existing: !!byId(s.id) }));
      shImp.picks = shImp.data.map(() => true);
    };
    const confirmShare = async () => {
      let added = 0;
      let updated = 0;
      shImp.data.forEach((s, i) => {
        if (!shImp.picks[i]) return;
        const { existing, ...srv } = s;
        const full = { ...newServer(), ...srv };
        const idx = servers.value.findIndex((x) => x.id === full.id);
        if (idx >= 0) { servers.value[idx] = full; updated++; } else { servers.value.push(full); added++; }
      });
      await persist();
      shImp.show = false;
      notify(`${added} ajouté(s), ${updated} mis à jour.`, 'success');
    };

    // ----- import mRemoteNG -----
    const imp = reactive({ show: false, pw: '', data: null, picks: [] });
    const openImport = () => { imp.pw = ''; imp.data = null; imp.picks = []; imp.show = true; };
    const pickImport = async () => {
      const r = await call('mrng:import', { password: imp.pw });
      if (r.canceled) return;
      imp.data = r;
      imp.picks = r.servers.map(() => true);
    };
    const confirmImport = async () => {
      let n = 0;
      imp.data.servers.forEach((s, i) => { if (imp.picks[i]) { servers.value.push({ ...newServer(), ...s }); n++; } });
      await persist();
      imp.show = false;
      notify(`${n} serveur(s) importé(s).`, 'success');
    };

    // ----- uniformiser -----
    const uni = reactive({ show: false, ids: [], ref: '', refItems: [], withVars: false, plans: null, picks: [] });
    const openUniform = () => {
      const ids = checked.value.filter((i) => byId(i));
      if (!ids.length) return notify('Cochez d’abord les serveurs à uniformiser dans l’arbre.', 'warning');
      Object.assign(uni, { show: true, ids, ref: '', withVars: false, plans: null, picks: [],
        refItems: [{ title: 'Aucune (nettoyage de format seulement)', value: '' }, ...ids.map((i) => ({ title: serverName(i), value: i }))] });
    };
    const planUniform = async () => {
      uni.plans = null;
      const plans = await call('env:plan', { ids: uni.ids, referenceId: uni.ref || null, applyVars: uni.withVars });
      uni.plans = plans;
      uni.picks = plans.filter((p) => p.changed).map((p) => p.id);
    };
    const pickPlan = (id, v) => { uni.picks = v ? [...new Set([...uni.picks, id])] : uni.picks.filter((i) => i !== id); };
    const applyUniform = async () => {
      const items = uni.plans.filter((p) => uni.picks.includes(p.id)).map((p) => ({ id: p.id, content: p.after }));
      if (!confirm(`Écrire ${items.length} fichier(s) .env sur les serveurs ?`)) return;
      const res = await call('env:apply', { items });
      const bad = res.filter((r) => !r.ok);
      if (bad.length) notify(`${res.length - bad.length} écrit(s), ${bad.length} échec(s) : ${bad.map((b) => `${serverName(b.id)} (${b.error})`).join(' ; ')}`, 'error');
      else { notify(`${res.length} fichier(s) écrit(s).`, 'success'); uni.show = false; }
    };

    // ----- commandes en masse -----
    const cmd = ref('');
    const histPick = ref(null);
    const login = ref(true);
    const timeoutSec = ref(60);
    const results = reactive({});
    const runIds = ref([]);
    const running = ref(false);
    let currentRun = null;
    bridge.onExec((m) => {
      if (m.runId !== currentRun) return;
      const r = results[m.id];
      if (!r) return;
      if (m.kind === 'start') { r.badge = 'en cours'; r.color = 'primary'; }
      else if (m.kind === 'out' || m.kind === 'err') r.parts.push({ t: m.kind, s: m.data });
      else if (m.kind === 'end') {
        if (m.error) { r.parts.push({ t: 'err', s: `\n[${m.error}]` }); r.badge = 'erreur'; r.color = 'error'; }
        else { r.badge = `code ${m.code}`; r.color = m.code === 0 ? 'success' : 'error'; }
        if (!r.parts.length) r.parts.push({ t: 'out', s: '(aucune sortie)' });
      }
    });
    const execAll = async () => {
      const ids = checked.value.filter((i) => byId(i));
      const command = cmd.value.trim();
      if (!ids.length) throw new Error('Cochez au moins un serveur dans l’arbre.');
      if (!command) throw new Error('Commande vide.');
      if (/\b(rm\s+-\w*[rf]|reboot|shutdown|halt|mkfs|dd\s+if=)/.test(command) && !confirm(`Commande potentiellement destructrice sur ${ids.length} serveur(s) :\n\n${command}\n\nContinuer ?`)) return;
      if (ids.length > 1 && !confirm(`Exécuter sur ${ids.length} serveur(s) ?\n\n${command}`)) return;
      history.value = [command, ...history.value.filter((x) => x !== command)].slice(0, 30);
      persist().catch(() => {});
      Object.keys(results).forEach((k) => delete results[k]);
      ids.forEach((i) => (results[i] = { badge: 'en attente', color: undefined, parts: [] }));
      runIds.value = ids;
      currentRun = crypto.randomUUID();
      running.value = true;
      try { await call('exec:run', { runId: currentRun, ids, command, login: login.value, timeoutSec: Number(timeoutSec.value) || 60 }); }
      finally { running.value = false; }
    };
    const cancelRun = () => call('exec:cancel', { runId: currentRun });

    // ----- terminal interactif (xterm.js + shell SSH distant) -----
    const terms = ref([]);
    const activeTerm = ref(null);
    const instances = new Map();
    const refit = (termId) => nextTick(() => {
      const i = instances.get(termId);
      if (i) { try { i.fit.fit(); } catch { /* conteneur masqué */ } i.term.focus(); }
    });
    const openTerminal = async (id) => {
      const s = byId(id);
      const termId = crypto.randomUUID();
      terms.value.push({ termId, serverId: id, title: s.name });
      activeTerm.value = termId;
      view.value = 'terminal';
      await nextTick();
      const term = new Terminal({ fontSize: 13, cursorBlink: true, scrollback: 5000, theme: { background: '#111111' } });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById('t-' + termId));
      fit.fit();
      instances.set(termId, { term, fit });
      term.onData((data) => bridge.invoke('term:write', { termId, data }));
      // Copier / coller (la sélection xterm n'est pas une sélection DOM : le navigateur ne la voit pas).
      const doCopy = async () => { await call('clipboard:write', { text: term.getSelection() }); term.clearSelection(); };
      const doPaste = async () => { const text = await call('clipboard:read'); if (text) term.paste(text); };
      const safe = (fn) => fn().catch((err) => notify(err.message, 'error')).finally(() => term.focus());
      const isMac = navigator.platform.toLowerCase().includes('mac');
      // Mac : Cmd+C / Cmd+V. Windows/Linux : Ctrl+Shift+C / Ctrl+Shift+V, et Ctrl+C copie seulement s'il y a une sélection
      // (sinon il envoie l'interruption habituelle au serveur). Ctrl+V colle.
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== 'keydown') return true;
        const k = ev.key.toLowerCase();
        const copyKey = isMac ? ev.metaKey && !ev.ctrlKey && k === 'c' : ev.ctrlKey && k === 'c' && (ev.shiftKey || term.hasSelection());
        const pasteKey = isMac ? ev.metaKey && !ev.ctrlKey && k === 'v' : ev.ctrlKey && k === 'v';
        if (copyKey) { ev.preventDefault(); if (term.hasSelection()) safe(doCopy); return false; }
        if (pasteKey) { ev.preventDefault(); safe(doPaste); return false; }
        return true;
      });
      // Clic droit : copie la sélection s'il y en a une, sinon colle (comme Windows Terminal / PuTTY).
      document.getElementById('t-' + termId).addEventListener('contextmenu', (e) => {
        e.preventDefault();
        safe(term.hasSelection() ? doCopy : doPaste);
      });
      term.onResize(({ cols, rows }) => bridge.invoke('term:resize', { termId, cols, rows }));
      term.write(`Connexion à ${s.username}@${s.host}…\r\n`);
      try { await call('term:open', { termId, id, cols: term.cols, rows: term.rows }); term.focus(); }
      catch (e) { term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); notify(e.message, 'error'); }
    };
    const closeTerminal = async (termId) => {
      await bridge.invoke('term:close', { termId });
      const i = instances.get(termId);
      if (i) { i.term.dispose(); instances.delete(termId); }
      terms.value = terms.value.filter((t) => t.termId !== termId);
      if (activeTerm.value === termId) activeTerm.value = terms.value.length ? terms.value[terms.value.length - 1].termId : null;
    };
    bridge.onTerm((m) => {
      const i = instances.get(m.termId);
      if (!i) return;
      if (m.kind === 'data') i.term.write(m.data);
      else if (m.kind === 'close') i.term.write('\r\n\x1b[33m[connexion fermée — fermez l’onglet ou rouvrez un terminal]\x1b[0m\r\n');
    });
    watch(activeTerm, (t) => t && refit(t));
    watch(view, (v) => v === 'terminal' && activeTerm.value && refit(activeTerm.value));
    window.addEventListener('resize', () => view.value === 'terminal' && activeTerm.value && refit(activeTerm.value));

    return {
      themeMode, themeModes, setTheme,
      unlocked, vaultExists, vaultDir, pw, pw2, submitLock, lockVault, busy, run, snack,
      bulk, bulkActions, openBulk, planBulk, pickBulk, applyBulk, allKeys,
      mx, mxRows, loadMatrix, mxText, mxOdd, mxEdit, openMatrix,
      shExp, shImp, shExpCount, openShareExport, doShareExport, openShareImport, pickShare, confirmShare,
      rows, filter, rowClick, dragOver, dragDown, ghost,
      ctx, ren, openCtx, ctxBulk, ctxMatrix, ctxCheckOnly, ctxUniform, ctxCommands, ctxDuplicate, ctxDelete, ctxRename, confirmRename, checkState, toggle, checkedServers, serverName,
      view, draft, isNew, envText, showPw, authTypes, projects, envTypes, knownKeys,
      openServer, setVarType, duplicate, save, testConn, removeServer, loadEnv, applyVars, writeEnv,
      imp, openImport, pickImport, confirmImport,
      uni, openUniform, planUniform, pickPlan, applyUniform,
      cmd, histPick, history, login, timeoutSec, results, runIds, running, execAll, cancelRun,
      terms, activeTerm, openTerminal, closeTerminal,
    };
  },
}).use(Vuetify.createVuetify({ theme: { defaultTheme: 'dark' } })).mount('#app');
