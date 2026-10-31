// The send flow of Fax for Agents with no dependencies beyond Node 20: prepare a document (text,
// Markdown or an uploaded file), quote it to one number, queue the fax under an idempotency key, then
// poll until a terminal state. Mirrors faxforagents/sdk-typescript Documents.upload and Faxes.wait
// (2026-10-31). Every API refusal is reported with its stable error code and a remedy.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '1.0.0';
const TERMINAL = new Set(['delivered', 'partial', 'failed', 'unknown']);
const CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};
const REMEDIES = {
  invalid_token: 'The API key was rejected. Put an ffa_test_... or ffa_live_... key in the api_key input, from a repository secret.',
  scope_missing: 'The key lacks a scope this send needs (document:write, fax:quote, fax:send, fax:read).',
  approval_required:
    'No approval and no policy allows this send. A person approves the quote in the dashboard and the approval id goes in approval_id, or the account owner writes a policy.',
  approval_expired: 'The approval expired with its quote. Quote again and ask again.',
  approval_mismatch: 'The approval was given for a different send.',
  approval_consumed: 'This approval was already used. One approval, one send.',
  insufficient_balance: 'The wallet does not cover this fax. A person tops it up in the dashboard.',
  quote_expired: 'The quote expired before the send. Run the step again.',
  rate_limited: 'Rate limit reached. Run the step again in a few seconds; the idempotency key makes it safe.',
};

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(`${REMEDIES[code] || message} (error_code=${code}, http ${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function contentTypeOf(filename) {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] || 'application/pdf';
}

function makeApi({ baseUrl, apiKey, fetchImpl }) {
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch = fetchImpl || globalThis.fetch;
  return async function request(method, url, { json, params, headers, body } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) q.set(k, String(v));
    const full = (url.startsWith('http') ? url : base + url) + (q.toString() ? `?${q}` : '');
    const h = { Accept: 'application/json', 'User-Agent': `faxforagents-send-fax-action/${VERSION}`, ...(headers || {}) };
    if (!url.startsWith('http')) h.Authorization = `Bearer ${apiKey}`;
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(Object.fromEntries(Object.entries(json).filter(([, v]) => v !== undefined && v !== null)));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let res;
    try {
      res = await doFetch(full, { method, headers: h, body: payload, signal: controller.signal });
    } catch (err) {
      throw new Error(`The API could not be reached (${err && err.name === 'AbortError' ? 'timeout' : err.message}).`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status >= 400) {
      const err = (data && data.error) || {};
      throw new ApiError(res.status, err.code || 'http_error', err.message || `HTTP ${res.status}`, err.details);
    }
    return data || {};
  };
}

async function prepareDocument(api, { file, text, markdown, readFile }) {
  const given = [file, text, markdown].filter((v) => v && String(v).trim()).length;
  if (given !== 1) throw new Error('Pass exactly one of file, text or markdown.');
  if (!file) return api('POST', '/v1/documents', { json: { text: text || undefined, markdown: markdown || undefined } });
  const bytes = (readFile || fs.readFileSync)(file);
  const filename = path.basename(file);
  const contentType = contentTypeOf(filename);
  const session = await api('POST', '/v1/uploads', {
    json: { filename, size_bytes: bytes.byteLength, content_type: contentType },
  });
  if (!session.upload_url) throw new Error('The upload session carries no upload_url.');
  await api(session.upload_method || 'PUT', session.upload_url, { body: bytes, headers: { 'Content-Type': contentType } });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  await api('POST', `/v1/uploads/${session.id}/complete`, { json: { sha256 } });
  return api('POST', '/v1/documents', { json: { upload_id: session.id, filename } });
}

/**
 * Send one fax and, when asked, wait for its outcome. Returns the document, quote and final fax job.
 * `log` receives one line per step. `sleep` and `now` exist so the tests run without waiting.
 */
async function sendFax(opts) {
  const {
    apiKey, baseUrl = 'https://api.faxforagents.com', to, file, text, markdown, cover, approvalId, clientReference,
    idempotencyKey, wait = true, timeoutMs = 600_000, intervalMs = 3_000, log = () => {}, sleep, now = Date.now,
    fetchImpl, readFile,
  } = opts;
  if (!apiKey) throw new Error('api_key is required.');
  if (!to || !/^\+[1-9]\d{6,14}$/.test(to)) throw new Error('to must be a fax number in E.164, for example +12025550123.');
  const api = makeApi({ baseUrl, apiKey, fetchImpl });
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const document = await prepareDocument(api, { file, text, markdown, readFile });
  log(`Document ${document.id}: ${document.page_count} page(s), sha256 ${String(document.sha256).slice(0, 12)}...`);

  const coverFields = Object.fromEntries(Object.entries(cover || {}).filter(([, v]) => v && String(v).trim()));
  const quote = await api('POST', '/v1/fax-quotes', {
    json: { document_id: document.id, to, cover: Object.keys(coverFields).length ? coverFields : undefined },
  });
  log(
    `Quote ${quote.id}: ${quote.billable_pages} billable page(s) to ${quote.to} for ${quote.amount_micro} micro ` +
      `($${(Number(quote.amount_micro) / 1_000_000).toFixed(3)}), expires ${quote.expires_at}` +
      (quote.authorization_required ? ', a human approval is required' : ''),
  );
  if (quote.authorization_required && !approvalId) {
    throw new ApiError(403, 'approval_required', 'A human must approve this send.', null);
  }

  const idem = idempotencyKey || `gha:${quote.id}`;
  let job = await api('POST', '/v1/faxes', {
    json: { quote_id: quote.id, approval_id: approvalId || undefined, client_reference: clientReference || undefined },
    headers: { 'Idempotency-Key': idem },
  });
  log(`Fax ${job.id} queued to ${job.to} (${job.billable_pages} page(s), ${job.amount_micro} micro held).`);

  if (wait) {
    const deadline = now() + timeoutMs;
    let lastState = job.state;
    while (!TERMINAL.has(job.state)) {
      if (now() >= deadline) {
        throw new Error(`Fax ${job.id} is still ${job.state} after ${Math.round(timeoutMs / 1000)} seconds. Read it later with GET /v1/faxes/${job.id}.`);
      }
      await pause(intervalMs);
      job = await api('GET', `/v1/faxes/${job.id}`);
      if (job.state !== lastState) {
        log(`Fax ${job.id} is ${job.state}.`);
        lastState = job.state;
      }
    }
    const ev = job.evidence && typeof job.evidence === 'object' ? job.evidence : null;
    if (ev) {
      log(
        `Evidence from ${job.provider}: ${job.pages_sent} of ${job.billable_pages} page(s)` +
          (job.provider_ref ? `, provider reference ${job.provider_ref}` : '') +
          '. It is what the carrier reported, not legal proof the recipient accepted it.',
      );
    }
  }
  return { document, quote, fax: job, idempotencyKey: idem };
}

module.exports = { sendFax, ApiError, contentTypeOf, TERMINAL, VERSION };
