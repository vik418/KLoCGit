# Exact-state Evidence reuse

Status: accepted.

An Evidence subject binds every repository's exact tree and commit. Commit identity is included because checks can inspect Git history. Candidate provenance remains separate: different coordination records can share Evidence only when their evaluated Git state is identical.

Reuse requires matching type, configuration, environment, evaluator identity/version, authenticated attribution and current policy. Producer identity fields and passing results do not establish trust. Policies decide what an observation satisfies; eligibility never asserts global correctness or authorizes canonical mutation.

Evidence IDs hash the complete immutable observation. Provider responses are bounded and independently verified. Missing, substituted or ineligible records cannot satisfy a required check. Provider/provenance/policy outages fail explicitly.

Nine tests cover identity, state mismatch, evaluator/configuration/environment changes, forged records, current-policy rejection, immutable requests and provider failures. Live CI attribution and payload retention are verified by their adapters and release gates.
