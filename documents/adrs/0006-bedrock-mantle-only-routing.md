# ADR-0006: Route AWS Bedrock exclusively through Mantle

## Status
Accepted

## Date
2026-07-15

## Context

Bedrock's native Converse transport and its access-key/secret-key configuration
surface require a separate request implementation, credential UI, and model
capability path. Bedrock Mantle instead exposes supported Bedrock models through
Anthropic- and OpenAI-compatible endpoints using short-lived bearer tokens.
Keeping both transports would make routing, authentication, streaming, and model
metadata behavior depend on an ambiguous per-model fallback.

## Decision

OpenAgentd hard-converts the built-in `bedrock:` provider to Mantle-only routing.
It uses either the direct Mantle API key/bearer token in
`AWS_BEARER_TOKEN_BEDROCK` or a token minted from the configured AWS
profile/default credential chain; the access-key/secret-key Settings UI and
native Converse implementation are removed. Route metadata
from Models.dev is accepted only after safe normalization and chooses the Mantle
OpenAI endpoint variant and API family; Anthropic model IDs use the Messages
delegate. OpenAI delegates use the validated `/v1` or `/openai/v1` route and
Responses requests send `store: false`.

## Alternatives Considered

### Retain native Converse alongside Mantle

- Pros: preserves existing access-key configuration and can serve models outside
  Mantle.
- Cons: duplicates transport, streaming, tool, and auth behavior and leaves
  opaque fallback selection when model metadata changes.
- Rejected because: the product now standardizes Bedrock on Mantle and the user
  explicitly approved this hard conversion.

### Keep access-key and secret-key fields as a Mantle token source

- Pros: familiar setup for existing users.
- Cons: expands the persisted secret surface and duplicates the standard AWS
  credential-chain/profile mechanism without a Mantle API requirement.
- Rejected because: Mantle consumes bearer tokens, not raw access keys.

### Trust arbitrary Models.dev route strings

- Pros: accepts new route labels without application changes.
- Cons: unknown metadata could select an unintended transport or endpoint.
- Rejected because: only recognized, normalized route metadata may control
  transport selection; unknown values fail safely.

## Consequences

- Bedrock setup uses a bearer token or AWS profile/default chain; users must
  migrate away from stored access-key/secret-key fields.
- Native Converse and its model-specific behavior are unavailable in the built-in
  provider. This is an explicit approved hard conversion, not the normal
  feature-deprecation period.
- Models.dev route metadata becomes part of the safe Bedrock routing contract;
  missing or unrecognized metadata cannot silently select a native fallback.
- The Mantle OpenAI request path must retain `store: false`, and direct smoke
  checks cover Chat Completions, Responses, and model listing at `/openai/v1`.
