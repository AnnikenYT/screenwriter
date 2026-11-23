import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { createWorkspace } from '../server/index.js';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { writeScreenplay } from '../server/pdf.js';
import { existsSync } from 'node:fs';

await mkdir('/tmp/screenwriter', { recursive: true });

const waitFor = async predicate => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for collaboration');
};
async function start(dataDir, extra = {}) {
  const instance = createWorkspace({ DATA_DIR: dataDir, AUTH_MODE: 'none', PUBLIC_URL: 'http://localhost:3000', ...extra });
  await new Promise(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  return { ...instance, base: `http://127.0.0.1:${instance.server.address().port}` };
}
function connect(base, id, cookie) {
  const doc = new Y.Doc();
  const Socket = cookie ? class extends WebSocket {
    constructor(url, protocols) { super(url, protocols, { headers: { cookie } }); }
  } : WebSocket;
  const provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/collaboration', id, doc, { WebSocketPolyfill: Socket, disableBc: true });
  return { doc, provider, close() { provider.destroy(); doc.destroy(); } };
}
function anchorFor(doc, from, to) {
  const text = doc.getText('screenplay');
  return {
    start: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  };
}
function resolve(doc, anchor) {
  return ['start', 'end'].map(key => Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor[key]), doc)?.index);
}

test('guest display names persist without changing the session, identity, expiry or other users', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-names-');
  let server = await start(dir);
  let database;
  try {
    const first = await fetch(`${server.base}/api/session`);
    const identity = await first.json();
    assert.equal(identity.user.nameSet, false);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const other = await fetch(`${server.base}/api/session`);
    const otherIdentity = await other.json();
    const otherCookie = other.headers.get('set-cookie').split(';')[0];
    database = new DatabaseSync(path.join(dir, 'workspace.sqlite'));
    // Older guests did not store whether a name was chosen explicitly.
    const { nameSet, ...legacyOther } = otherIdentity.user;
    database.prepare('UPDATE sessions SET user=? WHERE id=?').run(JSON.stringify(legacyOther), createHash('sha256').update(otherCookie.split('=')[1]).digest('hex'));
    const sessionId = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const before = database.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    const patch = (name, extra = {}) => fetch(`${server.base}/api/session`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ name }),
    });
    const changed = await patch('  Ada Writer  ');
    assert.equal(changed.status, 200);
    assert.equal(changed.headers.get('set-cookie'), null, 'the session cookie is not rotated');
    assert.equal(changed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await changed.json(), { authMode: 'none', user: { ...identity.user, name: 'Ada Writer', nameSet: true } });
    const after = database.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    assert.equal(after.id, before.id);
    assert.equal(after.expires, before.expires);
    assert.deepEqual(JSON.parse(after.user), { ...identity.user, name: 'Ada Writer', nameSet: true });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2);
    for (const invalid of [undefined, null, 42, {}, '', '   ', 'x'.repeat(61), 'Ada\nWriter', 'Ada\r\nInjected: yes', '\tAda', 'Ada\0', 'Ada\u007f', 'Ada\u0085', 'Ada\u2028Writer', 'Ada\u2029Writer', 'Ada\u202eWriter']) {
      const response = await patch(invalid);
      assert.equal(response.status, 400, `invalid name ${JSON.stringify(invalid)}`);
      assert.match((await response.json()).error, /Name must/);
    }
    assert.equal((await patch('Cross-origin', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await patch('x'.repeat(60))).status, 200);
    assert.equal((await (await patch('Writer abcd')).json()).user.nameSet, true);
    assert.equal((await patch('Ada Writer')).status, 200);
    assert.deepEqual(await (await fetch(`${server.base}/api/session`, { headers: { cookie: otherCookie } })).json(), otherIdentity);
    database.close(); database = null;
    await server.close();
    server = await start(dir);
    assert.deepEqual(await (await fetch(`${server.base}/api/session`, { headers: { cookie } })).json(),
      { authMode: 'none', user: { ...identity.user, name: 'Ada Writer', nameSet: true } });
  } finally {
    database?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('PDF keeps character cues and nested production emphasis bold', () => {
  const calls = [];
  let font = 'Courier';
  const pdf = {
    font(value) { font = value; return this; },
    fontSize() { return this; },
    widthOfString(value) { return value.length * 7.2; },
    text(text) { calls.push({ text, font }); return this; },
    addPage() { return this; },
    bufferedPageRange() { return { start: 0, count: 2 }; },
  };
  writeScreenplay(pdf, "INT. ROOM - DAY\n\nMARA (V.O.) (CONT'D)\nHello.\n\n**VFX: Bright effect.**\n\nMARA visits ROOM. Mara sees ALARM.", 'A screenplay');
  assert.ok(calls.some(call => call.text === "MARA (V.O.) (CONT'D)" && call.font === 'Courier-Bold'));
  assert.ok(calls.some(call => call.text === 'VFX: Bright effect.' && call.font === 'Courier-Bold'));
  assert.ok(calls.some(call => call.text === 'MARA' && call.font === 'Courier-Bold'));
  assert.ok(calls.some(call => call.text === 'ROOM' && call.font === 'Courier-Bold'));
  assert.ok(calls.some(call => call.text.includes('Mara sees ALARM.') && call.font === 'Courier'));
});

test('server reconciles current screenplay sheets and journals cleanup across restart', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-sheets-');
  let server = await start(dir);
  const peers = [];
  const source = 'INT. ROOM - DAY\n\nALICE\nHello.\n\nBOB\nGoodbye.\n\nEXT. GARDEN - NIGHT\n\nQuiet.';
  try {
    const { id } = await (await fetch(`${server.base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: source }),
    })).json();
    const a = connect(server.base, id), b = connect(server.base, id);
    peers.push(a, b);
    await waitFor(() => a.provider.synced && b.provider.synced);
    const characters = a.doc.getMap('characters'), locations = a.doc.getMap('locations'), meta = a.doc.getMap('meta');
    assert.equal(characters.size, 2, 'creation discovers speaking characters');
    assert.equal(locations.size, 2, 'creation discovers scene locations');
    const alice = [...characters.values()].find(sheet => sheet.name === 'ALICE');
    const bob = [...characters.values()].find(sheet => sheet.name === 'BOB');
    const room = [...locations.values()].find(sheet => sheet.name === 'ROOM');
    const garden = [...locations.values()].find(sheet => sheet.name === 'GARDEN');
    const aliceNotes = `sheet:characters:${alice.id}:notes`;
    const bobNotes = `sheet:characters:${bob.id}:notes`;
    const roomNotes = `sheet:locations:${room.id}:notes`;
    const gardenNotes = `sheet:locations:${garden.id}:notes`;
    a.doc.transact(() => {
      meta.set(aliceNotes, 'Keep Alice');
      meta.set(bobNotes, 'Remove Bob');
      meta.set(roomNotes, 'Keep room');
      meta.set(gardenNotes, 'Remove garden');
      const text = a.doc.getText('screenplay');
      text.delete(0, text.length);
      text.insert(0, 'INT. ROOM - DAY\n\nALICE\nHello.\n\n!Someone leaves the garden.');
    });
    await waitFor(() => !b.doc.getMap('characters').has(bob.id) && !b.doc.getMap('locations').has(garden.id));
    assert.equal(b.doc.getMap('meta').has(bobNotes), false);
    assert.equal(b.doc.getMap('meta').has(gardenNotes), false);
    assert.equal(b.doc.getMap('meta').get(aliceNotes), 'Keep Alice');
    assert.equal(b.doc.getMap('meta').get(roomNotes), 'Keep room');
    assert.equal(b.doc.getMap('characters').get(alice.id).name, 'ALICE');
    a.doc.transact(() => {
      const text = a.doc.getText('screenplay');
      const from = text.toString().indexOf('ALICE');
      text.delete(from, 'ALICE'.length);
      text.insert(from, 'ADA');
      characters.set(alice.id, { ...characters.get(alice.id), name: 'ADA' });
    }, 'rename');
    await waitFor(() => b.doc.getMap('characters').get(alice.id)?.name === 'ADA');
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(b.doc.getMap('characters').size, 1);
    assert.equal(b.doc.getMap('characters').get(alice.id).name, 'ADA', 'atomic rename keeps its stable ID');
    assert.equal(b.doc.getMap('meta').get(aliceNotes), 'Keep Alice');
    // Simulate an orphan left by an older client. Map-only changes do not
    // reschedule source parsing, but loading the room must repair old data.
    a.doc.transact(() => {
      characters.set('old-orphan', { id: 'old-orphan', name: 'ABSENT' });
      meta.set('sheet:characters:old-orphan:notes', 'Legacy notes');
    });
    await waitFor(() => b.doc.getMap('characters').has('old-orphan'));
    peers.forEach(peer => peer.close()); peers.length = 0;
    await server.close();
    server = await start(dir);
    const restored = connect(server.base, id);
    peers.push(restored);
    await waitFor(() => restored.provider.synced);
    assert.equal(restored.doc.getMap('characters').has(bob.id), false);
    assert.equal(restored.doc.getMap('locations').has(garden.id), false);
    assert.equal(restored.doc.getMap('meta').has(bobNotes), false);
    assert.equal(restored.doc.getMap('meta').has(gardenNotes), false);
    assert.equal(restored.doc.getMap('characters').get(alice.id).name, 'ADA');
    assert.equal(restored.doc.getMap('meta').get(aliceNotes), 'Keep Alice');
    await waitFor(() => !restored.doc.getMap('characters').has('old-orphan'));
    assert.equal(restored.doc.getMap('meta').has('sheet:characters:old-orphan:notes'), false);
  } finally {
    peers.forEach(peer => peer.close());
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('HTTP API, Yjs collaboration, restore, image uploads, PDF and durable restart', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-test-');
  const dataDir = path.join(dir, '.private', 'data');
  let server = await start(dataDir);
  const peers = [];
  try {
    const first = await fetch(`${server.base}/api/session`);
    const identity = await first.json();
    assert.equal(identity.authMode, 'none');
    assert.ok(identity.user.id);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(`${server.base}/api/session`, { headers: { cookie } })).json()).user.id, identity.user.id);
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
    const appPage = await fetch(`${server.base}/`);
    const policy = appPage.headers.get('content-security-policy');
    if (existsSync(path.resolve(import.meta.dirname, '../dist/index.html'))) {
      assert.equal(appPage.status, 200, 'SPA entry is served even when workspace has dotfile ancestors');
      assert.match(appPage.headers.get('content-type'), /text\/html/);
      assert.match(await appPage.text(), /<html\b/);
    }
    assert.ok(policy.includes("script-src 'self'"));
    assert.ok(policy.includes("style-src 'self' 'unsafe-inline'"));
    assert.ok(policy.includes("img-src 'self' data: https:"));
    assert.ok(!policy.includes("script-src 'self' https:"), 'external images do not enable external scripts');
    assert.ok(policy.includes("frame-ancestors 'none'"));
    const create = await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Test film', text: 'INT. ROOM - DAY\n\nA story begins.\n\nHERO\nHello.' }) });
    assert.equal(create.status, 201);
    const { id } = await create.json();
    assert.equal((await (await fetch(`${server.base}/api/documents`)).json())[0].id, id);
    const a = connect(server.base, id), b = connect(server.base, id);
    peers.push(a, b);
    await waitFor(() => a.provider.synced && b.provider.synced);
    assert.match(a.doc.getText('screenplay').toString(), /A story begins/);
    const from = a.doc.getText('screenplay').toString().indexOf('story');
    a.doc.transact(() => {
      a.doc.getText('scratchpad').insert(0, 'An idea');
      a.doc.getMap('characters').set('characters-HERO', { id: 'characters-HERO', name: 'Hero', description: 'Brave' });
      a.doc.getMap('comments').set('c1', { text: 'Keep this', resolved: false, anchor: anchorFor(a.doc, from, from + 5) });
      a.doc.getMap('suggestions').set('s1', { replacement: 'film', status: 'pending', anchor: anchorFor(a.doc, from, from + 5) });
      a.doc.getMap('meta').set('image-link:reference', {
        id: 'reference', url: 'https://images.example.com/story.jpg', caption: 'Story reference',
        quote: 'story', anchor: anchorFor(a.doc, from, from + 5),
        author: identity.user.name, authorId: identity.user.id, createdAt: 123,
      });
      a.doc.getMap('meta').set('image-link:detached', { id: 'detached', url: '/uploads/missing.png', anchor: {} });
    });
    await waitFor(() => b.doc.getText('scratchpad').toString() === 'An idea');
    a.provider.awareness.setLocalStateField('user', { name: 'Test' });
    await waitFor(() => b.provider.awareness.getStates().size >= 2);
    const saved = await (await fetch(`${server.base}/api/documents/${id}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'First draft' }) })).json();
    assert.equal(saved.label, 'First draft');
    a.doc.transact(() => {
      a.doc.getText('screenplay').insert(0, 'Changed!\n');
      a.doc.getText('scratchpad').delete(0, a.doc.getText('scratchpad').length);
      a.doc.getMap('characters').clear();
      a.doc.getMap('comments').clear();
      a.doc.getMap('meta').delete('image-link:reference');
      a.doc.getMap('meta').delete('image-link:detached');
    });
    await waitFor(() => b.doc.getText('screenplay').toString().startsWith('Changed!'));
    assert.equal((await fetch(`${server.base}/api/documents/${id}/versions/${saved.id}/restore`, { method: 'POST' })).status, 200);
    await waitFor(() => !a.doc.getText('screenplay').toString().startsWith('Changed!'));
    assert.equal(a.doc.getText('scratchpad').toString(), 'An idea');
    assert.equal(a.doc.getMap('characters').get('characters-HERO').name, 'Hero');
    assert.equal(a.doc.getMap('comments').get('c1').text, 'Keep this');
    assert.deepEqual(resolve(a.doc, a.doc.getMap('comments').get('c1').anchor), [from, from + 5]);
    assert.deepEqual(resolve(a.doc, a.doc.getMap('suggestions').get('s1').anchor), [from, from + 5]);
    const imageLink = a.doc.getMap('meta').get('image-link:reference');
    assert.deepEqual(resolve(a.doc, imageLink.anchor), [from, from + 5], 'restored image links anchor to the restored live text');
    assert.equal(a.doc.getText('screenplay').toString().slice(...resolve(a.doc, imageLink.anchor)), imageLink.quote);
    assert.deepEqual({ ...imageLink, anchor: null }, {
      id: 'reference', url: 'https://images.example.com/story.jpg', caption: 'Story reference', quote: 'story',
      anchor: null, author: identity.user.name, authorId: identity.user.id, createdAt: 123,
    });
    assert.equal(a.doc.getMap('meta').get('image-link:detached').anchor, null, 'invalid historical image anchors remain detached');
    assert.equal(a.doc.getText('screenplay').toString().slice(...resolve(a.doc, a.doc.getMap('comments').get('c1').anchor)), 'story');
    const versions = await (await fetch(`${server.base}/api/documents/${id}/versions`)).json();
    assert.ok(versions.some(v => v.label === 'Before restore'));
    const detail = await (await fetch(`${server.base}/api/documents/${id}/versions/${saved.id}`)).json();
    assert.equal(detail.scratchpad, 'An idea');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'test.png');
    const imageResponse = await fetch(`${server.base}/api/documents/${id}/images`, { method: 'POST', body: form });
    assert.equal(imageResponse.status, 201);
    const image = await imageResponse.json();
    const downloaded = await fetch(`${server.base}${image.url}`);
    assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    const badImage = new FormData();
    badImage.append('image', new Blob(['<svg onload="alert(1)"/>'], { type: 'image/png' }), 'evil.png');
    assert.equal((await fetch(`${server.base}/api/documents/${id}/images`, { method: 'POST', body: badImage })).status, 415);
    const pdf = await fetch(`${server.base}/api/documents/${id}/export.pdf`);
    assert.equal(pdf.status, 200);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pdfBytes.toString('latin1').match(/\/Type \/Page\b/g).length, 2, 'real PDF has a separate title page');
    assert.equal((await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    // A corrupt packet must close just its socket, not the server or room.
    const corrupt = new WebSocket(`${server.base.replace('http:', 'ws:')}/collaboration/${id}`);
    await new Promise(resolve => corrupt.once('open', resolve));
    const closed = new Promise(resolve => corrupt.once('close', resolve));
    corrupt.send(Buffer.from([0, 2, 255]));
    assert.equal(await closed, 1008);
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
    const foreign = new WebSocket(`${server.base.replace('http:', 'ws:')}/collaboration/${id}`, { origin: 'https://evil.example' });
    foreign.on('error', () => {});
    assert.equal(await new Promise(resolve => foreign.on('unexpected-response', (req, response) => { response.resume(); foreign.terminate(); resolve(response.statusCode); })), 403);
    const aClientID = a.doc.clientID;
    a.close();
    await waitFor(() => !b.provider.awareness.getStates().has(aClientID));
    b.close();
    peers.length = 0;
    await server.close();
    server = await start(dataDir);
    const persisted = connect(server.base, id);
    peers.push(persisted);
    await waitFor(() => persisted.provider.synced);
    assert.match(persisted.doc.getText('screenplay').toString(), /A story begins/);
    assert.equal(persisted.doc.getText('scratchpad').toString(), 'An idea');
    assert.equal(persisted.doc.getMap('characters').get('characters-HERO').name, 'Hero');
    assert.deepEqual(resolve(persisted.doc, persisted.doc.getMap('comments').get('c1').anchor), [from, from + 5]);
    assert.deepEqual(resolve(persisted.doc, persisted.doc.getMap('meta').get('image-link:reference').anchor), [from, from + 5]);
    assert.equal((await fetch(`${server.base}${image.url}`)).status, 200);
  } finally {
    peers.forEach(peer => peer.close());
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('OAuth denies protected HTTP routes, uploads and websocket upgrades', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-auth-');
  const server = await start(dir, { AUTH_MODE: 'oauth' });
  try {
    const session = await (await fetch(`${server.base}/api/session`)).json();
    assert.deepEqual(session, { authMode: 'oauth', user: null });
    assert.equal((await fetch(`${server.base}/api/session`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Changed' }) })).status, 403);
    for (const route of ['/api/documents', '/api/documents/anything/versions', '/api/documents/anything/export.pdf', '/uploads/test.png']) {
      assert.equal((await fetch(`${server.base}${route}`)).status, 401);
    }
    assert.equal((await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const ws = new WebSocket(`${server.base.replace('http:', 'ws:')}/collaboration/8f00262e-b11b-4029-b947-ce45c4f442da`);
    ws.on('error', () => {});
    const status = await new Promise(resolve => ws.on('unexpected-response', (req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); }));
    assert.equal(status, 401);
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
    assert.equal((await fetch(`${server.base}/auth/callback?code=bad&state=bad`)).status, 400);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('OIDC authorization code, PKCE, signed identity, domain restriction and logout', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-oidc-');
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test', use: 'sig', alg: 'RS256' };
  let nonce, challenge, issuer, idTokenOverrides = {};
  const identityProvider = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, token_endpoint_auth_methods_supported: ['client_secret_post'] }));
    } else if (req.url === '/jwks') res.end(JSON.stringify({ keys: [jwk] }));
    else if (req.url === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get('client_id'), 'test-client');
      assert.equal(params.get('client_secret'), 'test-secret');
      assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge);
      const now = Math.floor(Date.now() / 1000);
      const id_token = await new SignJWT({ nonce, name: 'Alice', email: 'alice@example.com', email_verified: true,
        iss: issuer, aud: 'test-client', sub: 'alice', iat: now, exp: now + 300, ...idTokenOverrides })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(keys.privateKey);
      res.end(JSON.stringify({ id_token }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise(resolve => identityProvider.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${identityProvider.address().port}`;
  const server = await start(dir, { AUTH_MODE: 'oauth', OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'test-client', OIDC_CLIENT_SECRET: 'test-secret', OIDC_ALLOWED_EMAIL_DOMAINS: 'example.com', HEARTBEAT_INTERVAL_MS: 100 });
  const peers = [];
  try {
    const login = await fetch(`${server.base}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const authURL = new URL(login.headers.get('location'));
    nonce = authURL.searchParams.get('nonce');
    challenge = authURL.searchParams.get('code_challenge');
    assert.equal(authURL.searchParams.get('code_challenge_method'), 'S256');
    const loginCookie = login.headers.get('set-cookie').split(';')[0];
    const callbackURL = `${server.base}/auth/callback?state=${authURL.searchParams.get('state')}&code=test-code`;
    const callback = await fetch(callbackURL, { headers: { cookie: loginCookie }, redirect: 'manual' });
    assert.equal(callback.status, 302);
    const cookie = callback.headers.getSetCookie().find(x => x.startsWith('screenplay_session=')).split(';')[0];
    const user = await (await fetch(`${server.base}/api/session`, { headers: { cookie } })).json();
    assert.equal(user.user.name, 'Alice');
    assert.equal((await fetch(`${server.base}/api/session`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Changed' }) })).status, 403);
    assert.equal((await fetch(`${server.base}/api/documents`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(callbackURL, { headers: { cookie: loginCookie }, redirect: 'manual' })).status, 400);
    const { id } = await (await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).json();
    const live = connect(server.base, id, cookie);
    const otherTab = connect(server.base, id, cookie);
    peers.push(live, otherTab);
    await waitFor(() => live.provider.synced && otherTab.provider.synced);
    const loggedOut = new Promise(resolve => live.provider.ws.once('close', code => resolve(code)));
    const otherLoggedOut = new Promise(resolve => otherTab.provider.ws.once('close', code => resolve(code)));
    await fetch(`${server.base}/auth/logout`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(await loggedOut, 1008);
    assert.equal(await otherLoggedOut, 1008);
    live.close(); otherTab.close();
    assert.equal((await fetch(`${server.base}/api/documents`, { headers: { cookie } })).status, 401);
    // A second login whose session expires while its socket is completely idle.
    const again = await fetch(`${server.base}/auth/login`, { redirect: 'manual' });
    const againURL = new URL(again.headers.get('location'));
    nonce = againURL.searchParams.get('nonce'); challenge = againURL.searchParams.get('code_challenge');
    const againCallback = await fetch(`${server.base}/auth/callback?state=${againURL.searchParams.get('state')}&code=test-code`, { headers: { cookie: again.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
    const againCookie = againCallback.headers.getSetCookie().find(x => x.startsWith('screenplay_session=')).split(';')[0];
    const idle = connect(server.base, id, againCookie);
    peers.push(idle);
    await waitFor(() => idle.provider.synced);
    const expired = new Promise(resolve => idle.provider.ws.once('close', code => resolve(code)));
    const database = new DatabaseSync(path.join(dir, 'workspace.sqlite'));
    database.prepare('UPDATE sessions SET expires=0').run();
    database.close();
    assert.equal(await expired, 1008);
    idle.close();
    async function loginWith(claims) {
      idTokenOverrides = claims;
      const response = await fetch(`${server.base}/auth/login`, { redirect: 'manual' });
      const url = new URL(response.headers.get('location'));
      nonce = url.searchParams.get('nonce'); challenge = url.searchParams.get('code_challenge');
      return fetch(`${server.base}/auth/callback?state=${url.searchParams.get('state')}&code=test-code`, { headers: { cookie: response.headers.get('set-cookie').split(';')[0] }, redirect: 'manual' });
    }
    for (const claim of ['exp', 'iat', 'sub', 'aud', 'iss']) {
      const invalid = await loginWith({ [claim]: undefined });
      assert.equal(invalid.status, 401, `missing ${claim} must be rejected`);
      assert.ok(!invalid.headers.getSetCookie().some(value => value.startsWith('screenplay_session=')));
    }
    for (const claims of [{ azp: 'another-client' }, { azp: null }, { aud: ['test-client', 'another-client'] }, { aud: ['test-client', 'another-client'], azp: 'another-client' }]) {
      assert.equal((await loginWith(claims)).status, 401, 'invalid or missing authorized party must be rejected');
    }
    assert.equal((await loginWith({ aud: ['test-client', 'another-client'], azp: 'test-client' })).status, 302, 'multiple audiences with correct authorized party are allowed');
  } finally {
    peers.forEach(peer => peer.close());
    await server.close();
    await new Promise(resolve => identityProvider.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('large-script edits append small durable deltas, replay on restart, and compact on snapshot', async t => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-performance-');
  let server = await start(dir, { COMPACT_AFTER_UPDATES: 10000 });
  let database;
  const peers = [];
  try {
    const original = 'INT. ROOM - DAY\n\n' + 'A'.repeat(1024 * 1024);
    const { id } = await (await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: original }) })).json();
    const a = connect(server.base, id), b = connect(server.base, id);
    peers.push(a, b);
    await waitFor(() => a.provider.synced && b.provider.synced);
    database = new DatabaseSync(path.join(dir, 'workspace.sqlite'));
    const before = database.prepare('SELECT state FROM documents WHERE id=?').get(id).state;
    const journalSize = () => database.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(state)),0) AS bytes FROM document_updates WHERE document_id=?').get(id);
    const baseline = journalSize();
    const edits = 300;
    const started = performance.now();
    for (let i = 0; i < edits; i++) a.doc.getText('screenplay').insert(a.doc.getText('screenplay').length, 'x');
    await waitFor(() => b.doc.getText('screenplay').length === original.length + edits);
    const elapsed = performance.now() - started;
    t.diagnostic(`${edits} separate edits to a 1 MiB script: ${elapsed.toFixed(0)} ms (${(edits * 1000 / elapsed).toFixed(0)} updates/s, including durable commits and delivery)`);
    assert.ok(elapsed < 10000, '300 durable edits should not require full-script cloning or encoding');
    assert.deepEqual(database.prepare('SELECT state FROM documents WHERE id=?').get(id).state, before, 'base snapshot is not rewritten on each keystroke');
    const after = journalSize();
    assert.ok(after.count - baseline.count >= edits);
    assert.ok(after.bytes - baseline.bytes < 100000, 'journal stores deltas rather than 300 copies of a 1 MiB script');
    peers.forEach(peer => peer.close()); peers.length = 0;
    database.close(); database = null;
    await server.close();
    server = await start(dir);
    const restored = connect(server.base, id);
    peers.push(restored);
    await waitFor(() => restored.provider.synced);
    assert.equal(restored.doc.getText('screenplay').toString(), original + 'x'.repeat(edits));
    await fetch(`${server.base}/api/documents/${id}/versions`, { method: 'POST' });
    database = new DatabaseSync(path.join(dir, 'workspace.sqlite'));
    assert.equal(journalSize().count, 0, 'snapshot atomically compacts the journal');
    assert.ok(database.prepare('SELECT length(state) AS size FROM documents WHERE id=?').get(id).size > before.length);
  } finally {
    peers.forEach(peer => peer.close());
    database?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('semantic source-limit violations reset to durable state without broadcasting bad source', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-limits-');
  const server = await start(dir, { MAX_DOCUMENT_BYTES: 128, MAX_HISTORY_BYTES: 8192 });
  const peers = [];
  try {
    const { id } = await (await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Safe source' }) })).json();
    const bad = connect(server.base, id);
    peers.push(bad);
    await waitFor(() => bad.provider.synced);
    const closed = new Promise(resolve => bad.provider.ws.once('close', code => resolve(code)));
    bad.doc.getText('screenplay').insert(0, 'x'.repeat(150));
    assert.equal(await closed, 1008);
    bad.close();
    const fresh = connect(server.base, id);
    peers.push(fresh);
    await waitFor(() => fresh.provider.synced);
    assert.equal(fresh.doc.getText('screenplay').toString(), 'Safe source');
    assert.equal((await fetch(`${server.base}/api/health`)).status, 200);
  } finally {
    peers.forEach(peer => peer.close());
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent suggestion decisions apply replacement once and reject stale sources', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-decisions-');
  const server = await start(dir);
  const peers = [];
  try {
    const { id } = await (await fetch(`${server.base}/api/documents`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'The cat waits.' }) })).json();
    const a = connect(server.base, id), b = connect(server.base, id);
    peers.push(a, b);
    await waitFor(() => a.provider.synced && b.provider.synced);
    const decide = (suggestionId, decision) => fetch(`${server.base}/api/documents/${id}/suggestions/${suggestionId}/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }) });
    a.doc.getMap('suggestions').set('replace', { status: 'pending', original: 'cat', replacement: 'dog', anchor: anchorFor(a.doc, 4, 7) });
    await waitFor(() => b.doc.getMap('suggestions').has('replace'));
    const results = await Promise.all([decide('replace', 'accepted'), decide('replace', 'accepted')]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
    await waitFor(() => b.doc.getText('screenplay').toString() === 'The dog waits.');
    assert.equal(a.doc.getText('screenplay').toString(), 'The dog waits.');
    assert.equal(b.doc.getMap('suggestions').get('replace').status, 'accepted');
    assert.ok(b.doc.getMap('suggestions').get('replace').decidedBy);
    a.doc.transact(() => {
      a.doc.getMap('suggestions').set('stale', { status: 'pending', original: 'cat', replacement: 'horse', anchor: anchorFor(a.doc, 4, 7) });
      a.doc.getMap('suggestions').set('reject', { status: 'pending', original: 'dog', replacement: 'horse', anchor: anchorFor(a.doc, 4, 7) });
      a.doc.getMap('suggestions').set('broken', { status: 'pending', original: '', replacement: 'Oops', anchor: {} });
    });
    await waitFor(() => b.doc.getMap('suggestions').has('broken'));
    assert.equal((await decide('stale', 'accepted')).status, 409);
    assert.equal((await decide('stale', 'rejected')).status, 200, 'stale proposals can always be dismissed');
    assert.equal((await decide('broken', 'accepted')).status, 409);
    assert.equal((await decide('broken', 'rejected')).status, 200, 'detached proposals can always be dismissed');
    assert.equal((await decide('reject', 'rejected')).status, 200);
    await waitFor(() => b.doc.getMap('suggestions').get('reject').status === 'rejected');
    assert.equal(b.doc.getText('screenplay').toString(), 'The dog waits.');
    assert.equal((await decide('reject', 'accepted')).status, 409);
    const end = a.doc.getText('screenplay').length;
    a.doc.getMap('suggestions').set('insert', { status: 'pending', original: '', replacement: '!', anchor: anchorFor(a.doc, end, end) });
    await waitFor(() => b.doc.getMap('suggestions').has('insert'));
    assert.equal((await decide('insert', 'accepted')).status, 200);
    await waitFor(() => b.doc.getText('screenplay').toString() === 'The dog waits.!');
    assert.equal((await decide('insert', 'accepted')).status, 409);
    assert.equal((await decide('missing', 'accepted')).status, 404);
    assert.equal((await decide('missing', 'invalid')).status, 400);
  } finally {
    peers.forEach(peer => peer.close());
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('suggestion decisions preserve proposal and existing annotation ranges without touching other suggestions', async () => {
  const dir = await mkdtemp('/tmp/screenwriter/screenplay-annotation-decisions-');
  const server = await start(dir);
  const peers = [];
  try {
    const { id } = await (await fetch(`${server.base}/api/documents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'The cat waits.' }),
    })).json();
    const a = connect(server.base, id), b = connect(server.base, id);
    peers.push(a, b);
    await waitFor(() => a.provider.synced && b.provider.synced);
    const text = a.doc.getText('screenplay'), comments = a.doc.getMap('comments'), meta = a.doc.getMap('meta'), suggestions = a.doc.getMap('suggestions');
    const decide = (suggestionId, decision = 'accepted') => fetch(`${server.base}/api/documents/${id}/suggestions/${suggestionId}/decide`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
    });
    const full = anchorFor(a.doc, 4, 7), outside = anchorFor(a.doc, 8, 13);
    const otherSuggestion = { status: 'pending', original: 'cat', replacement: 'rat', anchor: full };
    a.doc.transact(() => {
      suggestions.set('replace', { status: 'pending', original: 'cat', replacement: 'tiger', anchor: full });
      suggestions.set('other', otherSuggestion);
      comments.set('ordinary', { text: 'Whole word', anchor: full });
      comments.set('partial', { text: 'Partial word', anchor: anchorFor(a.doc, 5, 6) });
      comments.set('spanning', { text: 'Spanning range', anchor: anchorFor(a.doc, 2, 9) });
      comments.set('outside', { text: 'Outside word', anchor: outside });
      comments.set('proposal', { text: 'Replacement letters', anchor: full, proposal: { id: 'replace', from: 1, to: 4 } });
      meta.set('image-link:ordinary', { url: 'https://images.example.com/cat.jpg', anchor: full });
      meta.set('image-link:proposal', { url: 'https://images.example.com/tiger.jpg', anchor: full, proposal: { id: 'replace', from: 1, to: 4 } });
      meta.set('image-link:clamped', { url: 'https://images.example.com/full.jpg', anchor: full, proposal: { id: 'replace', from: -50, to: 500 } });
    });
    await waitFor(() => b.doc.getMap('meta').has('image-link:clamped'));
    const decisions = await Promise.all([decide('replace'), decide('replace')]);
    assert.deepEqual(decisions.map(response => response.status).sort(), [200, 409]);
    await waitFor(() => b.doc.getMap('suggestions').get('replace')?.status === 'accepted');
    assert.equal(text.toString(), 'The tiger waits.');
    assert.deepEqual(resolve(a.doc, comments.get('ordinary').anchor), [4, 9]);
    assert.deepEqual(resolve(a.doc, meta.get('image-link:ordinary').anchor), [4, 9]);
    assert.deepEqual(resolve(a.doc, comments.get('partial').anchor), [5, 6]);
    assert.deepEqual(resolve(a.doc, comments.get('spanning').anchor), [2, 11]);
    assert.deepEqual(resolve(a.doc, comments.get('outside').anchor), [10, 15]);
    assert.deepEqual(comments.get('outside').anchor, outside, 'nonoverlapping relative anchors are not rewritten');
    assert.deepEqual(resolve(a.doc, comments.get('proposal').anchor), [5, 8]);
    assert.deepEqual(resolve(a.doc, meta.get('image-link:proposal').anchor), [5, 8]);
    assert.deepEqual(resolve(a.doc, meta.get('image-link:clamped').anchor), [4, 9]);
    assert.equal(Object.hasOwn(comments.get('proposal'), 'proposal'), false);
    assert.equal(Object.hasOwn(meta.get('image-link:proposal'), 'proposal'), false);
    assert.deepEqual(suggestions.get('other'), otherSuggestion, 'other suggestion anchors and stale-source safeguards are unchanged');
    assert.equal((await decide('other')).status, 409);

    const end = text.length, insertionAnchor = anchorFor(a.doc, end, end);
    a.doc.transact(() => {
      suggestions.set('insert', { status: 'pending', original: '', replacement: ' A😀B.', anchor: insertionAnchor });
      comments.set('insert', { text: 'New text', anchor: insertionAnchor, proposal: { id: 'insert', from: 1, to: 4 } });
      meta.set('image-link:insert', { url: 'https://images.example.com/new.jpg', anchor: insertionAnchor, proposal: { id: 'insert', from: 1, to: 4 } });
    });
    await waitFor(() => b.doc.getMap('meta').has('image-link:insert'));
    assert.equal((await decide('insert')).status, 200);
    await waitFor(() => b.doc.getMap('suggestions').get('insert')?.status === 'accepted');
    for (const value of [comments.get('insert'), meta.get('image-link:insert')]) {
      assert.deepEqual(resolve(a.doc, value.anchor), [end + 1, end + 4]);
      assert.equal(text.toString().slice(...resolve(a.doc, value.anchor)), 'A😀', 'proposal offsets count UTF-16 code units');
      assert.equal(Object.hasOwn(value, 'proposal'), false);
    }

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), 'reference.png');
    const upload = await (await fetch(`${server.base}/api/documents/${id}/images`, { method: 'POST', body: form })).json();
    const historicalAnchor = anchorFor(a.doc, 10, 15);
    a.doc.transact(() => {
      suggestions.set('reject', { status: 'pending', original: 'waits', replacement: 'runs', anchor: historicalAnchor });
      comments.set('reject', { text: 'Historical discussion', anchor: historicalAnchor, proposal: { id: 'reject', from: 0, to: 4 } });
      meta.set('image-link:reject', { url: upload.url, anchor: historicalAnchor, proposal: { id: 'reject', from: 0, to: 4 } });
    });
    await waitFor(() => b.doc.getMap('meta').has('image-link:reject'));
    const beforeRejection = text.toString();
    assert.equal((await decide('reject', 'rejected')).status, 200);
    await waitFor(() => b.doc.getMap('suggestions').get('reject')?.status === 'rejected');
    assert.equal(text.toString(), beforeRejection);
    assert.deepEqual(comments.get('reject'), { text: 'Historical discussion', anchor: JSON.parse(JSON.stringify(historicalAnchor)) });
    assert.deepEqual(resolve(a.doc, comments.get('reject').anchor), [10, 15]);
    assert.equal(meta.has('image-link:reject'), false);
    assert.equal(meta.has('image-link:ordinary'), true);
    assert.deepEqual(Buffer.from(await (await fetch(`${server.base}${upload.url}`)).arrayBuffer()), png, 'rejection does not delete an uploaded image file');
  } finally {
    peers.forEach(peer => peer.close());
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('PDF layout formats a separate title page, dual dialogue, blanks, emphasis and synchronized pagination', () => {
  const calls = [];
  let page = 0, count = 1, font = 'Courier';
  const pdf = {
    font(value) { font = value; return this; },
    fontSize() { return this; },
    widthOfString(value) { return [...value].length * 7.2; },
    text(text, x, y, options) { calls.push({ text, x, y, page, font, ...options }); return this; },
    addPage() { page = count++; return this; },
    bufferedPageRange() { return { start: 0, count }; },
    switchToPage(index) { page = index; return this; },
  };
  const text = `Title: **THE FILM**
Credit: Written by
Author: Ada Writer
Contact: ada@example.com

INT. ROOM - DAY

ALICE
Left dialogue.

BOB ^
Right dialogue.


!An *important* and _underlined_ action with _**one**_ and **_two_**.

===

!Next page.

ALICE
${'A long left dialogue. '.repeat(300)}

BOB ^
${'A long right dialogue. '.repeat(300)}
`;
  writeScreenplay(pdf, text, 'Fallback');
  const title = calls.find(call => call.text === 'THE FILM');
  assert.equal(title.page, 0);
  assert.equal(title.font, 'Courier-Bold');
  assert.ok(calls.some(call => call.text === 'Ada Writer' && call.page === 0));
  const scene = calls.find(call => call.text === 'INT. ');
  assert.equal(scene.page, 1);
  assert.equal(scene.y, 54);
  assert.equal(calls.filter(call => call.page === 1 && call.y === 54).map(call => call.text).join(''), 'INT. ROOM - DAY');
  const left = calls.find(call => call.text === 'Left dialogue.');
  const right = calls.find(call => call.text === 'Right dialogue.');
  assert.equal(left.page, right.page);
  assert.equal(left.y, right.y);
  assert.equal(left.x, 108);
  assert.equal(right.x, 342);
  const action = calls.find(call => call.text === 'An ');
  assert.equal(action.y, left.y + 36, 'two intentional blank lines are preserved');
  assert.ok(calls.some(call => call.text === 'important' && call.font === 'Courier-Oblique'));
  assert.ok(calls.some(call => call.text === 'underlined' && call.underline));
  for (const text of ['one', 'two']) {
    assert.ok(calls.some(call => call.text === text && call.font === 'Courier-Bold' && call.underline));
  }
  assert.equal(calls.find(call => call.text === 'Next page.').page, 2);
  assert.ok(count > 3);
  for (const call of calls.filter(call => call.y >= 54)) assert.ok(call.y + 12 <= 738, 'body stays inside page margins');
  assert.ok(calls.some(call => call.text === '2.' && call.page === 2 && call.y === 30));
  assert.ok(!calls.some(call => call.text === '1.' && call.y === 30));
  assert.ok(calls.some(call => call.page === 3 && call.x === 108 && call.y === 54));
  assert.ok(calls.some(call => call.page === 3 && call.x === 342 && call.y === 54), 'dual columns continue together on the next page');
});
