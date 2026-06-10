# PDS Sync

Sync your Obsidian vault to an [atproto](https://atproto.com) Personal Data Server (PDS). Two backends, one engine:

- **Private (default)** - notes are encrypted client-side (Argon2id + AES-256-GCM) and stored as opaque records on your PDS. Only you can read them.
- **Public** - notes you mark `publish: true` become [`site.standard.document`](https://standard.site) records, displayed by standard.site readers such as Leaflet.

## Features

- **Auth** - OAuth (PKCE + DPoP, no backend) or app password; credentials kept in your OS keychain.
- **Private, two-way** - push, pull/restore, conflict copies, orphan deletion, and self-healing compare-and-swap writes.
- **Public publishing** - `site.standard.document` with a markdown content block, plus a `site.standard.publication` helper (theme, icon, discovery, `.well-known` verification).
- **Auto-sync** - on-change + interval, with a status-bar indicator. Works on mobile.

## Install

Download `main.js` + `manifest.json` from a release (Tangled tag artifacts) - or build from source (see [Develop](#develop)) - and drop them into `<vault>/.obsidian/plugins/pds-sync/`, then enable in **Settings -> Community plugins**.

## Quick start

1. **Connect** - *Settings -> PDS Sync*: pick OAuth (enter your handle -> **Connect**) or app password.
2. **Set an encryption passphrase** (for private notes).
3. **Flag a note** with a checkbox property and run **Sync vault to PDS**:

```yaml
---
pds: true # encrypt + sync privately (or  publish: true  to publish publicly)
---
```

Nothing syncs unless flagged. After a sync the plugin writes its index back into the note's frontmatter - its "git object id" for change detection.

## How it works

One note - one record. Each sync hashes the note (body + frontmatter) against the stored index, then creates / updates / skips. Push is compare-and-swap (`swapRecord`): if a record changed under you it writes a conflict copy instead of clobbering. Pull restores missing notes, applies remote changes, and reflects deletions.

## Security model (read this for private notes)

Private notes are encrypted client-side with **AES-256-GCM**, the key derived by **Argon2id** (memory-hard) from your passphrase and a salt derived from your DID - deterministic and non-secret, so every device derives the same key.

**Important**: encrypted records live in your **public, firehose-archived repo**, which atproto maintainers [discourage](https://github.com/bluesky-social/atproto/discussions/121) because archived ciphertext can be attacked offline indefinitely:

- **Your passphrase is the only secret** - use a long one. Argon2id makes each guess expensive, but a weak passphrase against archived ciphertext is still crackable.
- **Metadata leaks** - record existence, timing, rough size, and your DID are visible; content is not.
- **No recovery** - lose the passphrase and the private records are unrecoverable.
- The proper long-term fix is a non-broadcast private namespace (stubbed in `src/sync/targets/atsSpace.ts`).

## Configuration

- **Credentials** - on Obsidian 1.11.4+ the app password and passphrase are stored in your **OS keychain**; older versions fall back to a gitignored local `data.json` (don't keep that folder inside a vault you publish). App-password JWTs are never persisted (re-login each launch); OAuth tokens live in local storage.
- **Routing** - `pds: true` -> private, `publish: true` -> public; remove or set the flag to `false` to unpublish.
- **Auto-sync** - push-only; toggle on-change and/or an interval. The status-bar item shows state (synced / syncing / error / not connected).
- **Public** - the publication helper writes a `site.standard.publication` and auto-fills the Publication URI your documents reference.
- **OAuth host** - the `client_id` doc + redirect page (in `public/`) are served at `obsidian-pds-sync.2877686.xyz`. To self-host, serve `public/` at a host root and update the metadata + settings together.

## Network use

Talks **only** to atproto infrastructure - no analytics or telemetry: your PDS (records/blobs), your PDS's OAuth server (sign-in), and the static OAuth host above. Sign-in resolves your handle -> DID with no appview - Cloudflare DNS-over-HTTPS (`cloudflare-dns.com`) raced against a `.well-known` fetch on your handle's domain - then your DID document via `plc.directory` or `did:web`. Credentials and your passphrase never leave your keychain except to your own PDS / authorization server.

## Develop

```bash
bun install
bun run dev
bun run build
```

Symlink the repo into `<vault>/.obsidian/plugins/pds-sync/` and enable it in Community plugins.

## Releasing

Releases use annotated-tag artifacts (stored in your PDS): `bun run build`, create an annotated tag matching `manifest.json`'s version and push it, then upload `main.js` + `manifest.json` as artifacts. The Spindle CI (`.tangled/workflows/build.yml`) validates the build on every push and tag.

## License

MIT
