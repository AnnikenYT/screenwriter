import express from 'express';
import multer from 'multer';
import { WebSocketServer, WebSocket } from 'ws';
import * as Y from 'yjs';
import * as sync from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { renderPDF } from './pdf.js';
import { reconcileSheets } from '../shared/entities.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textNames = ['screenplay', 'scratchpad'];
const mapNames = ['meta', 'characters', 'locations', 'comments', 'suggestions'];
const cookieName = 'screenplay_session';
const fail = (status, message) => Object.assign(new Error(message), { status });
const token = () => randomBytes(32).toString('base64url');
const sha = value => createHash('sha256').update(value).digest('hex');

export function createWorkspace(options = {}) {
  const env = { ...process.env, ...options };
  env.OIDC_CLIENT_ID ||= env.CLIENT_ID;
  env.OIDC_CLIENT_SECRET ||= env.CLIENT_SECRET;
  const authMode = env.AUTH_MODE || 'none';
  if (!['none', 'oauth'].includes(authMode)) throw new Error('AUTH_MODE must be none or oauth');
  const publicURL = new URL(env.PUBLIC_URL || 'http://localhost:3000');
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const maxUpdate = Number(env.MAX_UPDATE_BYTES || 2 * 1024 * 1024);
  const maxDocument = Number(env.MAX_DOCUMENT_BYTES || 8 * 1024 * 1024);
  const maxHistory = Number(env.MAX_HISTORY_BYTES || maxDocument * 8);
  const compactAfter = Number(env.COMPACT_AFTER_UPDATES || 1000);
  const maxImage = Number(env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);
  const cacheLimit = Number(env.MAX_CACHED_DOCUMENTS || 100);
  const sessionAge = 7 * 86400_000;
  mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'workspace.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,state BLOB NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),label TEXT NOT NULL,created_at INTEGER NOT NULL,state BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS versions_document ON versions(document_id,created_at);
    CREATE TABLE IF NOT EXISTS document_updates(sequence INTEGER PRIMARY KEY AUTOINCREMENT,document_id TEXT NOT NULL REFERENCES documents(id),state BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS updates_document ON document_updates(document_id,sequence);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id),filename TEXT UNIQUE NOT NULL,mime TEXT NOT NULL);
  `);
  const appendUpdate = db.prepare('INSERT INTO document_updates(document_id,state) VALUES(?,?)');
  const updateMetadata = db.prepare('UPDATE documents SET title=?,updated_at=? WHERE id=?');
  const selectUpdates = db.prepare('SELECT state FROM document_updates WHERE document_id=? ORDER BY sequence');
  const deleteUpdates = db.prepare('DELETE FROM document_updates WHERE document_id=?');
  const updateBase = db.prepare('UPDATE documents SET state=? WHERE id=?');
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  function session(req) {
    const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const record = db.prepare('SELECT user FROM sessions WHERE id=? AND expires>?').get(sha(raw), Date.now());
    return record ? JSON.parse(record.user) : null;
  }
  function sessionKey(req) {
    const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? sha(raw) : null;
  }
  function activeSession(key) {
    return key && Boolean(db.prepare('SELECT 1 FROM sessions WHERE id=? AND expires>?').get(key, Date.now()));
  }
  function setSession(res, user) {
    const raw = token();
    const key = sha(raw);
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(key, JSON.stringify(user), Date.now() + sessionAge);
    res.cookie(cookieName, raw, { httpOnly: true, secure: publicURL.protocol === 'https:', sameSite: 'lax', maxAge: sessionAge, path: '/' });
    return key;
  }
  const allowedOrigin = req => !req.headers.origin || req.headers.origin === publicURL.origin;
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !allowedOrigin(req)) return next(fail(403, 'Cross-origin request denied'));
    next();
  });
  app.use(express.json({ limit: maxUpdate }));
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    req.user = session(req);
    req.sessionKey = sessionKey(req);
    if (!req.user && authMode === 'none') {
      req.user = { id: randomUUID(), name: `Writer ${randomBytes(2).toString('hex')}`, color: ['#c2410c', '#2563eb', '#7c3aed', '#047857'][randomBytes(1)[0] % 4] };
      req.sessionKey = setSession(res, req.user);
    }
    next();
  });
  app.get('/api/session', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authMode, user: req.user || null });
  });
  app.patch('/api/session', (req, res) => {
    if (authMode !== 'none') throw fail(403, 'Display names are managed by your identity provider');
    const name = req.body?.name;
    if (typeof name !== 'string' || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name) ||
      name.trim().length < 1 || name.trim().length > 60) throw fail(400, 'Name must be 1–60 characters on one line, without control characters');
    const user = { ...req.user, name: name.trim() };
    db.prepare('UPDATE sessions SET user=? WHERE id=? AND expires>?').run(JSON.stringify(user), req.sessionKey, Date.now());
    res.setHeader('Cache-Control', 'no-store');
    res.json({ authMode, user });
  });
  let discoveryPromise;
  async function discovery() {
    if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) throw fail(503, 'OIDC is not configured');
    discoveryPromise ||= (async () => {
      const issuer = env.OIDC_ISSUER.replace(/\/$/, '');
      const result = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
      if (!result.ok) throw fail(502, 'OIDC discovery failed');
      const metadata = await result.json();
      if (metadata.issuer !== env.OIDC_ISSUER) throw fail(502, 'OIDC issuer mismatch');
      return { ...metadata, keys: createRemoteJWKSet(new URL(metadata.jwks_uri)) };
    })().catch(error => { discoveryPromise = null; throw error; });
    return discoveryPromise;
  }
  const pendingLogins = new Map();
  app.get('/auth/login', async (req, res) => {
    if (authMode === 'none') return res.redirect('/');
    const oidc = await discovery();
    if (pendingLogins.size >= 1000) throw fail(429, 'Too many login attempts');
    const state = token(), verifier = token(), nonce = token();
    pendingLogins.set(state, { verifier, nonce, expires: Date.now() + 600000 });
    res.cookie('screenplay_login', state, { httpOnly: true, secure: publicURL.protocol === 'https:', sameSite: 'lax', maxAge: 600000, path: '/auth' });
    const url = new URL(oidc.authorization_endpoint);
    const params = { client_id: env.OIDC_CLIENT_ID, redirect_uri: new URL('/auth/callback', publicURL).href, response_type: 'code', scope: 'openid profile email', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    res.redirect(url.href);
  });
  app.get('/auth/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const pending = pendingLogins.get(state);
    pendingLogins.delete(state);
    const loginCookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('screenplay_login='))?.slice(17);
    if (!pending || pending.expires < Date.now() || loginCookie !== state || typeof req.query.code !== 'string') throw fail(400, 'Invalid login state');
    res.clearCookie('screenplay_login', { path: '/auth' });
    const oidc = await discovery();
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: new URL('/auth/callback', publicURL).href, client_id: env.OIDC_CLIENT_ID, code_verifier: pending.verifier });
    const method = oidc.token_endpoint_auth_methods_supported?.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (method === 'client_secret_post') body.set('client_secret', env.OIDC_CLIENT_SECRET);
    else headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(env.OIDC_CLIENT_ID)}:${encodeURIComponent(env.OIDC_CLIENT_SECRET)}`).toString('base64')}`;
    const result = await fetch(oidc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw fail(401, 'Token exchange failed');
    const tokens = await result.json();
    let payload;
    try {
      ({ payload } = await jwtVerify(tokens.id_token, oidc.keys, {
        issuer: env.OIDC_ISSUER, audience: env.OIDC_CLIENT_ID,
        algorithms: ['RS256', 'PS256', 'ES256'],
        requiredClaims: ['exp', 'iat', 'sub', 'aud', 'iss'],
      }));
    } catch { throw fail(401, 'Invalid identity token'); }
    const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
    if (payload.nonce !== pending.nonce || typeof payload.sub !== 'string' || !payload.sub ||
      ((multipleAudiences || Object.hasOwn(payload, 'azp')) && payload.azp !== env.OIDC_CLIENT_ID)) throw fail(401, 'Invalid identity');
    const domains = (env.OIDC_ALLOWED_EMAIL_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (domains.length && (payload.email_verified !== true || !domains.includes(String(payload.email || '').split('@')[1]?.toLowerCase()))) throw fail(403, 'Email domain is not allowed');
    setSession(res, { id: sha(`${payload.iss}:${payload.sub}`), name: String(payload.name || payload.email || 'Writer').slice(0, 120), color: '#2563eb' });
    res.redirect('/');
  });
  app.all('/auth/logout', (req, res) => {
    // GET logout is intentionally supported for ordinary navigation links.
    if (!allowedOrigin(req)) throw fail(403, 'Cross-origin request denied');
    const key = sessionKey(req);
    if (key) {
      db.prepare('DELETE FROM sessions WHERE id=?').run(key);
      // Stop both outgoing and incoming traffic immediately, including idle tabs.
      for (const ws of wss.clients) if (ws.sessionKey === key) ws.close(1008, 'Logged out');
    }
    res.clearCookie(cookieName, { path: '/' });
    res.redirect('/');
  });
  function requireUser(req, res, next) {
    if (!req.user) return next(fail(401, 'Authentication required'));
    next();
  }
  app.use(['/api', '/uploads'], requireUser, (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const documents = new Map();
  function scheduleReconciliation(entry) {
    clearTimeout(entry.reconcileTimer);
    entry.reconcileTimer = setTimeout(() => {
      entry.reconcileTimer = null;
      if (documents.get(entry.id) !== entry) return;
      // Out-of-order Yjs deltas may be waiting on earlier client structs.
      // Never prune sheets against that incomplete source.
      if (entry.doc.store.pendingStructs || entry.doc.store.pendingDs) {
        scheduleReconciliation(entry);
        return;
      }
      try { reconcileSheets(entry.doc); }
      catch (error) {
        console.error('Sheet reconciliation failed:', error.message);
        discardRoom(entry.id, entry);
      }
    }, 800);
    entry.reconcileTimer.unref();
  }
  function titleOf(doc) { return String(doc.getMap('meta').get('title') || 'Untitled screenplay').slice(0, 200); }
  function prune() {
    for (const [id, entry] of documents) {
      if (documents.size < cacheLimit) break;
      if (!entry.clients.size) {
        if (entry.dirty) snapshot(id, 'Automatic snapshot');
        else compact(id, entry);
        clearTimeout(entry.reconcileTimer);
        entry.awareness.destroy(); entry.doc.destroy(); documents.delete(id);
      }
    }
  }
  function getDocument(id) {
    if (!uuidPattern.test(id)) throw fail(404, 'Document not found');
    if (documents.has(id)) return documents.get(id);
    const row = db.prepare('SELECT state FROM documents WHERE id=?').get(id);
    if (!row) throw fail(404, 'Document not found');
    prune();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.state));
    const updates = selectUpdates.all(id);
    for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update.state));
    textNames.forEach(name => doc.getText(name));
    mapNames.forEach(name => doc.getMap(name));
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const entry = { id, doc, awareness, clients: new Map(), dirty: updates.length > 0, journalCount: updates.length, historyBytes: row.state.length + updates.reduce((sum, update) => sum + update.state.length, 0), applying: false, broadcasts: [] };
    documents.set(id, entry);
    doc.on('update', update => {
      if (entry.applying) { entry.broadcasts.push(update); return; }
      validateDocument(entry);
      persistUpdate(id, entry, update);
      broadcastUpdate(entry, update);
    });
    doc.getText('screenplay').observe(() => scheduleReconciliation(entry));
    scheduleReconciliation(entry);
    awareness.on('update', ({ added, updated, removed }, origin) => {
      if (entry.clients.has(origin)) {
        const ids = entry.clients.get(origin);
        added.forEach(id => ids.add(id));
        removed.forEach(id => ids.delete(id));
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 1);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
      broadcast(entry, encoding.toUint8Array(encoder));
    });
    return entry;
  }
  function validateDocument(entry) {
    // Y.Text.length is maintained by Yjs, so this does not scan the script.
    if (textNames.reduce((size, name) => size + entry.doc.getText(name).length, 0) > maxDocument) throw fail(413, 'Source length limit exceeded');
    for (const name of entry.doc.share.keys()) if (![...textNames, ...mapNames].includes(name)) throw fail(400, 'Unknown shared type');
  }
  function compact(id, entry, state = Y.encodeStateAsUpdate(entry.doc)) {
    transaction(() => { updateBase.run(state, id); deleteUpdates.run(id); });
    entry.journalCount = 0;
    entry.historyBytes = state.length;
  }
  function persistUpdate(id, entry, update) {
    // One FULL-synchronous commit per update, never a full-document encode.
    transaction(() => {
      appendUpdate.run(id, update);
      updateMetadata.run(titleOf(entry.doc), Date.now(), id);
    });
    entry.dirty = true;
    entry.journalCount++;
    entry.historyBytes += update.length;
  }
  function broadcastUpdate(entry, update) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    sync.writeUpdate(encoder, update);
    broadcast(entry, encoding.toUint8Array(encoder));
  }
  function discardRoom(id, entry) {
    // Malformed semantic updates can partially mutate Yjs. Never journal or
    // broadcast them: drop the room and reconnect from the last durable state.
    documents.delete(id);
    clearTimeout(entry.reconcileTimer);
    for (const ws of entry.clients.keys()) ws.close(1008, 'Room reset after invalid update');
    entry.awareness.destroy();
    entry.doc.destroy();
  }
  function applyIncoming(id, entry, update, ws) {
    // Decode only the bounded incoming delta, not the complete screenplay.
    const decoded = Y.decodeUpdate(update);
    if (!decoded.structs.length && !decoded.ds.clients.size) return;
    for (const struct of decoded.structs) {
      if (typeof struct.parent === 'string' && ![...textNames, ...mapNames].includes(struct.parent)) throw new Error('Unknown shared type');
      if (struct.content instanceof Y.ContentType || struct.content instanceof Y.ContentDoc) throw new Error('Nested shared types are not supported');
    }
    if (entry.journalCount >= compactAfter || entry.historyBytes + update.length > maxHistory) compact(id, entry);
    if (entry.historyBytes + update.length > maxHistory) throw new Error('CRDT history limit exceeded');
    entry.applying = true;
    entry.broadcasts = [];
    try {
      Y.applyUpdate(entry.doc, update, ws);
      validateDocument(entry);
      // Store the original delta, including any out-of-order pending structs.
      persistUpdate(id, entry, update);
      for (const outgoing of entry.broadcasts) broadcastUpdate(entry, outgoing);
    } catch (error) {
      discardRoom(id, entry);
      throw error;
    } finally {
      entry.applying = false;
      entry.broadcasts = [];
    }
  }
  function broadcast(entry, message) {
    for (const ws of entry.clients.keys()) {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < maxDocument * 2) ws.send(message);
      else if (ws.readyState === WebSocket.OPEN) ws.close(1013, 'Slow client');
    }
  }
  function snapshot(id, label) {
    const entry = getDocument(id);
    const version = { id: randomUUID(), label: String(label || 'Saved version').slice(0, 200), createdAt: Date.now() };
    const state = Y.encodeStateAsUpdate(entry.doc);
    transaction(() => {
      db.prepare('INSERT INTO versions VALUES(?,?,?,?,?)').run(version.id, id, version.label, version.createdAt, state);
      updateBase.run(state, id);
      deleteUpdates.run(id);
    });
    entry.historyBytes = state.length;
    entry.journalCount = 0;
    entry.dirty = false;
    return version;
  }
  function getVersion(id, versionId) {
    getDocument(id);
    const row = db.prepare('SELECT * FROM versions WHERE id=? AND document_id=?').get(versionId, id);
    if (!row) throw fail(404, 'Version not found');
    return row;
  }
  app.get('/api/documents', (req, res) => res.json(db.prepare('SELECT id,title,updated_at AS updatedAt FROM documents ORDER BY updated_at DESC').all()));
  app.post('/api/documents', (req, res) => {
    const title = String(req.body?.title || 'Untitled screenplay').slice(0, 200);
    const text = req.body?.text ?? '';
    if (typeof text !== 'string' || Buffer.byteLength(text) > Math.min(maxUpdate, maxDocument)) throw fail(413, 'Document text too large');
    const doc = new Y.Doc(), id = randomUUID();
    doc.getText('screenplay').insert(0, text);
    doc.getMap('meta').set('title', title);
    reconcileSheets(doc);
    db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(id, title, Y.encodeStateAsUpdate(doc), Date.now());
    doc.destroy();
    res.status(201).json({ id, title });
  });
  app.get('/api/documents/:id/versions', (req, res) => {
    getDocument(req.params.id);
    res.json(db.prepare('SELECT id,label,created_at AS createdAt FROM versions WHERE document_id=? ORDER BY created_at DESC').all(req.params.id));
  });
  app.post('/api/documents/:id/versions', (req, res) => res.status(201).json(snapshot(req.params.id, req.body?.label)));
  app.get('/api/documents/:id/versions/:versionId', (req, res) => {
    const row = getVersion(req.params.id, req.params.versionId), doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(row.state));
    res.json({ id: row.id, label: row.label, createdAt: row.created_at, text: doc.getText('screenplay').toString(), scratchpad: doc.getText('scratchpad').toString() });
    doc.destroy();
  });
  app.post('/api/documents/:id/versions/:versionId/restore', (req, res) => {
    const row = getVersion(req.params.id, req.params.versionId);
    const entry = getDocument(req.params.id), old = new Y.Doc();
    Y.applyUpdate(old, new Uint8Array(row.state));
    snapshot(req.params.id, 'Before restore');
    entry.doc.transact(() => {
      for (const name of textNames) {
        const target = entry.doc.getText(name);
        target.delete(0, target.length);
        target.applyDelta(old.getText(name).toDelta());
      }
      for (const name of mapNames) {
        const target = entry.doc.getMap(name);
        target.clear();
        for (const [key, value] of old.getMap(name)) {
          if ((['comments', 'suggestions'].includes(name) || (name === 'meta' && key.startsWith('image-link:'))) && value?.anchor) {
            let anchor = null;
            try {
              const start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.anchor.start), old);
              const end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.anchor.end), old);
              if (start?.type === old.getText('screenplay') && end?.type === start.type) {
                const text = entry.doc.getText('screenplay');
                anchor = {
                  start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, start.index, start.assoc)),
                  end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, Math.max(start.index, end.index), end.assoc)),
                };
              }
            } catch { /* Leave an unresolvable historical anchor explicitly detached. */ }
            target.set(key, { ...value, anchor });
          } else target.set(key, value);
        }
      }
    }, 'restore');
    old.destroy();
    res.json({ ok: true });
  });
  app.post('/api/documents/:id/suggestions/:suggestionId/decide', (req, res) => {
    const decision = req.body?.decision;
    if (!['accepted', 'rejected'].includes(decision)) throw fail(400, 'Decision must be accepted or rejected');
    const { doc } = getDocument(req.params.id);
    const suggestions = doc.getMap('suggestions');
    const suggestion = suggestions.get(req.params.suggestionId);
    if (!suggestion) throw fail(404, 'Suggestion not found');
    if (suggestion.status !== 'pending') throw fail(409, 'Suggestion has already been decided');
    const text = doc.getText('screenplay');
    let start, end;
    try {
      start = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(suggestion.anchor.start), doc);
      end = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(suggestion.anchor.end), doc);
    } catch { /* Invalid anchors are treated as stale, never as index zero. */ }
    if (decision === 'accepted' && (typeof suggestion.original !== 'string' || typeof suggestion.replacement !== 'string' ||
      !start || !end || start.type !== text || end.type !== text || end.index < start.index ||
      text.toString().slice(start.index, end.index) !== suggestion.original)) throw fail(409, 'Suggestion source has changed or its anchor is stale');
    if (decision === 'accepted' && (Buffer.byteLength(suggestion.replacement) > maxUpdate ||
      text.length - (end.index - start.index) + suggestion.replacement.length > maxDocument)) throw fail(413, 'Replacement exceeds source limits');
    // Resolve annotations before deleting their source structs. Relative
    // anchors alone cannot distinguish a replaced selection from tombstones.
    const annotations = [];
    for (const name of ['comments', 'meta']) {
      const map = doc.getMap(name);
      for (const [key, value] of map) {
        if ((name === 'meta' && !key.startsWith('image-link:')) || !value || typeof value !== 'object') continue;
        if (value.proposal?.id === req.params.suggestionId) {
          annotations.push({ map, key, value, proposal: true, image: name === 'meta' });
        } else if (decision === 'accepted' && !value.proposal) {
          try {
            const a = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.anchor.start), doc);
            const b = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(value.anchor.end), doc);
            if (a?.type === text && b?.type === text && a.index <= b.index &&
              a.index < end.index && b.index > start.index) annotations.push({ map, key, value, from: a.index, to: b.index });
          } catch { /* Detached annotations stay detached. */ }
        }
      }
    }
    const replacementLength = typeof suggestion.replacement === 'string' ? suggestion.replacement.length : 0;
    const clampOffset = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(replacementLength, Math.trunc(value))) : fallback;
    const anchorAt = (index, assoc) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index, assoc));
    const translateEndpoint = (index, original, assoc) => {
      if (index < start.index || index > end.index) return original;
      const offset = index === end.index ? replacementLength : Math.min(replacementLength, index - start.index);
      return anchorAt(start.index + offset, assoc);
    };
    // This synchronous handler runs to completion against the authoritative
    // room before another HTTP decision can inspect its status.
    doc.transact(() => {
      if (decision === 'accepted') {
        text.delete(start.index, end.index - start.index);
        if (suggestion.replacement) text.insert(start.index, suggestion.replacement);
      }
      for (const annotation of annotations) {
        const { map, key, value } = annotation;
        if (annotation.proposal) {
          if (decision === 'rejected' && annotation.image) { map.delete(key); continue; }
          const { proposal, ...updated } = value;
          if (decision === 'accepted') {
            const from = clampOffset(proposal.from, 0);
            const to = Math.max(from, clampOffset(proposal.to, replacementLength));
            updated.anchor = { start: anchorAt(start.index + from, 0), end: anchorAt(start.index + to, -1) };
          }
          map.set(key, updated);
        } else {
          map.set(key, { ...value, anchor: {
            start: translateEndpoint(annotation.from, value.anchor.start, 0),
            end: translateEndpoint(annotation.to, value.anchor.end, -1),
          } });
        }
      }
      suggestions.set(req.params.suggestionId, { ...suggestion, status: decision, decidedBy: req.user.name });
    }, 'suggestion-decision');
    res.json({ ok: true });
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxImage, files: 1, fields: 0, parts: 1 } });
  function imageType(bytes) {
    if (bytes.length < 16) return null;
    if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.subarray(12, 16).toString() === 'IHDR') return ['png', 'image/png'];
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return ['jpg', 'image/jpeg'];
    if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) && bytes.at(-1) === 59) return ['gif', 'image/gif'];
    if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return ['webp', 'image/webp'];
    return null;
  }
  app.post('/api/documents/:id/images', (req, res, next) => { getDocument(req.params.id); next(); }, upload.single('image'), (req, res) => {
    const type = req.file && imageType(req.file.buffer);
    if (!type) throw fail(415, 'Only PNG, JPEG, GIF and WebP images are accepted');
    const id = randomUUID(), filename = `${id}.${type[0]}`;
    const destination = path.join(dataDir, 'uploads', filename);
    writeFileSync(destination, req.file.buffer, { flag: 'wx', mode: 0o600 });
    try { db.prepare('INSERT INTO images VALUES(?,?,?,?)').run(id, req.params.id, filename, type[1]); }
    catch (error) { unlinkSync(destination); throw error; }
    res.status(201).json({ id, url: `/uploads/${filename}` });
  });
  app.get('/uploads/:filename', (req, res) => {
    if (!/^[0-9a-f-]{36}\.(?:png|jpg|gif|webp)$/.test(req.params.filename)) throw fail(404, 'Image not found');
    const row = db.prepare('SELECT mime FROM images WHERE filename=?').get(req.params.filename);
    if (!row) throw fail(404, 'Image not found');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.type(row.mime).sendFile(req.params.filename, { root: path.join(dataDir, 'uploads') });
  });
  app.get('/api/documents/:id/export.pdf', (req, res) => {
    const { doc } = getDocument(req.params.id);
    res.type('application/pdf');
    res.setHeader('Content-Disposition', "attachment; filename=\"screenplay.pdf\"");
    renderPDF(doc.getText('screenplay').toString(), titleOf(doc), res);
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    next();
  });
  app.use(express.static(path.join(sourceRoot, 'dist'), { index: false }));
  app.get('/{*path}', (req, res, next) => {
    if (req.path.startsWith('/uploads') || req.path.startsWith('/auth') || req.path.startsWith('/collaboration')) return next(fail(404, 'Not found'));
    res.sendFile('index.html', { root: path.join(sourceRoot, 'dist') });
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error instanceof multer.MulterError ? 400 : error.status || 500;
    if (status >= 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : error.message });
  });
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxUpdate, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    try {
      if (!allowedOrigin(req)) return reject('403 Forbidden');
      if (authMode === 'oauth' && !session(req)) return reject('401 Unauthorized');
      const pathname = new URL(req.url, publicURL).pathname;
      const match = /^\/collaboration\/([0-9a-f-]+)$/.exec(pathname);
      if (!match) return reject('404 Not Found');
      const entry = getDocument(match[1]);
      if (wss.clients.size >= Number(env.MAX_WEBSOCKETS || 1000)) return reject('503 Service Unavailable');
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, entry));
    } catch { reject('404 Not Found'); }
  });
  wss.on('connection', (ws, req, entry) => {
    ws.sessionKey = sessionKey(req);
    entry.clients.set(ws, new Set());
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const initial = encoding.createEncoder();
    encoding.writeVarUint(initial, 0);
    sync.writeSyncStep1(initial, entry.doc);
    ws.send(encoding.toUint8Array(initial));
    const known = [...entry.awareness.getStates().keys()];
    if (known.length) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 1);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, known));
      ws.send(encoding.toUint8Array(e));
    }
    let windowStart = Date.now(), bytes = 0;
    ws.on('message', (data, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN || documents.get(entry.id) !== entry) return;
      try {
        if (!isBinary) throw new Error('Binary protocol required');
        if (Date.now() - windowStart > 10000) { windowStart = Date.now(); bytes = 0; }
        bytes += data.length;
        if (bytes > maxDocument * 2) throw new Error('Rate limit exceeded');
        if (authMode === 'oauth' && !session(req)) { ws.close(1008, 'Session expired'); return; }
        const decoder = decoding.createDecoder(new Uint8Array(data));
        const type = decoding.readVarUint(decoder);
        const reply = encoding.createEncoder();
        if (type === 0) {
          encoding.writeVarUint(reply, 0);
          const subtype = decoding.readVarUint(decoder);
          if (subtype === 0) sync.readSyncStep1(decoder, reply, entry.doc);
          else if (subtype === 1 || subtype === 2) {
            const update = decoding.readVarUint8Array(decoder);
            applyIncoming(entry.id, entry, update, ws);
          } else throw new Error('Unknown sync message');
          if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
        } else if (type === 1) {
          const update = decoding.readVarUint8Array(decoder);
          if (update.length > 65536) throw new Error('Awareness limit exceeded');
          const inspect = decoding.createDecoder(update);
          const count = decoding.readVarUint(inspect);
          // Providers echo remote awareness states as well as their own.
          if (count > 1024 || entry.awareness.getStates().size > 4096) throw new Error('Too many awareness states');
          for (let i = 0; i < count; i++) {
            decoding.readVarUint(inspect);
            decoding.readVarUint(inspect);
            JSON.parse(decoding.readVarString(inspect));
          }
          awarenessProtocol.applyAwarenessUpdate(entry.awareness, update, ws);
        } else if (type === 3) {
          encoding.writeVarUint(reply, 1);
          encoding.writeVarUint8Array(reply, awarenessProtocol.encodeAwarenessUpdate(entry.awareness, [...entry.awareness.getStates().keys()]));
          ws.send(encoding.toUint8Array(reply));
        } else throw new Error('Unknown message');
      } catch { ws.close(1008, 'Invalid or oversized collaboration message'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      const ids = entry.clients.get(ws);
      entry.clients.delete(ws);
      awarenessProtocol.removeAwarenessStates(entry.awareness, [...(ids || [])], null);
    });
  });
  const maintenance = setInterval(() => {
    for (const ws of wss.clients) {
      if (authMode === 'oauth' && !activeSession(ws.sessionKey)) ws.close(1008, 'Session expired');
      else if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
    for (const [state, login] of pendingLogins) if (login.expires < Date.now()) pendingLogins.delete(state);
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  }, Number(env.HEARTBEAT_INTERVAL_MS || 30000));
  maintenance.unref();
  const autosnapshot = setInterval(() => {
    for (const [id, entry] of documents) if (entry.dirty) snapshot(id, 'Automatic snapshot');
    prune();
  }, Number(env.AUTOSNAPSHOT_INTERVAL_MS || 300000));
  autosnapshot.unref();
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(maintenance); clearInterval(autosnapshot);
    for (const entry of documents.values()) clearTimeout(entry.reconcileTimer);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    for (const entry of documents.values()) { entry.awareness.destroy(); entry.doc.destroy(); }
    db.close();
  }
  return { app, server, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = createWorkspace();
  workspace.server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Screenplay workspace listening on ${process.env.PORT || 3000}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { workspace.close().then(() => process.exit(0)); });
}
