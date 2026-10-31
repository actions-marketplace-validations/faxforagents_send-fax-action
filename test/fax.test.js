'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { after, before, beforeEach, test } = require('node:test');

const { sendFax, ApiError } = require('../src/fax');
const fake = require('./fake-api');

let api;
const noSleep = async () => {};

before(async () => {
  api = await fake.start();
});
after(() => api.server.close());
beforeEach(() => {
  api.calls.length = 0;
  api.state.polls = 0;
  api.state.outcome = 'delivered';
});

const base = () => ({ apiKey: api.KEY, baseUrl: api.url, sleep: noSleep });

test('text is prepared, quoted, queued under an idempotency key and polled to delivered', async () => {
  const lines = [];
  const r = await sendFax({ ...base(), to: '+15550000001', text: 'Hello from CI.', log: (l) => lines.push(l) });
  assert.deepEqual(api.calls.map((c) => [c.method, c.path]), [
    ['POST', '/v1/documents'], ['POST', '/v1/fax-quotes'], ['POST', '/v1/faxes'], ['GET', `/v1/faxes/${api.FAX}`], ['GET', `/v1/faxes/${api.FAX}`],
  ]);
  assert.deepEqual(api.calls[0].body, { text: 'Hello from CI.' });
  assert.deepEqual(api.calls[1].body, { document_id: api.DOC, to: '+15550000001' });
  assert.equal(api.calls[2].headers['idempotency-key'], `gha:${api.QUOTE}`);
  assert.equal(api.calls[2].headers.authorization, `Bearer ${api.KEY}`);
  assert.equal(r.fax.state, 'delivered');
  assert.equal(r.fax.pages_sent, 1);
  assert.equal(r.quote.amount_micro, 39000);
  assert.match(lines.join('\n'), /queued/);
  assert.match(lines.join('\n'), /not legal proof/);
});

test('a file goes through the signed upload with its sha256', async () => {
  const bytes = Buffer.from('%PDF-1.4 fake');
  const r = await sendFax({ ...base(), to: '+15550000001', file: '/tmp/letter.pdf', readFile: () => bytes, wait: false });
  const paths = api.calls.map((c) => [c.method, c.path]);
  assert.deepEqual(paths, [
    ['POST', '/v1/uploads'], ['PUT', '/upload/signed'], ['POST', `/v1/uploads/${api.UPL}/complete`], ['POST', '/v1/documents'],
    ['POST', '/v1/fax-quotes'], ['POST', '/v1/faxes'],
  ]);
  assert.deepEqual(api.calls[0].body, { filename: 'letter.pdf', size_bytes: bytes.length, content_type: 'application/pdf' });
  assert.equal(api.calls[1].headers.authorization, undefined, 'the signed URL carries no API key');
  assert.equal(api.state.uploadedBytes.toString(), bytes.toString());
  assert.equal(api.calls[2].body.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(api.calls[3].body, { upload_id: api.UPL, filename: 'letter.pdf' });
  assert.equal(r.fax.state, 'queued');
});

test('the cover sheet and the approval id are passed through', async () => {
  await sendFax({ ...base(), to: '+15550000001', markdown: '# Hi', cover: { subject: 'Invoice', message: '', to_name: 'Desk' },
    approvalId: 'apr_' + '5'.repeat(32), clientReference: 'order 7', wait: false });
  assert.deepEqual(api.calls[1].body.cover, { subject: 'Invoice', to_name: 'Desk' });
  assert.equal(api.calls[2].body.approval_id, 'apr_' + '5'.repeat(32));
  assert.equal(api.calls[2].body.client_reference, 'order 7');
});

test('a quote that needs a human approval stops before the send', async () => {
  await assert.rejects(sendFax({ ...base(), to: '+15550000007', text: 'x' }), (e) => e instanceof ApiError && e.code === 'approval_required' && /approves the quote/.test(e.message));
  assert.equal(api.calls.filter((c) => c.path === '/v1/faxes').length, 0);
});

test('input mistakes are refused before any request', async () => {
  await assert.rejects(sendFax({ ...base(), to: '+15550000001' }), /exactly one of file, text or markdown/);
  await assert.rejects(sendFax({ ...base(), to: '+15550000001', text: 'a', markdown: 'b' }), /exactly one/);
  await assert.rejects(sendFax({ ...base(), to: '5550000001', text: 'a' }), /E\.164/);
  await assert.rejects(sendFax({ ...base(), apiKey: '', to: '+15550000001', text: 'a' }), /api_key is required/);
  assert.equal(api.calls.length, 0);
});

test('API refusals carry the stable code and a remedy', async () => {
  await assert.rejects(sendFax({ ...base(), apiKey: 'ffa_test_wrong', to: '+15550000001', text: 'a' }), /error_code=invalid_token/);
  await assert.rejects(sendFax({ ...base(), to: '+15550000009', text: 'a' }), /Not a fax route\. \(error_code=invalid_destination, http 422\)/);
});

test('partial and failed are terminal states, a stuck fax times out', async () => {
  api.state.outcome = 'partial';
  let r = await sendFax({ ...base(), to: '+15550000001', text: 'a' });
  assert.equal(r.fax.state, 'partial');
  api.state.polls = 0;
  api.state.outcome = 'failed';
  r = await sendFax({ ...base(), to: '+15550000001', text: 'a' });
  assert.equal(r.fax.state, 'failed');
  api.state.polls = 0;
  api.state.outcome = 'stuck';
  let clock = 0;
  await assert.rejects(
    sendFax({ ...base(), to: '+15550000001', text: 'a', timeoutMs: 10_000, intervalMs: 3_000, now: () => clock, sleep: async (ms) => { clock += ms; } }),
    /still active after 10 seconds/,
  );
});
