# Managed helper API-contract fixtures

`contract-2.2.7.json` is a compact, offline subset of the public OpenCode V2
OpenAPI document retrieved from <https://opencode.ai/v2/openapi.json> on
2026-11-08. It retains only the `/api/info`, session identity, inbox, message,
and prompt operations plus the schemas needed to qualify those routes. The
public `/api/info` 200 response is the unwrapped top-level `ServerInfo` object
(`version`, `pid`, `urls`, and `paths.tmp`), consistent with the pinned SDK's
discovery probe. Session, inbox, message-page, and prompt results retain their
public `data` wrappers. The helper's inbox and message projections replace raw
message text with an empty-string compatibility placeholder and retain only
bounded IDs, timestamps, delivery, cursors, and validated `overseerRelay`
campaign/batch metadata. Known synthetic, move, and compaction inbox records
are ignored. Prompt receipt text is checked against the submitted value and
then omitted; Python integration must validate the structured receipt rather
than expect prompt text from IPC.

The 2.2.7 and 2.3 host versions in tests are synthetic identity values paired
with this recorded contract subset; they are not separate upstream release
snapshots or live qualification evidence. `contract-2.3-additions.json`
is an additive overlay applied to the recorded 2.2.7 contract to construct a
compatible 2.3 test contract, proving optional additive schema properties
remain compatible. `contract-broken-same-version.json` describes a required
prompt field absent from the helper's fixed request; tests apply it to the same
2.2.7-versioned health response to prove schema, not version, controls
compatibility. All response payloads and IDs used in tests are synthetic.
