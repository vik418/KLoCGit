# ADR 0003: v1 schema and identity conventions

Status: Accepted for T001.

## Decision

All v1 persisted records and events carry an own integer field `schema_version: 1`. Unsupported versions fail explicitly. The conventions live in `core/v1/`; historical v0 IDs and hashing remain unchanged.

Digests use `sha256:<domain>:v1:<64 lowercase hexadecimal characters>`. SHA-256 receives exactly:

```text
UTF8("klocgit:v1:" + domain + NUL) || supplied_encoded_bytes
```

Domain names are lowercase ASCII words separated by single hyphens, at most 64 characters. The separator and version are included in the hashed bytes, not only in the displayed tag. SHA-256 supplies content identity, not authenticity or semantic equivalence.

Object IDs use `klocgit:<kind>:v1:sha256:<hex>`. Kinds follow the domain grammar with a 48-character bound. An ID can be derived only from a digest in the corresponding `object-<kind>` domain. Parsing checks representation and expected namespace; it does not establish that referenced content exists or is authorized.

Hashing accepts already encoded bytes. It does not serialize objects, reorder fields or normalize Unicode. T011 owns deterministic CBOR, schema-specific normalization and ordering. D006 remains open.

Caller idempotency keys contain 1–128 ASCII characters from `A-Z a-z 0-9 . _ ~ -`. This is a v1 protocol choice, not a provider limit. Keys remain case-sensitive and are never trimmed or replaced on retry.

Operation identity binds, in this fixed order:

1. Tenant ID.
2. Resource ID.
3. Action.
4. Caller idempotency key.

The identity frame is a four-byte big-endian field count followed by each field's four-byte big-endian UTF-8 byte length and bytes. Its digest domain is `object-operation`. Scope IDs preserve Unicode and reject unpaired UTF-16 surrogates; silently replacing them could collapse distinct identities. Actions use lowercase ASCII words separated by dots or hyphens, at most 64 characters.

The operation ID identifies a logical attempt, not its request content or authority. T021 must bind the stored operation to its request digest and reject reuse with different input. Authorization remains required at the resource boundary. Unknown outcomes require reconciliation before reissuing an irreversible action.

Public errors use a closed taxonomy with `code`, `failure_class`, `retry_strategy` and a fixed safe message. Retry strategies are `NEVER`, `BACKOFF` and `RECONCILE`. HTTP status mapping belongs in API adapters. Provider messages, stack traces, details and causes are never serialized by this helper.

## Evidence and limits

`tests/v1/conventions.golden.json` contains literal input bytes, framed bytes, digests, IDs and error records. Tests check both Web Crypto and Node's independent SHA-256 implementation against those literals, including binary, multi-block and Unicode-scope inputs.

Adversarial tests cover namespace substitution, unsupported versions, ambiguous scope concatenation, caller byte mutation and private exception fields. These establish the wire convention, not consumer idempotency, canonical authorization or cross-language CBOR conformance.

No frozen architecture assumption was falsified.
