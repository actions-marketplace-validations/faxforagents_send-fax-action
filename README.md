<p align="center">
  <a href="https://faxforagents.com"><img src="https://faxforagents.com/brand/logo-512.png" width="88" alt="Fax for Agents"></a>
</p>

<h1 align="center">send-fax-action</h1>

<p align="center">A GitHub Action that sends a fax through <a href="https://faxforagents.com">Fax for Agents</a> and waits for the outcome. A file or text to a number, from any workflow.</p>

<p align="center">
  <a href="https://faxforagents.com">Website</a> ·
  <a href="https://faxforagents.com/docs/quickstart/">Quickstart</a> ·
  <a href="https://faxforagents.com/docs/api/">API reference</a> ·
  <a href="https://faxforagents.com/docs/sdks/">SDKs</a> ·
  <a href="https://faxforagents.com/mcp/">MCP</a> ·
  <a href="https://app.faxforagents.com">Dashboard</a> ·
  <a href="https://faxforagents.com/pricing/">Pricing</a> ·
  <a href="https://faxforagents.com/changelog/">Changelog</a> ·
  <a href="https://faxforagents.com/affiliates/">Affiliate program</a> ·
  <a href="https://gitlab.com/faxforagents/send-fax-action">GitLab</a>
</p>

<div align="center">

[![ci](https://img.shields.io/github/actions/workflow/status/faxforagents/send-fax-action/ci.yml?branch=main&label=ci)](https://github.com/faxforagents/send-fax-action/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/licence-MIT-1f6feb)](https://github.com/faxforagents/send-fax-action/blob/main/LICENSE) [![release](https://img.shields.io/github/v/release/faxforagents/send-fax-action?label=release)](https://github.com/faxforagents/send-fax-action/releases)

</div>

Fax for Agents is a fax API, a hosted MCP server and SDKs built so AI agents can send and receive
faxes. It is made by JSB Holdings LLC and built by [Synapse](https://synapsereality.io/).

The action runs on Node 20 with no dependencies. It prepares the document and quotes it to the
number. It queues the fax under an idempotency key tied to the workflow run. Then it polls until the
carrier reports `delivered`, `partial`, `failed` or `unknown`.

## Usage

```yaml
- uses: faxforagents/send-fax-action@v1
  with:
    api_key: ${{ secrets.FAXFORAGENTS_API_KEY }}
    to: "+12025550123"
    file: release-notes.pdf
```

Text instead of a file, with a cover sheet and no wait:

```yaml
- uses: faxforagents/send-fax-action@v1
  id: fax
  with:
    api_key: ${{ secrets.FAXFORAGENTS_API_KEY }}
    to: "+12025550123"
    text: "Build ${{ github.run_number }} of ${{ github.repository }} is live."
    cover_subject: "Deploy notice"
    wait_for_delivery: "false"
- run: echo "queued fax ${{ steps.fax.outputs.fax_id }}"
```

Put the key in a repository secret. A test key (`ffa_test_...`) reaches the sandbox only. No carrier,
no cost. The destination number picks the outcome: `+15550000001` is delivered, `+15550000003` is
partial and `+15550000005` is unknown. A live key (`ffa_live_...`) reaches the carrier and spends the
prepaid wallet. Keys are created at [app.faxforagents.com](https://app.faxforagents.com).

## Inputs

| Input | Required | Default | Does |
|---|---|---|---|
| `api_key` | yes | | The API key, from a secret |
| `to` | yes | | Destination in E.164 |
| `file` | one of three | | Path to a PDF, PNG, JPG or TIFF in the workspace |
| `text` | one of three | | Plain text, rendered to a letter PDF |
| `markdown` | one of three | | Markdown, rendered to PDF |
| `cover_subject`, `cover_message`, `cover_to_name`, `cover_from_name` | no | | Fields of an optional cover sheet. Any of them adds a billable cover page |
| `approval_id` | no | | An approved request bound to this send, when the account needs a human approval for live sends |
| `client_reference` | no | repository, run id and attempt | Your own reference on the fax, up to 200 characters |
| `wait_for_delivery` | no | `true` | `false` returns once the fax is queued |
| `timeout_seconds` | no | `600` | How long to wait for a terminal state before the step fails |
| `fail_on` | no | `failed,unknown` | Terminal states that fail the step. Add `partial` to fail on a partial send, or pass an empty string to never fail |
| `base_url` | no | `https://api.faxforagents.com` | Only for a test double |

## Outputs

`fax_id`, `quote_id`, `document_id`, `state`, `pages`, `pages_sent`, `amount_micro` (the quoted price
in USD micro-units, 39000 is $0.039) and `provider_ref`.

## What the step does

1. `POST /v1/documents` with the text or Markdown. A file takes the upload path first: `POST /v1/uploads`,
   a `PUT` of the bytes to the signed URL and `POST /v1/uploads/{id}/complete` with the sha256.
2. `POST /v1/fax-quotes` for the exact price. When the quote says a human approval is required and no
   `approval_id` was given, the step fails before anything is sent.
3. `POST /v1/faxes` with `Idempotency-Key: gha:<repository>:<run id>-<attempt>:<to>`. A re-run of the
   same attempt gets the same fax back instead of a second one. A new attempt is a new send.
4. `GET /v1/faxes/{id}` every three seconds until a terminal state, or until `timeout_seconds`.

A `partial` or `unknown` outcome never retransmits on its own. The evidence the carrier reports on a
delivered fax is logged. It is what the carrier reported, not legal proof the recipient accepted it.

An API refusal fails the step with one `::error::` line that carries the remedy and the stable
`error_code`, for example `error_code=insufficient_balance`.

## Prices

Price card launch-v3 is effective from 2026-11-12. $0.039 per page sent, $0.019 per page received. $2 per
number per month, $19 per month for the Agent workspace. Sandbox pages cost 0.

## Working on this repository

```bash
npm test                  # the send flow and the entry point against a fake API, no network
sh scripts/truthcheck.sh
```

The `sandbox` job in CI runs the action itself against the sandbox whenever the `FAXFORAGENTS_TEST_KEY`
secret is set. That is a sandbox send, never a live one.

Releases: tag `v1.x.y` and move the `v1` tag to it. Workflows reference `@v1`.

## Licence

MIT. See [LICENSE](LICENSE). Security reports go to hello@faxforagents.com.
