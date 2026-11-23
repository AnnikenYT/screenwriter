import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initializeAccess, normalizeEmail } from './access.js';

// AUTH_MODE=oauth DATA_DIR=/data node server/ownership.js owners.json [--apply]
const filename = process.argv[2];
if (!filename || process.argv.slice(3).some(arg => arg !== '--apply')) throw new Error('Usage: node server/ownership.js --list | owners.json [--apply]');
if (process.env.AUTH_MODE !== 'oauth') throw new Error('Set AUTH_MODE=oauth for ownership migration');
const apply = process.argv.includes('--apply');
const db = new DatabaseSync(path.join(process.env.DATA_DIR || './data', 'workspace.sqlite'), { readOnly: !apply });
function migrate() {
  if (filename === '--list') {
    for (const row of db.prepare('SELECT id,title FROM documents ORDER BY title').all()) console.log(`${row.id}\t${row.title}`);
    return;
  }
  const mapping = JSON.parse(readFileSync(filename, 'utf8'));
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object') throw new Error('Expected {"document-id":"owner@example.com"}');
  const columns = db.prepare('PRAGMA table_info(documents)').all().map(column => column.name);
  const assignments = Object.entries(mapping).map(([id, email]) => {
    const row = db.prepare(`SELECT id,title${columns.includes('owner_id') ? ',owner_id' : ''} FROM documents WHERE id=?`).get(id);
    if (!row) throw new Error(`Document not found: ${id}`);
    if (row.owner_id) throw new Error(`Document already has an owner: ${id}`);
    return { ...row, email: normalizeEmail(email) };
  });
  if (apply) {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    try {
      initializeAccess(db, 'oauth');
      for (const row of assignments) {
        const account = db.prepare('SELECT id FROM accounts WHERE email=? AND email_verified=1').get(row.email);
        const result = db.prepare("UPDATE documents SET scope='private',owner_id=?,owner_email=? WHERE id=? AND owner_id IS NULL").run(account?.id || null, row.email, row.id);
        if (result.changes !== 1) throw new Error(`Ownership changed: ${row.id}`);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  for (const row of assignments) console.log(`${apply ? 'Assigned' : 'Would assign'} ${row.id} → ${row.email}`);
}
try { migrate(); } finally { db.close(); }
