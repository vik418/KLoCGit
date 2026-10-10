# ADR 0005: Deterministic CBOR and normalized effects

Status: Accepted for T011 and D006.

Use pinned JavaScript `cbor2` 2.4.0 for production encoding and Python `cbor2` 6.1.5 as an independent test reference. Both are maintained, MIT-licensed libraries. JavaScript supports the selected Node 24 runtime and uses a web-compatible encoder. Python remains test-only; this does not decide D002 or the Python extractor.

The wire profile follows RFC 8949 §4.2.1: definite lengths, preferred integer/float widths and lexicographic encoded map-key order. JavaScript uses `cde: true`. Python uses `canonical=True`; its length-first map order agrees for our string-only keys. T010's validated JSON subset excludes tags, arbitrary encoder hooks, undefined, non-finite numbers, negative zero, unsafe integers and malformed Unicode. Strings retain their exact Unicode form. T001 supplies the versioned hash-domain frame.

## Effects

Each effect requires `schema_version`, `kind`, `target`, `operation`, `attributes` and `references`. Kind and operation are lowercase hyphen-separated ASCII tokens, at most 64 characters. Targets and references are nonblank identity strings preserved without case, slash, whitespace or Unicode rewriting. Attributes are material JSON maps; nested arrays retain order. Unknown fields are rejected.

An optional `annotations` map permits only `observed_at`, `trace_id`, `runtime_metrics` and `transient_locations`. These describe execution, never behavior. Metadata-looking names inside attributes remain material. Material projection excludes this explicit container and the root self digest. It retains revision, extractor identity/version, capability/status and both effect sets. The full effect-set digest retains annotations.

## Ordering

| Collection                                                                             | Rule                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Effects and security effects                                                           | Set; sort by complete material effect CBOR bytes |
| Effect references                                                                      | Set; sort by canonical CBOR bytes                |
| Selected Future revisions, required dependencies                                       | Set; sort by canonical CBOR bytes                |
| Basis candidate/evidence digests, accepted Decisions                                   | Set; sort by canonical CBOR bytes                |
| Git parents, selections, materialization steps, release lists, nested attribute arrays | Preserve order                                   |

Duplicate set entries are rejected. Annotation differences cannot manufacture distinct copies of one effect. `encodeDomain` validates records and encodes persistence, including existing IDs/digests. It does not build or authenticate Candidate/Future identities. Hash callers supply explicit projections; later owning tasks define their identity inputs.

## Evidence

Thirteen literal vectors cover integer and float widths, subnormal floats, UTF-8 identity, map ordering, opaque keys, ordered arrays and normalized records. Node and the independent Python encoder agree on every byte and framed SHA-256 digest. JavaScript tests cover metadata exclusion, material changes, set ordering and rejected producer hooks. CI checks both implementations against the same literals.

Local reference check: install `tests/v1/requirements.txt` in a Python 3.12 virtual environment, then run `python tests/v1/encoding_reference.py`. It does not invoke Node or regenerate expectations.

An equal material digest means identical normalized declared effects, not behavioral equivalence, compatibility, trusted Evidence or permission to promote. No architecture assumption changed.
