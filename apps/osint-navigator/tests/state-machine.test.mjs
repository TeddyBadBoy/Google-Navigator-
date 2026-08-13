// Headless regression tests for the ONE-ACTIVE-RUN guarantee in site-adapter.js.
//   node apps/osint-navigator/tests/state-machine.test.mjs
// Stubs just enough browser surface to load the real adapter unmodified.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CASE1 = 'https://ksalnnh.net/pr/48cb07b7630f2a9efee3bf105dde3754dad357b68ee520729dd7c89668b5be68.jpg';
const CASE2 = 'https://ksalnnh.net/pr/d823c82e185d66f66d9c80190fe9eeb9641c28c52be57003258f43f64c4f7438.jpg';

let events, store, pending, runCounter;

function loadAdapter() {
  events = []; store = new Map(); pending = []; runCounter = 0;
  const win = {
    dispatchEvent(e) { events.push({type: e.type, detail: e.detail}); return true; },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  };
  globalThis.window = win;
  globalThis.CustomEvent = win.CustomEvent;
  globalThis.sessionStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  // Deferred fetch: the test decides when (and in which order) each run resolves.
  globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
    const entry = {url, body: JSON.parse(opts.body), signal: opts.signal, resolve, reject};
    // Provides BOTH text() and json() so the harness is fair to any adapter revision.
    const respond = (ok, status, bodyText) => resolve({
      ok, status,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText)
    });
    entry.settle = payload => respond(true, 200, JSON.stringify({run_id: `run-${++runCounter}`, reset: true, ...payload}));
    entry.settleError = (status, text) => respond(false, status, text);
    opts.signal.addEventListener?.('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err);
    });
    pending.push(entry);
  });
  new Function(readFileSync(join(here, '..', 'site-adapter.js'), 'utf8'))();
  return globalThis.window.OSINTNavigatorFreshRun;
}

const results = [];
function check(name, cond, extra = '') {
  results.push({name, ok: Boolean(cond), extra});
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const settled = p => p.then(v => ({v}), e => ({e}));
const tick = () => new Promise(r => setImmediate(r));

// ── TEST A: CASE2 submitted while CASE1 is still in flight ────────────────────
async function testA() {
  console.log('\nTEST A — CASE2 supersedes an in-flight CASE1');
  const api = loadAdapter();
  const a = settled(api.analyze({url: CASE1}));
  await tick();
  const req1 = pending[0];
  check('CASE1 actually issued a POST', pending.length === 1 && req1?.body.url === CASE1);

  const b = settled(api.analyze({url: CASE2}));
  await tick();
  const req2 = pending[1];
  check('CASE2 issued its own POST', req2?.body.url === CASE2);
  check('CASE1 request was aborted', req1.signal.aborted);

  // CASE1 answers LATE, after CASE2 — the classic overwrite window.
  req1.settle({status: 'CANDIDATE_FOUND', candidates: [{lat: 52.1914531, lon: 21.0060642}]});
  req2.settle({status: 'NO_COORDINATES_FOUND', candidates: []});
  const ra = await a, rb = await b;

  check('late CASE1 result is ignored', ra.v?.ignored === true || ra.e, `reason=${ra.v?.reason ?? ra.e?.message}`);
  check('CASE2 result is returned', rb.v?.status === 'NO_COORDINATES_FOUND');
  const rendered = events.filter(e => e.type === 'osint:result');
  check('exactly one result event was emitted', rendered.length === 1, `got ${rendered.length}`);
  check('the rendered result is CASE2, not CASE1', rendered[0]?.detail.status === 'NO_COORDINATES_FOUND');
  check('no CASE1 coordinates survive in storage', !String(store.get('osint.currentRun') || '').includes('52.1914531'));
}

// ── TEST B: success, then a failing input ─────────────────────────────────────
async function testB() {
  console.log('\nTEST B — ERROR must not restore the previous point');
  const api = loadAdapter();
  const a = settled(api.analyze({url: CASE1}));
  await tick();
  pending[0].settle({status: 'CANDIDATE_FOUND', candidates: [{lat: 52.1914531, lon: 21.0060642}]});
  await a;
  check('CASE1 stored a current run', String(store.get('osint.currentRun')).includes('52.1914531'));

  const b = settled(api.analyze({url: 'https://example.com/not-an-image'}));
  await tick();
  check('old point cleared BEFORE the new response arrives',
        events.some(e => e.type === 'osint:reset') && !store.has('osint.currentRun'));

  pending[1].settleError(400, JSON.stringify({status: 'RUN_FAILED', error: 'Response is not a supported image'}));
  const rb = await b;
  check('failing run rejects', Boolean(rb.e), rb.e?.message);
  check('an error event was emitted', events.some(e => e.type === 'osint:error'));
  check('NO current run is left behind', !store.has('osint.currentRun'));
  check('no result event followed the error', events.filter(e => e.type === 'osint:result').length === 1);
  const lastResult = events.filter(e => e.type === 'osint:result').at(-1);
  check('CASE1 lives only in history, never as current state',
        lastResult?.detail.candidates[0]?.lat === 52.1914531 && !store.has('osint.currentRun'));
}

// ── TEST C: CASE1 → CASE2 → CASE1, three distinct runs ────────────────────────
async function testC() {
  console.log('\nTEST C — repeating an earlier input still starts from zero');
  const api = loadAdapter();
  const ids = [];
  for (const url of [CASE1, CASE2, CASE1]) {
    const p = settled(api.analyze({url}));
    await tick();
    pending.at(-1).settle({status: 'CANDIDATE_FOUND', candidates: []});
    const r = await p;
    ids.push(r.v?.run_id);
  }
  check('three runs produced three run_ids', new Set(ids).size === 3, ids.join(', '));
  check('each of the three runs cleared state first', events.filter(e => e.type === 'osint:reset').length === 3);
}

// ── TEST D: self-abort regression (the reported "no POST reached Vercel") ─────
async function testD() {
  console.log('\nTEST D — a re-render during a run must not kill the request');
  const api = loadAdapter();
  const p = settled(api.analyze({url: CASE1}));
  await tick();
  // React re-render re-fires onChange with the SAME value while the run is in flight.
  const changed = api.inputChanged({url: CASE1});
  check('duplicate onChange is a no-op', changed.changed === false);
  check('in-flight request was NOT aborted', !pending[0].signal.aborted);
  pending[0].settle({status: 'CANDIDATE_FOUND', candidates: [{lat: 52.1914531, lon: 21.0060642}]});
  const r = await p;
  check('run completed normally', r.v?.status === 'CANDIDATE_FOUND');

  // Re-submitting the same URL is still a brand new run, and must still clear the screen.
  const q = settled(api.analyze({url: CASE1}));
  await tick();
  check('re-submit cleared the visible result', !store.has('osint.currentRun'));
  pending.at(-1).settle({status: 'CANDIDATE_FOUND', candidates: []});
  await q;
}

// ── TEST E: oversized upload is refused client-side, not by a CORS-less 413 ───
async function testE() {
  console.log('\nTEST E — upload budget stays under the 4.5 MB edge limit');
  const api = loadAdapter();
  const file = {name: 'big.jpg', type: 'image/jpeg', size: 4 * 1024 * 1024, lastModified: 1};
  globalThis.createImageBitmap = async () => { throw new Error('no decoder in node'); };
  const r = await settled(api.analyze({file}));
  check('oversized photo fails client-side with a clear message', Boolean(r.e), r.e?.message);
  check('no request was sent to the API', pending.length === 0);
  check('an error event reached the UI', events.some(e => e.type === 'osint:error'));
}

for (const t of [testA, testB, testC, testD, testE]) await t();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log('  - ' + f.name)); process.exit(1); }
