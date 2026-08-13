// End-to-end regression against a deployed engine. Verifies each case starts from zero.
//   node apps/osint-navigator/tests/live-cases.test.mjs [https://your-deployment]
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const BASE = process.argv[2] || 'https://osint-navigator-engine.vercel.app';
const ORIGIN = 'https://osint-navigator.wojciechwoytynowski.chatgpt.site';
const here = dirname(fileURLToPath(import.meta.url));
const suite = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const results = [];
function check(name, ok, extra = '') {
  results.push({name, ok: Boolean(ok)});
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}
const run = url => fetch(`${BASE}/api/run`, {
  method: 'POST',
  headers: {'content-type': 'application/json', origin: ORIGIN},
  body: JSON.stringify({url})
}).then(async r => ({status: r.status, headers: r.headers, body: await r.json()}));

console.log(`engine: ${BASE}\n`);

console.log('CORS preflight');
for (const [label, origin] of [['allowed Site origin', ORIGIN], ['sandboxed iframe', 'null'], ['unknown origin', 'https://evil.example']]) {
  const r = await fetch(`${BASE}/api/run`, {
    method: 'OPTIONS',
    headers: {origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type'}
  });
  const acao = r.headers.get('access-control-allow-origin');
  const seen = r.headers.get('x-osint-origin-seen');
  console.log(`  ${label.padEnd(20)} origin=${origin.padEnd(60)} ACAO=${acao || '(none)'} seen=${seen || '(n/a)'}`);
}
check('preflight allows the real Site origin',
  (await fetch(`${BASE}/api/run`, {method: 'OPTIONS', headers: {origin: ORIGIN, 'access-control-request-method': 'POST'}}))
    .headers.get('access-control-allow-origin') === ORIGIN);

const seenRunIds = [];
for (const c of suite.cases) {
  console.log(`\n${c.id}`);
  const r = await run(c.reference_url);
  seenRunIds.push(r.body.run_id);
  const got = r.body.candidates?.[0];

  check('HTTP 200', r.status === 200, `status=${r.body.status}`);
  check('response is marked as a fresh run', r.body.reset === true && r.body.state?.current_only === true);
  check('sha256 matches the requested image', r.body.image?.sha256 === c.reference_url.split('/').pop().replace('.jpg', ''));

  if (c.expected_coordinates) {
    check('a coordinate candidate was found', Boolean(got),
      got ? `${got.lat}, ${got.lon} via ${got.source}` : `status=${r.body.status} warnings=${JSON.stringify(r.body.warnings || [])}`);
    if (got) {
      const [lat, lon] = c.expected_coordinates;
      check('candidate matches the visible overlay',
        Math.abs(got.lat - lat) < 1e-4 && Math.abs(got.lon - lon) < 1e-4, `expected ${lat}, ${lon}`);
    }
    check('coordinates from the image are CANDIDATE, never VERIFIED', !got || got.verified === false);
  }
  if (c.regression_guard === 'must_not_return_52.1914531') {
    check('does NOT leak case-001 coordinates', !JSON.stringify(r.body.candidates || []).includes('52.1914531'));
  }
}

check('every case received a distinct run_id', new Set(seenRunIds).size === seenRunIds.length, seenRunIds.join(', '));

// Repeating case 001 after case 002 must still be a brand new run.
const again = await run(suite.cases[0].reference_url);
check('re-running an earlier case yields a new run_id', !seenRunIds.includes(again.body.run_id));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exit(1);
