'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const fake = require('./fake-api');

let api;
before(async () => {
  api = await fake.start();
});
after(() => api.server.close());

function runAction(inputs) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ffa-')), 'output');
  fs.writeFileSync(out, '');
  const env = { ...process.env, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: 'acme/site', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env }, (err, stdout, stderr) => {
      const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
      resolve({ code: err ? err.code : 0, stdout, stderr, outputs });
    });
  });
}

test('the entry point sends, waits and writes the outputs', async () => {
  api.state.polls = 0;
  const r = await runAction({ api_key: api.KEY, base_url: api.url, to: '+15550000001', text: 'Deploy done.' });
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.outputs.fax_id, api.FAX);
  assert.equal(r.outputs.quote_id, api.QUOTE);
  assert.equal(r.outputs.state, 'delivered');
  assert.equal(r.outputs.pages, '1');
  assert.equal(r.outputs.pages_sent, '1');
  assert.equal(r.outputs.amount_micro, '39000');
  assert.equal(r.outputs.provider_ref, 'ref-1');
  const send = api.calls.find((c) => c.path === '/v1/faxes');
  assert.equal(send.headers['idempotency-key'], 'gha:acme/site:42-1:+15550000001');
  assert.equal(send.body.client_reference, 'acme/site run 42-1');
});

test('fail_on decides whether a failed fax fails the step', async () => {
  api.state.polls = 0;
  api.state.outcome = 'failed';
  let r = await runAction({ api_key: api.KEY, base_url: api.url, to: '+15550000001', text: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::Fax fax_.* ended failed \(no_answer\)/);
  assert.equal(r.outputs.state, 'failed');
  api.state.polls = 0;
  r = await runAction({ api_key: api.KEY, base_url: api.url, to: '+15550000001', text: 'x', fail_on: '' });
  assert.equal(r.code, 0);
  api.state.outcome = 'delivered';
});

test('a bad key is one ::error:: line with the code', async () => {
  const r = await runAction({ api_key: 'ffa_test_nope', base_url: api.url, to: '+15550000001', text: 'x' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::.*error_code=invalid_token/);
  assert.equal(r.outputs.fax_id, undefined);
});

test('wait_for_delivery false returns once queued', async () => {
  api.state.polls = 0;
  const r = await runAction({ api_key: api.KEY, base_url: api.url, to: '+15550000001', text: 'x', wait_for_delivery: 'false' });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.state, 'queued');
});
