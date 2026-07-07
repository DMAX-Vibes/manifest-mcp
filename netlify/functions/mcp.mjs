// Manifest MCP server — remote connector endpoint.
// ------------------------------------------------------------------
// One URL per user: https://readthemanifest.net/mcp/<token>
// Add it to Claude (Settings -> Connectors) or ChatGPT (Developer
// Mode) as a custom connector; the AI can then read the manifest
// and save new durable facts back to it.
//
// Stateless Streamable-HTTP MCP: every POST is one JSON-RPC message,
// answered with plain JSON. No sessions, no SSE, no OAuth — the token
// in the URL *is* the credential (and the encryption key; see vault).
// ------------------------------------------------------------------

import {
  vaultExists,
  loadManifest,
  appendNote,
  MAX_NOTE_BYTES,
} from './_lib/vault.mjs';
import { bump } from './_lib/counters.mjs';

export const config = { path: '/mcp/:token' };

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'get_manifest',
    description:
      "Load the user's manifest — their portable context: who they are, what they're working on, and how they want you to work. Call this at the start of a conversation. Follow the manifest's own instructions; load and use it, don't summarize it back.",
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_to_manifest',
    description:
      "Save one new durable fact about the user to their manifest (a preference, a project update, a correction). Use it when the user says 'remember this' or shares something clearly worth keeping across conversations. One concise fact per call; don't save conversation filler.",
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The single fact to remember, written to be understood in a future conversation with zero context.',
        },
      },
      required: ['note'],
    },
  },
];

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

  let msg;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }

  // Notifications (no id) need no reply body.
  if (msg.id === undefined || msg.id === null) {
    return new Response(null, { status: 202 });
  }

  const token = context.params?.token || '';

  try {
    switch (msg.method) {
      case 'initialize': {
        if (!(await vaultExists(token))) {
          return rpcError(msg.id, -32002, 'This connector URL is not active. Create your manifest at readthemanifest.net and use the exact URL it gives you.');
        }
        const requested = msg.params?.protocolVersion;
        return rpcResult(msg.id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'manifest', version: '1.0.0' },
          instructions:
            "This server holds the user's manifest — their portable context. Call get_manifest at the start of a conversation and follow the manifest's instructions (don't summarize it). Use add_to_manifest to save new durable facts the user wants remembered.",
        });
      }

      case 'ping':
        return rpcResult(msg.id, {});

      case 'tools/list':
        return rpcResult(msg.id, { tools: TOOLS });

      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};

        if (name === 'get_manifest') {
          const manifest = await loadManifest(token);
          if (manifest === null) return toolError(msg.id, 'No manifest found for this URL. The user should recreate it at readthemanifest.net.');
          await bump('mcp_read');
          return toolText(msg.id, manifest);
        }

        if (name === 'add_to_manifest') {
          const note = typeof args.note === 'string' ? args.note.trim() : '';
          if (!note) return toolError(msg.id, 'Nothing to save: "note" must be a non-empty string.');
          if (Buffer.byteLength(note, 'utf8') > MAX_NOTE_BYTES) {
            return toolError(msg.id, `Note too long (max ${MAX_NOTE_BYTES / 1024}KB). Save one concise fact per call.`);
          }
          const updated = await appendNote(token, note);
          if (updated === null) return toolError(msg.id, 'No manifest found for this URL. The user should recreate it at readthemanifest.net.');
          await bump('mcp_note');
          return toolText(msg.id, 'Saved to the manifest.');
        }

        return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      }

      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    console.error('mcp error:', err);
    return rpcError(msg.id, -32603, 'Internal error');
  }
};

// ---- JSON-RPC helpers ----------------------------------------------

function rpcResult(id, result) {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolText(id, text) {
  return rpcResult(id, { content: [{ type: 'text', text }] });
}

function toolError(id, text) {
  return rpcResult(id, { content: [{ type: 'text', text }], isError: true });
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
