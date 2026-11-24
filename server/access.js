import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { defaultEditorColor, normalizeEditorColor } from '../shared/editor-colors.js';

const derive = promisify(scrypt);
export const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
const ranks = { viewer: 1, reviewer: 2, editor: 3 };
export function normalizeEmail(value) {
  if (typeof value === 'string') value = value.trim();
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw fail(400, 'Enter a valid email.');
  return value.trim().toLowerCase();
}

export function initializeAccess(db, mode) {
  const columns = db.prepare('PRAGMA table_info(documents)').all().map(column => column.name);
  for (const [name, type] of [['scope', 'TEXT'], ['owner_id', 'TEXT'], ['owner_email', 'TEXT']]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
  }
  // A later auth-mode switch never turns private documents into public ones.
  db.prepare('UPDATE documents SET scope=? WHERE scope IS NULL').run(mode === 'oauth' ? 'unassigned' : 'shared');
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,email_verified INTEGER NOT NULL,name TEXT NOT NULL,UNIQUE(issuer,subject));
    CREATE TABLE IF NOT EXISTS document_grants(
      id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,parent_id TEXT REFERENCES document_grants(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,email TEXT,user_id TEXT,role TEXT NOT NULL,
      can_invite INTEGER NOT NULL,can_export INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER,
      token_hash TEXT UNIQUE,password_hash TEXT,created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS grants_document ON document_grants(document_id);
    CREATE INDEX IF NOT EXISTS grants_email ON document_grants(email,user_id);
    CREATE TABLE IF NOT EXISTS share_sessions(id TEXT PRIMARY KEY,visitor_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS share_unlocks(session_id TEXT NOT NULL REFERENCES share_sessions(id) ON DELETE CASCADE,grant_id TEXT NOT NULL REFERENCES document_grants(id) ON DELETE CASCADE,PRIMARY KEY(session_id,grant_id));
    CREATE TABLE IF NOT EXISTS document_leaves(document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,user_id TEXT NOT NULL,left_at INTEGER NOT NULL,PRIMARY KEY(document_id,user_id));
  `);
  if (!db.prepare('PRAGMA table_info(document_grants)').all().some(column => column.name === 'link_token')) {
    db.exec('ALTER TABLE document_grants ADD COLUMN link_token TEXT');
  }
  if (!db.prepare('PRAGMA table_info(share_sessions)').all().some(column => column.name === 'name')) {
    db.exec('ALTER TABLE share_sessions ADD COLUMN name TEXT');
  }
  if (!db.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'color')) {
    db.exec('ALTER TABLE accounts ADD COLUMN color TEXT');
  }
  if (!db.prepare('PRAGMA table_info(share_sessions)').all().some(column => column.name === 'color')) {
    db.exec('ALTER TABLE share_sessions ADD COLUMN color TEXT');
  }
}

export function createAccess(db, { mode, publicURL, changed = () => {} }) {
  initializeAccess(db, mode);
  function account(payload) {
    const id = digest(`${payload.iss}:${payload.sub}`);
    let email = null;
    try { email = normalizeEmail(payload.email); } catch { /* Email is optional until accepting an invitation. */ }
    const verified = Boolean(email && payload.email_verified === true);
    const name = String(payload.name || email || 'Writer').slice(0, 120);
    db.prepare(`INSERT INTO accounts(id,issuer,subject,email,email_verified,name) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,email_verified=excluded.email_verified,name=excluded.name`)
      .run(id, payload.iss, payload.sub, email, Number(verified), name);
    if (verified) {
      db.prepare('UPDATE document_grants SET user_id=? WHERE kind=? AND email=? AND user_id IS NULL AND revoked_at IS NULL').run(id, 'user', email);
      db.prepare("UPDATE documents SET owner_id=? WHERE scope='private' AND owner_id IS NULL AND owner_email=?").run(id, email);
    }
    const color = db.prepare('SELECT color FROM accounts WHERE id=?').get(id)?.color;
    return { id, name, email, emailVerified: verified, account: true, color: normalizeEditorColor(color) || defaultEditorColor(id) };
  }
  function cookie(req, name) {
    return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1);
  }
  function guest(req) {
    const raw = cookie(req, 'screenplay_share');
    if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = db.prepare('SELECT * FROM share_sessions WHERE id=? AND expires_at>?').get(digest(raw), Date.now());
    return row ? {
      id: row.visitor_id,
      name: row.name || `Guest ${row.visitor_id.slice(-4)}`,
      nameSet: Boolean(row.name),
      color: normalizeEditorColor(row.color) || defaultEditorColor(row.visitor_id),
      guest: true,
    } : null;
  }
  function setGuestProfile(req, profile) {
    if (!req.user?.guest) throw fail(403, 'Not permitted');
    const result = db.prepare('UPDATE share_sessions SET name=COALESCE(?,name),color=COALESCE(?,color) WHERE id=? AND visitor_id=? AND expires_at>?')
      .run(profile.name ?? null, profile.color ?? null, guestSession(req), req.user.id, Date.now());
    if (!result.changes) throw fail(401, 'Session expired');
    return guest(req);
  }
  function setGuestName(req, name) {
    return setGuestProfile(req, { name });
  }
  function setAccountColor(req, color) {
    if (!req.user?.account) throw fail(403, 'Not permitted');
    db.prepare('UPDATE accounts SET color=? WHERE id=?').run(color, req.user.id);
    return { ...req.user, color };
  }
  function guestSession(req) {
    const raw = cookie(req, 'screenplay_share');
    return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? digest(raw) : null;
  }
  function active(grant, seen = new Set()) {
    if (!grant || seen.has(grant.id) || seen.size >= 32 || grant.revoked_at || (grant.expires_at !== null && grant.expires_at <= Date.now())) return false;
    seen.add(grant.id);
    if (!grant.parent_id) return true;
    const parent = db.prepare('SELECT * FROM document_grants WHERE id=?').get(grant.parent_id);
    return parent?.document_id === grant.document_id && parent.can_invite && ranks[parent.role] >= ranks[grant.role] &&
      (!grant.can_invite || parent.can_invite) && (!grant.can_export || parent.can_export) && active(parent, seen);
  }
  function permission(req, id) {
    const document = db.prepare('SELECT id,scope,owner_id,archived_at FROM documents WHERE id=?').get(id);
    if (!document) throw fail(404, 'Document not found');
    const user = req.user;
    if (mode === 'none') {
      if (document.scope !== 'shared' || !user || user.account) throw fail(404, 'Document not found');
      return { owner: true, role: 'editor', canInvite: false, canExport: true, canEdit: true, canReview: true, grants: [] };
    }
    if (document.scope !== 'private' || !user) throw fail(404, 'Document not found');
    if (user.account && document.owner_id === user.id) return { owner: true, role: 'editor', canInvite: true, canExport: true, canEdit: true, canReview: true, grants: [] };
    const left = db.prepare('SELECT left_at FROM document_leaves WHERE document_id=? AND user_id=?').get(id, user.id);
    const session = guestSession(req);
    const grants = db.prepare(`SELECT DISTINCT g.* FROM document_grants g LEFT JOIN share_unlocks u ON u.grant_id=g.id
      LEFT JOIN share_sessions s ON s.id=u.session_id
      WHERE g.document_id=? AND ((g.kind='user' AND g.user_id=?) OR (g.kind='link' AND u.session_id=? AND s.expires_at>?))`)
      .all(id, user.account ? user.id : '', session || '', Date.now())
      .filter(grant => (!left || grant.created_at > left.left_at) && active(grant));
    if (!grants.length) throw fail(404, 'Document not found');
    const role = grants.reduce((role, grant) => ranks[grant.role] > ranks[role] ? grant.role : role, 'viewer');
    return { owner: false, role, canInvite: grants.some(g => g.can_invite), canExport: grants.some(g => g.can_export),
      canEdit: role === 'editor', canReview: role !== 'viewer', grants };
  }
  function requirePermission(req, id, action = 'view') {
    const access = permission(req, id);
    const allowed = { view: true, edit: access.canEdit, review: access.canReview, invite: access.canInvite, export: access.canExport, owner: access.owner };
    if (!allowed[action]) throw fail(403, 'Not permitted');
    return access;
  }
  function publicPermission(access) {
    const { grants, ...value } = access;
    return value;
  }
  function list(req, archived) {
    if (mode === 'oauth' && !req.user?.account) return [];
    return db.prepare(`SELECT id,title,updated_at AS updatedAt,archived_at AS archivedAt,owner_id AS ownerId FROM documents
      WHERE archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY updated_at DESC`).all().flatMap(document => {
      try { return [{ ...document, access: publicPermission(permission(req, document.id)) }]; } catch { return []; }
    });
  }
  async function passwordHash(password) {
    if (typeof password !== 'string' || password.length > 1024) throw fail(400, 'Invalid password');
    if (!password) return null;
    const salt = randomBytes(16).toString('hex');
    return `${salt}:${Buffer.from(await derive(password, salt, 64)).toString('hex')}`;
  }
  async function passwordMatches(password, encoded) {
    if (!encoded) return true;
    if (typeof password !== 'string' || password.length > 1024) return false;
    const [salt, expected] = encoded.split(':');
    return timingSafeEqual(Buffer.from(await derive(password, salt, 64)), Buffer.from(expected, 'hex'));
  }
  async function createGrant(req, id, body) {
    if (mode !== 'oauth') throw fail(404, 'Sharing requires OAuth');
    const access = requirePermission(req, id, 'invite');
    if (!['user', 'link'].includes(body.kind) || !Object.hasOwn(ranks, body.role) || typeof body.canInvite !== 'boolean' || typeof body.canExport !== 'boolean') throw fail(400, 'Invalid sharing permissions');
    let expires = body.expiresAt ?? null;
    if (expires !== null && (!Number.isSafeInteger(expires) || expires <= Date.now())) throw fail(400, 'Expiry must be in the future');
    let parent = null;
    if (!access.owner) {
      parent = access.grants.filter(g => g.can_invite && ranks[g.role] >= ranks[body.role] &&
        (!body.canExport || g.can_export) && (!body.canInvite || g.can_invite))
        .sort((a, b) => (b.expires_at ?? Infinity) - (a.expires_at ?? Infinity))[0];
      if (!parent) throw fail(403, 'Cannot grant more access than you have');
      let ancestor = parent;
      for (let depth = 0; ancestor; depth++) {
        if (depth >= 30) throw fail(400, 'Sharing chain is too long');
        if (ancestor.expires_at !== null) expires = Math.min(expires ?? Infinity, ancestor.expires_at);
        ancestor = ancestor.parent_id ? db.prepare('SELECT * FROM document_grants WHERE id=?').get(ancestor.parent_id) : null;
      }
    }
    const email = body.kind === 'user' ? normalizeEmail(body.email) : null;
    const recipient = email ? db.prepare('SELECT id FROM accounts WHERE email=? AND email_verified=1').get(email) : null;
    const raw = body.kind === 'link' ? randomBytes(32).toString('base64url') : null;
    const hash = body.kind === 'link' ? await passwordHash(body.password ?? '') : null;
    // Hashing yields to the event loop: authorization may have changed meanwhile.
    requirePermission(req, id, 'invite');
    if (parent && !active(db.prepare('SELECT * FROM document_grants WHERE id=?').get(parent.id))) throw fail(403, 'Invitation access expired');
    const grantId = randomUUID();
    const left = recipient && db.prepare('SELECT left_at FROM document_leaves WHERE document_id=? AND user_id=?').get(id, recipient.id);
    db.prepare(`INSERT INTO document_grants
      (id,document_id,kind,parent_id,created_by,email,user_id,role,can_invite,can_export,expires_at,revoked_at,token_hash,password_hash,created_at,link_token)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(grantId, id, body.kind, parent?.id || null, req.user.id, email, recipient?.id || null,
      body.role, Number(body.canInvite), Number(body.canExport), expires, null, raw ? digest(raw) : null, hash, Math.max(Date.now(), (left?.left_at ?? 0) + 1), raw);
    changed(id);
    return { id: grantId, url: raw ? new URL(`/share#${raw}`, publicURL).href : null, expiresAt: expires, email };
  }
  function shares(req, id) {
    const access = requirePermission(req, id);
    if (!access.owner && !access.canInvite) throw fail(403, 'Not permitted');
    return db.prepare(`SELECT id,kind,email,role,can_invite AS canInvite,can_export AS canExport,expires_at AS expiresAt,
      revoked_at AS revokedAt,created_by AS createdBy,parent_id AS parentId FROM document_grants WHERE document_id=? ${access.owner ? '' : 'AND created_by=?'} ORDER BY created_at DESC`)
      .all(...(access.owner ? [id] : [id, req.user.id])).map(grant => {
        const row = db.prepare('SELECT * FROM document_grants WHERE id=?').get(grant.id);
        const person = row.user_id && db.prepare('SELECT name FROM accounts WHERE id=?').get(row.user_id);
        const isActive = active(row);
        return { ...grant, name: person?.name || null, active: isActive,
          url: isActive && row.link_token ? new URL(`/share#${row.link_token}`, publicURL).href : null };
      });
  }
  function sharingInfo(req, id) {
    requirePermission(req, id);
    const document = db.prepare('SELECT owner_id,owner_email FROM documents WHERE id=?').get(id);
    const owner = db.prepare('SELECT name,email FROM accounts WHERE id=?').get(document.owner_id);
    return { owner: { name: owner?.name || 'Owner', email: owner?.email || document.owner_email || null } };
  }
  function updateGrant(req, id, grantId, body) {
    const access = requirePermission(req, id, 'invite');
    const grant = db.prepare('SELECT * FROM document_grants WHERE id=? AND document_id=?').get(grantId, id);
    if (!grant) throw fail(404, 'Share not found');
    if (!access.owner && grant.created_by !== req.user.id) throw fail(403, 'Not permitted');
    if (!active(grant)) throw fail(409, 'This share is no longer active. Create a new invitation.');
    if (!Object.hasOwn(ranks, body.role) || typeof body.canInvite !== 'boolean' || typeof body.canExport !== 'boolean') throw fail(400, 'Invalid sharing permissions');
    if (!access.owner) {
      const parent = db.prepare('SELECT * FROM document_grants WHERE id=?').get(grant.parent_id);
      if (!parent || !access.grants.some(item => item.id === parent.id) || !active(parent) ||
        !parent.can_invite || ranks[body.role] > ranks[parent.role] || (body.canExport && !parent.can_export)) {
        throw fail(403, 'Cannot grant more access than you have');
      }
    }
    db.prepare('UPDATE document_grants SET role=?,can_invite=?,can_export=? WHERE id=?')
      .run(body.role, Number(body.canInvite), Number(body.canExport), grantId);
    changed(id);
  }
  function revoke(req, id, grantId) {
    const access = requirePermission(req, id);
    const grant = db.prepare('SELECT * FROM document_grants WHERE id=? AND document_id=?').get(grantId, id);
    if (!grant) throw fail(404, 'Share not found');
    if (!access.owner && grant.created_by !== req.user.id) throw fail(403, 'Not permitted');
    db.prepare('UPDATE document_grants SET revoked_at=? WHERE id=?').run(Date.now(), grantId);
    changed(id);
  }
  function leave(req, id) {
    const access = requirePermission(req, id);
    if (!req.user?.account) throw fail(403, 'Only signed-in users can leave a document');
    if (access.owner || mode !== 'oauth') throw fail(403, 'Owners cannot leave their document');
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO document_leaves VALUES(?,?,?) ON CONFLICT(document_id,user_id) DO UPDATE SET left_at=excluded.left_at').run(id, req.user.id, now);
      db.prepare('UPDATE document_grants SET revoked_at=? WHERE document_id=? AND (user_id=? OR created_by=?)').run(now, id, req.user.id, req.user.id);
      if (req.user.account) {
        const email = db.prepare('SELECT email FROM accounts WHERE id=? AND email_verified=1').get(req.user.id)?.email;
        if (email) db.prepare("UPDATE document_grants SET revoked_at=? WHERE document_id=? AND kind='user' AND user_id IS NULL AND email=?").run(now, id, email);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    changed(id);
  }
  const attempts = new Map();
  async function openLink(req, res, body) {
    if (mode !== 'oauth') throw fail(404, 'Sharing requires OAuth');
    if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw fail(404, 'Link unavailable');
    const grant = db.prepare("SELECT * FROM document_grants WHERE token_hash=? AND kind='link'").get(digest(body.token));
    if (!active(grant)) throw fail(404, 'Link unavailable');
    const key = `${req.socket.remoteAddress}:${digest(body.token)}`;
    const now = Date.now();
    const previous = attempts.get(key);
    const attempt = previous?.until > now ? previous : { count: 0, until: now + 900000 };
    if (attempts.size >= 5000 && !attempts.has(key)) throw fail(429, 'Try again later');
    attempts.set(key, attempt);
    if (++attempt.count > 10) throw fail(429, 'Try again later');
    const actor = req.user || guest(req);
    const left = actor && db.prepare('SELECT left_at FROM document_leaves WHERE document_id=? AND user_id=?').get(grant.document_id, actor.id);
    if (left && grant.created_at <= left.left_at) throw fail(403, 'Ask for a new invitation');
    if (!await passwordMatches(body.password, grant.password_hash)) throw fail(401, 'Password required or incorrect');
    if (!active(db.prepare('SELECT * FROM document_grants WHERE id=?').get(grant.id))) throw fail(404, 'Link unavailable');
    attempts.delete(key);
    let session = guestSession(req);
    let row = session && db.prepare('SELECT * FROM share_sessions WHERE id=? AND expires_at>?').get(session, now);
    if (!row) {
      const raw = randomBytes(32).toString('base64url');
      session = digest(raw);
      row = { visitor_id: `guest:${randomUUID()}` };
      db.prepare('INSERT INTO share_sessions(id,visitor_id,expires_at) VALUES(?,?,?)').run(session, row.visitor_id, now + 7 * 86400000);
      res.cookie('screenplay_share', raw, { httpOnly: true, secure: publicURL.protocol === 'https:', sameSite: 'lax', path: '/', maxAge: 7 * 86400000 });
    }
    db.prepare('INSERT OR IGNORE INTO share_unlocks VALUES(?,?)').run(session, grant.id);
    return { documentId: grant.document_id };
  }
  function cleanup() {
    for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
    db.prepare('DELETE FROM share_sessions WHERE expires_at<=?').run(Date.now());
  }
  return { account, guest, setGuestName, setGuestProfile, setAccountColor, permission, requirePermission, publicPermission, list, createGrant, shares, sharingInfo, updateGrant, revoke, leave, openLink, cleanup };
}
