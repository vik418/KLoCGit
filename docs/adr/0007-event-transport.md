# ADR 0007: Bounded event transport

Status: Accepted for T020. D008 remains open pending workload measurements.

Events use versioned JSON envelopes. `event_id` is the T001 event ID derived from the complete envelope without its self ID using deterministic CBOR. Identity detects substitution; it does not authenticate the sender. Subject versions are nonnegative safe integers. An objective may be null for observations made outside an objective.

Limits are mandatory configuration: complete envelope bytes, inline payload bytes and maximum claim-check bytes. Sizes count UTF-8 bytes after JSON serialization. Creation moves payloads to claim-check storage when either the inline or full envelope bound would be exceeded. Direct serialization rejects oversized inline events. No provider maximum or production default is assumed.

Claim-check references are opaque ObjectStore keys. Reads and writes receive explicit tenant scope. The adapter owns authorization, bounded reads and retention. Consumers verify the envelope identity and the domain-separated digest of exact stored bytes before decoding payloads. No URL in a reference is fetched by the domain.

T021 owns delivery receipts, version gates, retries and DLQ behavior. T100 owns authorization boundary validation. T020 proves the transport contract with local tests; it does not establish live Queue or ObjectStore behavior.
