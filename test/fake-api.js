// A fake of the Fax for Agents REST API on localhost, the same envelopes and ids as the real one for
// the calls the action makes. The destination number picks the outcome like the sandbox does.
'use strict';

const http = require('node:http');

const KEY = 'ffa_test_' + 'a'.repeat(43);
const DOC = 'doc_' + '1'.repeat(32);
const UPL = 'upl_' + '0'.repeat(32);
const QUOTE = 'qte_' + '2'.repeat(32);
const FAX = 'fax_' + '3'.repeat(32);

function start() {
  const calls = [];
  const state = { polls: 0, uploadedBytes: null, outcome: 'delivered' };
  const server = http.createServer((req, res) => {
    let raw = [];
    req.on('data', (c) => raw.push(c));
    req.on('end', () => {
      const body = Buffer.concat(raw);
      const url = new URL(req.url, 'http://x');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const refuse = (status, code, message) =>
        send(status, { error: { code, message, retryable: false, correlation_id: 'corr_1' } });
      const json = () => (body.length ? JSON.parse(body.toString()) : {});
      calls.push({ method: req.method, path: url.pathname, headers: req.headers, body: url.pathname === '/upload/signed' ? body : json() });

      if (url.pathname === '/upload/signed') {
        state.uploadedBytes = body;
        return send(200, { id: UPL, status: 'received', received_size: body.length });
      }
      if (req.headers.authorization !== `Bearer ${KEY}`) return refuse(401, 'invalid_token', 'The API key was rejected.');
      if (req.method === 'POST' && url.pathname === '/v1/uploads') {
        const b = json();
        return send(201, { id: UPL, status: 'pending', filename: b.filename, content_type: b.content_type, declared_size: b.size_bytes,
          received_size: 0, sha256: null, upload_url: `http://127.0.0.1:${server.address().port}/upload/signed`, upload_method: 'PUT' });
      }
      if (req.method === 'POST' && url.pathname === `/v1/uploads/${UPL}/complete`) {
        return send(200, { id: UPL, status: 'completed', sha256: json().sha256 });
      }
      if (req.method === 'POST' && url.pathname === '/v1/documents') {
        const b = json();
        return send(201, { id: DOC, page_count: b.upload_id ? 3 : 1, sha256: 'ab'.repeat(32), status: 'ready', render_status: 'queued',
          source: b.upload_id ? 'upload' : b.text ? 'text' : 'markdown', filename: b.filename || 'document.pdf' });
      }
      if (req.method === 'POST' && url.pathname === '/v1/fax-quotes') {
        const b = json();
        if (b.to === '+15550000009') return refuse(422, 'invalid_destination', 'Not a fax route.');
        const cover = b.cover ? 1 : 0;
        const pages = (b.document_id === DOC ? 1 : 0) + cover;
        return send(201, { id: QUOTE, environment: 'test', document_id: b.document_id, to: b.to, route: 'us', document_pages: 1,
          cover_pages: cover, billable_pages: pages, amount_micro: pages * 39000, currency: 'USD', price_version: 'launch-v1',
          cover: b.cover || null, authorization_required: b.to === '+15550000007', warnings: [], expires_at: '2026-10-31T00:10:00Z',
          expired: false, consumed_by_job_id: null, created_at: '2026-10-31T00:00:00Z' });
      }
      const job = (st, extra = {}) => ({ id: FAX, environment: 'test', direction: 'outbound', state: st, failure_code: null,
        to: '+15550000001', from: null, route: 'us', document_id: DOC, document_sha256: 'ab'.repeat(32), quote_id: QUOTE,
        billable_pages: 1, cover_pages: 0, pages_sent: 0, amount_micro: 39000, captured_micro: 0, currency: 'USD',
        provider: 'sandbox', provider_ref: null, client_reference: null, attempt_count: 0, evidence: null, ...extra });
      if (req.method === 'POST' && url.pathname === '/v1/faxes') {
        const b = json();
        if (!req.headers['idempotency-key']) return refuse(400, 'idempotency_key_required', 'Pass an Idempotency-Key.');
        if (b.quote_id !== QUOTE) return refuse(404, 'not_found', 'No such quote.');
        return send(201, job('queued', { approval_id: b.approval_id || null, client_reference: b.client_reference || null }));
      }
      if (req.method === 'GET' && url.pathname === `/v1/faxes/${FAX}`) {
        state.polls += 1;
        if (state.polls === 1) return send(200, job('active'));
        if (state.outcome === 'delivered') {
          return send(200, job('delivered', { pages_sent: 1, provider_ref: 'ref-1', evidence: { remote_station_id: '+15550000001', pages: 1 } }));
        }
        if (state.outcome === 'partial') return send(200, job('partial', { pages_sent: 0, failure_code: 'line_dropped' }));
        if (state.outcome === 'stuck') return send(200, job('active'));
        return send(200, job('failed', { failure_code: 'no_answer' }));
      }
      refuse(404, 'not_found', 'No such route.');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, state, url: `http://127.0.0.1:${server.address().port}`, KEY, DOC, QUOTE, FAX, UPL }));
  });
}

module.exports = { start };
