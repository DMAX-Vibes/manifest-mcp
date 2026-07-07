// Usage counters — server-side events only, zero client-side beacons.
// ------------------------------------------------------------------
// Counts how often the server's own endpoints get used, nothing more:
// no IPs, no user agents, no tokens, no manifest content — a counter
// per event name, plus one per event-per-day for a rough timeline.
// Read them with: netlify blobs:list counters / blobs:get counters <key>
//
// Read-modify-write without a lock can drop a count under concurrent
// load; at this scale that's an acceptable trade for zero infrastructure.
// Counting must never break or slow a real request: callers await it,
// but every failure is swallowed.
// ------------------------------------------------------------------

const STORE_NAME = 'counters';

let storePromise = null;

async function getCounterStore() {
  if (!storePromise) {
    storePromise = (async () => {
      const { getStore } = await import('@netlify/blobs');
      return getStore({ name: STORE_NAME, consistency: 'strong' });
    })();
  }
  return storePromise;
}

export async function bump(event) {
  try {
    const store = await getCounterStore();
    const day = new Date().toISOString().slice(0, 10);
    for (const key of [event, `${event}:${day}`]) {
      const n = parseInt((await store.get(key)) || '0', 10);
      await store.set(key, String(n + 1));
    }
  } catch {
    /* never let counting take down the request */
  }
}
