# Offline OpenCode session response fixture

The fixture encodes the public OpenCode v2 OpenAPI contract for
`GET /api/session/{id}` as checked on 2026-11-08 from
<https://opencode.ai/v2/openapi.json>. That operation returns a `data` wrapper
containing `Session.Info`; the relevant identity fields are `id`, optional
`agent`, `location.directory`, optional top-level `subpath`, and `time` with
`created`, `updated`, and optional `archived` timestamps. The fixture values
are synthetic and its shape is an offline contract fixture, not a live
response or proof that an installed CLI/server pair is qualified.

The command-line invocation is separately exercised with local `opencode
--help` and `opencode api --help` output. No live `opencode api` request, server
start, or provider/session operation was used to create or verify this fixture.

The delivery fixtures `prompt-admission.json`, `inbox-pending.json`, and
`messages-page.json` are synthetic examples of the checked V2 shapes for the
queued prompt receipt, pending inbox item, and user-message page. They use a
synthetic campaign, batch, session, message ID, and timestamp. Tests retarget
the metadata to a temporary offline campaign; these fixtures are not live
responses or qualification evidence.
