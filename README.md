# opencode-tools

Tools for [OpenCode](https://opencode.ai), developed and verified in a nono-sandboxed environment.

| Package | Description |
| --- | --- |
| [`opencode-codex-quota-retry`](opencode-codex-quota-retry/) | Native-retry plugins that wait out Codex usage-limit resets and Claude session limits (no response rewriting, no adapter retry loop). |
| [`opencode-overseer-relay`](opencode-overseer-relay/) | Overseer relay and skills for coordinating a two-source A/B worker campaign (work in progress). |

Each package has its own README with test procedures. Tests are provider-free. Do not commit credentials; they are runtime-injected.

## Provenance

History was split from a private sandbox repository. Original-license attribution and provenance records are kept inside each package (see `provenance/`).

## License

MIT (see [`LICENSE`](LICENSE)), except for third-party material that keeps its own terms:
`opencode-codex-quota-retry/provenance/` preserves the original
[Fair Source License 1.0](opencode-codex-quota-retry/provenance/LICENSE.from-neverendingquest.txt)
(MoonlightByte) for code migrated from NeverEndingQuest, and `opencode-overseer-relay/managed/licenses/`
carries the OpenCode MIT notice. Absolute paths in historical provenance and retirement
scripts were redacted to `/Users/user`.
