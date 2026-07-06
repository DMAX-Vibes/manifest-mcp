// Vault: encrypted-at-rest storage for manifests, keyed by a capability token.
// ------------------------------------------------------------------
// The connector URL is /mcp/<token>. The token never touches disk:
//   - lookup key   = SHA-256(token)            (what the blob store sees)
//   - cipher key   = HKDF-SHA256(token)        (never stored anywhere)
//   - at rest      = AES-256-GCM ciphertext
// So the server holds ciphertext it cannot decrypt until a request
// arrives carrying the token. Losing the URL = losing the manifest.
// ------------------------------------------------------------------

import {
  randomBytes,
  createHash,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';

const STORE_NAME = 'manifests';
const HKDF_SALT = 'manifestmd-vault-v1';
const HKDF_INFO = 'aes-256-gcm';
export const MAX_MANIFEST_BYTES = 150 * 1024;
export const MAX_NOTE_BYTES = 4 * 1024;

// ---- storage -------------------------------------------------------
// Netlify Blobs in production / linked dev. When Blobs isn't available
// (netlify dev --offline, bare node tests) fall back to a local file
// store — but never in a deployed context, where that would silently
// drop data on the next deploy.

let storePromise = null;

async function fileStore() {
  const { mkdir, readFile, writeFile, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), '.netlify', 'local-blobs', STORE_NAME);
  await mkdir(dir, { recursive: true });
  return {
    async get(key) {
      try { return await readFile(join(dir, key), 'utf8'); }
      catch { return null; }
    },
    async set(key, value) { await writeFile(join(dir, key), value, 'utf8'); },
    async delete(key) { try { await unlink(join(dir, key)); } catch {} },
  };
}

async function getVaultStore() {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        const { getStore } = await import('@netlify/blobs');
        // strong consistency: a read right after add/delete must see it —
        // the default (eventual) served stale manifests in prod testing
        const store = getStore({ name: STORE_NAME, consistency: 'strong' });
        // probe so a misconfigured environment fails here, not mid-request
        await store.get('__probe__');
        return store;
      } catch (err) {
        if (process.env.CONTEXT) throw err; // deployed: never fall back
        return fileStore();
      }
    })();
  }
  return storePromise;
}

// ---- crypto --------------------------------------------------------

export function newToken() {
  return randomBytes(32).toString('base64url');
}

function lookupKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

function cipherKey(token) {
  return Buffer.from(hkdfSync('sha256', token, HKDF_SALT, HKDF_INFO, 32));
}

function encrypt(token, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cipherKey(token), iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    updated: new Date().toISOString(),
  });
}

function decrypt(token, blob) {
  const { iv, tag, ct } = JSON.parse(blob);
  const decipher = createDecipheriv('aes-256-gcm', cipherKey(token), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// ---- vault API -----------------------------------------------------

export async function vaultExists(token) {
  const store = await getVaultStore();
  return (await store.get(lookupKey(token))) !== null;
}

export async function loadManifest(token) {
  const store = await getVaultStore();
  const blob = await store.get(lookupKey(token));
  if (blob === null) return null;
  return decrypt(token, blob);
}

export async function saveManifest(token, text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error(`manifest too large (max ${MAX_MANIFEST_BYTES / 1024}KB)`);
  }
  const store = await getVaultStore();
  await store.set(lookupKey(token), encrypt(token, text));
}

export async function appendNote(token, note) {
  const current = await loadManifest(token);
  if (current === null) return null;
  const day = new Date().toISOString().slice(0, 10);
  const heading = '## Added via your AI (MCP)';
  let next;
  if (current.includes(heading)) {
    next = `${current.trimEnd()}\n- (${day}) ${note.trim()}\n`;
  } else {
    next = `${current.trimEnd()}\n\n${heading}\n- (${day}) ${note.trim()}\n`;
  }
  await saveManifest(token, next);
  return next;
}

export async function deleteVault(token) {
  const store = await getVaultStore();
  await store.delete(lookupKey(token));
}
