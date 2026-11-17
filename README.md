# Screenwriter

- Self-hosted, unbranded [Fountain](https://fountain.io/syntax/) screenplay editor.
- Vue 3 · CodeMirror 6 · Yjs · Node 24 · SQLite.
- One container; no external database or collaboration service.

## Features

- Live formatting: edit a line's source; render it when leaving. Multiline blocks stay editable until the cursor is two lines below.
- Split view: highlighted source, live preview, and two-way synchronized scrolling.
- Live collaboration, line-side comment bubbles, replies, and inline edit suggestions with hover-to-review.
- Automatic character/location sheets, unused-sheet cleanup, Markdown fields, and image moodboards.
- Rename characters/locations across screenplay text, scratchpad, and sheet notes.
- Shared Markdown scratchpad with preview.
- Tab completion for character/location names; linked passage images on hover.
- Formatting shortcuts, selection wrapping, and persistent light/dark themes.
- Full-width phone editing, Write/Preview tabs, keyboard-aware sizing, and touch screenplay shortcuts.
- Installable PWA with opt-in updates; only public assets are cached, never documents or identity.
- Named versions, automatic snapshots, and restore with a backup.
- Fountain import/export and screenplay PDF export, including dual dialogue.

## Run

```sh
docker compose up -d
```

- Open **http://localhost:3000**.
- Image: `ghcr.io/annikenyt/screenwriter:latest`.
- Private packages require `docker login ghcr.io` before pulling.
- Install via your browser’s app menu; on iOS, Safari → Share → Add to Home Screen. Requires HTTPS.
- Copy `.env.example` to `.env` for configuration; all settings are environment variables.
- Data is persisted in the `screenplay-data` volume.
- Build locally instead: `docker compose up --build -d`.

## Authentication

- **`AUTH_MODE=none`** (default): everyone who can reach the server can access **all documents**.
  - Click your avatar to choose a writer name.
- **`AUTH_MODE=oauth`**: sign in through an OpenID Connect provider.
  - Set `PUBLIC_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.
  - Register callback: `${PUBLIC_URL}/auth/callback`.
  - Optional restriction: `OIDC_ALLOWED_EMAIL_DOMAINS=example.com`.
- All users share one workspace; no per-document permissions or enforced reviewer roles.

## Deployment notes

- Use one replica, at the origin root, behind HTTPS for remote access.
- Set `PUBLIC_URL` to the exact browser-facing origin; forward WebSockets for `/collaboration/`.
- Bind is localhost-only by default; set `BIND_ADDRESS` to expose another interface.
- Back up the entire data volume consistently, preferably with the container stopped.
- Versions/uploads are retained indefinitely; monitor disk usage.
- No persistent offline document storage: keep disconnected tabs open, or use **Download draft** to save proposed writing as Fountain (not comments/images).
- Same sheet field edited simultaneously: last writer wins.
- PDF: Courier is not full-Unicode; no automatic continuation cues; long title metadata is clipped.
- Health check: `/api/health`. Limits and other settings: [`.env.example`](.env.example).

## Development

```sh
npm ci
PUBLIC_URL=http://localhost:5173 npm run dev
```

- Requires Node **24+**; open **http://localhost:5173**.
- Tests: `npx playwright install chromium`, then `npm run verify`.
- Shortcuts: Ctrl/⌘ **B/I/U** bold/italic/underline · **Shift K** image · **F** search · **Z** undo · **Shift Z** redo · **Alt M** comment.
- Select text and type `*`, `_`, or `[` to surround it; press Tab to complete a name.

## License

- [MIT](LICENSE).
