# manifest-mcp

The server behind the link option at [readthemanifest.net](https://readthemanifest.net) —
one personal connector URL that lets Claude and ChatGPT read your manifest (your portable
context) and save new facts to it.

This repo exists so you don't have to take our word for what the server does.
Read it. It's three small files.

## How it treats your manifest

Your connector URL looks like `https://readthemanifest.net/mcp/<token>`. The token is a
long random secret, and it does two jobs:

1. **It's the address.** The server hashes the token (SHA-256) and uses the hash to label
   your storage slot. The token itself is never written down — not in a database, not in
   a log we keep.
2. **It's the key.** Your manifest is encrypted (AES-256-GCM) with a key derived from the
   token (HKDF). So what sits in storage is a locked file the server cannot open on its own.
   It is only unlocked in the moment your AI asks for it, because the request carries the key.

No accounts, no email, no passwords. The honest consequence: **lose the URL and the
manifest is unrecoverable** — there is nothing to reset. Export a copy anytime.

## What "open source" does and doesn't prove

Reading this code tells you what the published server does. It cannot prove what a remote
server is running — no open-source project's deployment can. If that distinction matters
to you, Manifest's GitHub options keep your context entirely in your own hands, and this
repo lets you **run your own copy of this server** (below) so the deployment is yours too.

## The files

- `netlify/functions/mcp.mjs` — the MCP endpoint (`POST /mcp/:token`). Stateless
  JSON-RPC over HTTP. Two tools: `get_manifest` (read) and `add_to_manifest`
  (append one dated fact).
- `netlify/functions/manifest-vault.mjs` — vault management (`POST /api/manifest-vault`):
  create, replace, export, delete.
- `netlify/functions/_lib/vault.mjs` — the storage and crypto described above.
  Storage is Netlify Blobs.

Limits: manifest ≤ 150KB, note ≤ 4KB.

## Run your own

Deploy this repo to any Netlify account (free tier works; Blobs is enabled automatically),
then add your own `https://<your-site>/mcp/<token>` as a custom connector. To try it
locally:

```bash
npm install
npx netlify dev --offline
# create a vault
curl -s -X POST http://localhost:8888/api/manifest-vault \
  -H 'Content-Type: application/json' \
  -d '{"action":"create","manifest":"# Manifest\n\nHello."}'
# read it the way your AI would (use the returned token)
curl -s -X POST http://localhost:8888/mcp/<token> \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_manifest","arguments":{}}}'
```

(Offline local dev stores vaults as files under `.netlify/local-blobs/`; deployed, it's
Netlify Blobs with strong read-after-write consistency.)

## Usage counting

The server tallies how often its endpoints get used — an anonymous counter per
event name (`vault_create`, `mcp_read`, …) plus a per-day variant, in a separate
blob store. That's the whole record: no IPs, no user agents, no tokens, no
manifest content. See `netlify/functions/_lib/counters.mjs` — it's ~30 lines.

## License

MIT.
