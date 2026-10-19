# Spec Delta

## Purpose

Keep an in-flight Codex generation alive across positively identified subscription quota cooldowns by translating trustworthy reset information into OpenCode native retry scheduling without replacing the native retry policy or goal execution.

## ADDED Requirements

### Requirement: Only Codex subscription quota responses are adapted

The adapter MUST adapt only an HTTP 429 generation response from the exact Codex HTTPS host and response path when its structured error type is `usage_limit_reached`.

#### Scenario: Matching quota response

- **WHEN** a generation request to the exact Codex HTTP endpoint returns HTTP 429 with `error.type=usage_limit_reached`
- **THEN** the response is eligible for reset-deadline normalization
- **AND** unrelated request paths and response types are not adapted

#### Scenario: Other 429 response

- **WHEN** an HTTP 429 has a missing, unknown, or different error type
- **THEN** the adapter leaves the response unchanged
- **AND** it does not create a synthetic cooldown or retry deadline

#### Scenario: Non-quota failure

- **WHEN** the response is an authentication error, network error, invalid request, server error, or any non-429 response
- **THEN** existing OpenCode handling receives the failure unchanged
- **AND** no quota retry behavior is added

### Requirement: Valid reset deadlines are normalized conservatively

For a positively classified quota response, the adapter MUST prefer the latest valid authoritative reset deadline from `retry-after` (delta-seconds or HTTP-date), `retry-after-ms`, or structured reset fields and MUST reject invalid or stale values.

#### Scenario: Header and structured deadline priority

- **WHEN** valid `retry-after` delta-seconds or HTTP-date, `retry-after-ms`, `resets_at`, or `resets_in_seconds` values are present, including epoch-form values
- **THEN** the adapter produces a native retry deadline from the latest valid authoritative reset
- **AND** conflicting invalid values do not override the valid deadline

#### Scenario: Reliable textual deadline

- **WHEN** no supported structured value is valid but the body contains one unambiguous textual reset deadline with an explicit timezone or offset
- **THEN** the adapter uses that deadline
- **AND** malformed, stale, ambiguous, or timezone-free text is ignored without inventing a timezone

#### Scenario: Invalid or stale reset inputs

- **WHEN** every supplied retry or structured reset value is invalid, stale, or ambiguous
- **THEN** the adapter rejects those values as deadlines
- **AND** it does not retry early or infer a textual timezone

#### Scenario: Quota without a valid reset

- **WHEN** the error is positively classified as subscription quota exhaustion and no valid reset deadline exists
- **THEN** the adapter uses the configured conservative five-hour fallback
- **AND** the fallback is never used for an unclassified or malformed 429

#### Scenario: Grace and bounded stagger

- **WHEN** a valid deadline is normalized
- **THEN** the native retry deadline includes the required 60-second grace
- **AND** resume uses only a small bounded post-deadline stagger
- **AND** the adapter does not sleep for the cooldown duration inside the HTTP fetch

### Requirement: Built-in Codex transport and request behavior are preserved

The adapter MUST preserve the existing OAuth authentication loader, token refresh, headers, nono routing, fetch helper properties, wrapper chaining, and calling semantics while intercepting only eligible HTTP generation requests.

#### Scenario: Authenticated generation request

- **WHEN** the built-in Codex transport performs OAuth authentication or refresh before a generation request
- **THEN** the adapter preserves that behavior and forwards the authenticated request normally
- **AND** it does not replace the built-in transport with a direct unauthenticated request

#### Scenario: Successful SSE response

- **WHEN** an eligible generation request returns a successful streaming response
- **THEN** the adapter forwards the SSE response without cloning or buffering its body
- **AND** it does not alter successful output identity

#### Scenario: Wrapper chaining

- **WHEN** another process-local fetch wrapper is already installed or is installed after this adapter
- **THEN** existing wrappers remain callable in their established order
- **AND** native fetch helper properties and call behavior remain available

### Requirement: Waiting and retry execution use OpenCode native scheduling

The adapter MUST express a normalized cooldown through OpenCode native retry inputs and MUST leave the installed native five-attempt retry policy and native retry status reporting unchanged.

#### Scenario: Hours-long scheduled retry

- **WHEN** a quota reset is several hours in the future
- **THEN** OpenCode reports native retry status with the next retry timestamp
- **AND** the process remains available for the native scheduler
- **AND** no adapter-owned hours-long sleep or replacement retry loop runs

#### Scenario: Native retry exhaustion

- **WHEN** OpenCode's native five retry attempts are exhausted
- **THEN** the original native failure remains visible to the caller
- **AND** the adapter does not add further attempts or conceal exhaustion

### Requirement: Sol and Luna share one process-local cooldown

The adapter MUST maintain one monotonic in-process subscription route cooldown shared by the primary Sol generation and the general Luna child generation. It MUST return local synthetic 429 responses during that cooldown without holding requests, queuing work, or coordinating in-flight promises.

#### Scenario: Concurrent parent and child quota responses

- **WHEN** Sol and Luna observe matching quota failures concurrently
- **THEN** both observe one account-wide monotonic route deadline
- **AND** each pending generation remains owned by its existing native retry scheduler
- **AND** the adapter does not hold requests in a queue or create an independent retry schedule

#### Scenario: Request during known cooldown

- **WHEN** a generation request arrives before the shared cooldown deadline
- **THEN** the adapter returns a local synthetic HTTP 429 carrying the same native retry deadline
- **AND** no provider request is sent for that attempt

#### Scenario: Deadline boundary and stagger

- **WHEN** the shared deadline has passed
- **THEN** eligible retries may resume after the bounded stagger
- **AND** the adapter does not impose an unbounded extra delay

#### Scenario: Renewed quota deadline

- **WHEN** a renewed matching quota response supplies a later valid reset
- **THEN** the shared cooldown and native retry deadline extend to that later valid deadline
- **AND** the earlier deadline is not used to issue a premature retry

### Requirement: The original generation and goal execution remain intact

The adapter MUST resume the same pending generation without aborting the session, injecting continuation prompts, changing model or agent selection, or duplicating parent delegation or side effects. It MUST not maintain per-session cooldown participation state.

#### Scenario: Parent with one child

- **WHEN** one parent generation delegates to one Luna child and either path enters native quota retry
- **THEN** the same parent and child execution identities remain pending
- **AND** no replacement parent delegation or duplicate child is created

#### Scenario: Cancellation during cooldown

- **WHEN** the operator or native goal lifecycle cancels the pending execution during a cooldown
- **THEN** the native `AbortSignal` cancellation propagates unchanged
- **AND** the account-wide known cooldown remains available to other sessions
- **AND** the adapter does not call `session.abort`, hold the cancelled request, or inject a resume prompt

#### Scenario: Goal safety limits

- **WHEN** native retry scheduling approaches configured goal safety limits
- **THEN** the existing goal limits and task deferral behavior remain authoritative
- **AND** no adapter behavior raises, rewrites, or bypasses those limits

### Requirement: Cancellation protection requires proven generation correlation

The adapter MUST require a stable OpenCode 1.19.0 identity correlating session retry/status/abort events with the corresponding Codex HTTP fetch generation before enabling cancellation protection.

#### Scenario: Stable identity is proven without provider access

- **WHEN** a provider-free source/runtime fixture observes the exact session lifecycle and Codex fetch lifecycle
- **THEN** it reports `PASS` only when one stable identity is present or deterministically derivable at every required boundary
- **AND** evidence contains only allowlisted identifiers, one-way digests, or safe metadata

#### Scenario: Identity is unavailable or heuristic-only

- **WHEN** no unique identity is exposed, or correlation requires timing, prompt hashes, request ordering, or another heuristic
- **THEN** verification reports `BLOCKED`
- **AND** the cancellation guard remains unimplemented and unactivated
- **AND** task 4.2 remains incomplete

### Requirement: Exact cancelled generations cannot issue later provider fetches

After identity proof, the adapter MUST use only bounded process-local per-generation cancellation markers to suppress a later retry for the exact cancelled generation before the provider delegate.

#### Scenario: Cancellation before a pending native retry

- **WHEN** a pending quota retry is cancelled and its exact proven generation identity is marked before the native retry deadline
- **THEN** the later retry does not invoke the provider delegate for that identity
- **AND** native `AbortSignal` and abort semantics remain authoritative
- **AND** no replacement quota retry, continuation prompt, or session abort is created by the adapter

#### Scenario: Unrelated parallel session

- **WHEN** another session has a different proven generation identity and the normal shared route cooldown has expired
- **THEN** the cancellation marker for the first generation does not suppress the unrelated session
- **AND** the unrelated session may use the existing native retry path

#### Scenario: Marker expiry and bounded state

- **WHEN** the native retry deadline plus the small configured grace has passed
- **THEN** the marker is eligible for deterministic cleanup and cannot suppress a later generation
- **AND** marker cardinality never exceeds outstanding quota retries
- **AND** no marker is persisted or included in prompts, headers, raw payload logs, credentials, or tokens

#### Scenario: Cancellation lacks a proven identity

- **WHEN** a cancellation event cannot be correlated to one exact pending generation
- **THEN** the guard fails closed without heuristic suppression
- **AND** native cancellation continues unchanged
- **AND** no unrelated generation is blocked

### Requirement: Cooldown state is process-alive only and HTTP-only

The adapter MUST treat cooldown state as valid only within the live process and MUST explicitly require HTTP Codex transport; it MUST NOT claim WebSocket support or recreate pending native sessions after restart.

#### Scenario: Process restart

- **WHEN** the process restarts while a native cooldown is pending
- **THEN** the pending native session is not recreated by this adapter
- **AND** the operator receives the existing restart behavior rather than a fabricated recovery

#### Scenario: Unsupported WebSocket transport

- **WHEN** a generation uses a WebSocket transport or a transport that cannot prove the exact HTTP Codex path
- **THEN** the adapter declines interception
- **AND** diagnostics and documentation do not claim WebSocket support

### Requirement: Cancellation and unrelated providers remain fail-safe

The adapter MUST leave provider selection, model and agent configuration, non-Codex providers, and native cancellation semantics unchanged.

#### Scenario: Non-Codex provider

- **WHEN** a request is routed to a provider other than the exact Codex HTTP transport
- **THEN** the adapter passes through without quota adaptation
- **AND** no alternate provider or model is selected

#### Scenario: Transport cancellation

- **WHEN** a caller cancels an in-flight fetch before a quota response is available
- **THEN** the cancellation propagates through the existing transport path
- **AND** the adapter does not convert it into a quota retry
