// The GitHub Action entry: inputs come in as INPUT_* variables, outputs go to $GITHUB_OUTPUT, and a
// failure is one ::error:: line plus a non-zero exit. No dependencies, Node 20.
'use strict';

const fs = require('node:fs');
const { sendFax, ApiError } = require('./fax');

function input(name, fallback = '') {
  const v = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v.trim();
}

function setOutput(name, value) {
  if (value === undefined || value === null) return;
  const file = process.env.GITHUB_OUTPUT;
  if (file) fs.appendFileSync(file, `${name}=${String(value).replace(/\r?\n/g, ' ')}\n`);
  else process.stdout.write(`::set-output name=${name}::${value}\n`);
}

async function main() {
  // An empty fail_on means never fail, so the raw variable is read: only an unset one takes the default.
  const failOn = (process.env.INPUT_FAIL_ON ?? 'failed,unknown').split(',').map((s) => s.trim()).filter(Boolean);
  const repo = process.env.GITHUB_REPOSITORY || 'local';
  const run = `${process.env.GITHUB_RUN_ID || '0'}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  const result = await sendFax({
    apiKey: input('api_key'),
    baseUrl: input('base_url', 'https://api.faxforagents.com'),
    to: input('to'),
    file: input('file') || undefined,
    text: input('text') || undefined,
    markdown: input('markdown') || undefined,
    cover: {
      subject: input('cover_subject'),
      message: input('cover_message'),
      to_name: input('cover_to_name'),
      from_name: input('cover_from_name'),
    },
    approvalId: input('approval_id') || undefined,
    clientReference: (input('client_reference') || `${repo} run ${run}`).slice(0, 200),
    idempotencyKey: `gha:${repo}:${run}:${input('to')}`,
    wait: input('wait_for_delivery', 'true').toLowerCase() !== 'false',
    timeoutMs: Number(input('timeout_seconds', '600')) * 1000,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const { document, quote, fax } = result;
  setOutput('fax_id', fax.id);
  setOutput('quote_id', quote.id);
  setOutput('document_id', document.id);
  setOutput('state', fax.state);
  setOutput('pages', quote.billable_pages);
  setOutput('pages_sent', fax.pages_sent);
  setOutput('amount_micro', quote.amount_micro);
  setOutput('provider_ref', fax.provider_ref || '');
  if (failOn.includes(fax.state)) {
    throw new Error(`Fax ${fax.id} ended ${fax.state}${fax.failure_code ? ` (${fax.failure_code})` : ''}.`);
  }
}

main().catch((err) => {
  const msg = err instanceof ApiError ? err.message : err && err.message ? err.message : String(err);
  process.stdout.write(`::error::${msg}\n`);
  process.exitCode = 1;
});
