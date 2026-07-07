// Vault management for the MCP lane: create / replace / export / delete.
// ------------------------------------------------------------------
// POST /api/manifest-vault
//   { action: "create", manifest: "..." }            -> { url, token }
//   { action: "replace", token: "...", manifest }    -> { ok: true }
//   { action: "export",  token: "..." }              -> { manifest }
//   { action: "delete",  token: "..." }              -> { ok: true }
//
// The token is the capability: whoever holds the connector URL holds
// the manifest. Export/delete honor the lane's promise ("export or
// delete anytime") with nothing but that URL.
// ------------------------------------------------------------------

import {
  newToken,
  vaultExists,
  loadManifest,
  saveManifest,
  deleteVault,
  MAX_MANIFEST_BYTES,
} from './_lib/vault.mjs';
import { bump } from './_lib/counters.mjs';

export const config = { path: '/api/manifest-vault' };

export default async (req) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: 'invalid JSON' });
  }

  const { action, token, manifest } = body;

  try {
    switch (action) {
      case 'create': {
        const err = validateManifest(manifest);
        if (err) return json(400, { error: err });
        const t = newToken();
        await saveManifest(t, manifest);
        await bump('vault_create');
        return json(200, { token: t, url: connectorUrl(req, t) });
      }

      case 'replace': {
        const err = validateManifest(manifest);
        if (err) return json(400, { error: err });
        if (!(await vaultExists(token || ''))) return json(404, { error: 'unknown token' });
        await saveManifest(token, manifest);
        await bump('vault_replace');
        return json(200, { ok: true });
      }

      case 'export': {
        const text = await loadManifest(token || '');
        if (text === null) return json(404, { error: 'unknown token' });
        await bump('vault_export');
        return json(200, { manifest: text });
      }

      case 'delete': {
        if (!(await vaultExists(token || ''))) return json(404, { error: 'unknown token' });
        await deleteVault(token);
        await bump('vault_delete');
        return json(200, { ok: true });
      }

      default:
        return json(400, { error: 'unknown action' });
    }
  } catch (err) {
    console.error('manifest-vault error:', err);
    return json(500, { error: 'internal error' });
  }
};

function validateManifest(text) {
  if (typeof text !== 'string' || !text.trim()) return 'manifest must be a non-empty string';
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    return `manifest too large (max ${MAX_MANIFEST_BYTES / 1024}KB)`;
  }
  return null;
}

function connectorUrl(req, token) {
  const origin = new URL(req.url).origin;
  return `${origin}/mcp/${token}`;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
