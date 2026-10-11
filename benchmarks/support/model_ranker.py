"""Measure a local embedding ranker; scores are hints, never correctness claims."""

import hashlib
import json
import math
from pathlib import Path
import sys

QUERY = (
    "Review code changes affecting security, correctness, external side effects, "
    "shared state, concurrency, error handling, or dependency compatibility."
)
MAX_REQUEST_BYTES = 1048576


def model_config():
    """Return the operator-pinned model description."""
    return json.loads(Path(__file__).with_name("ranker-model.json").read_text())


def verify_files(directory, config):
    """Check model files before loading native inference code.

    Args:
        directory: Directory containing downloaded model artifacts.
        config: Pinned artifact sizes and SHA-256 checksums.

    Raises:
        ValueError: An artifact is absent, changed, or a symbolic link.
    """
    for artifact in config["files"]:
        path = Path(directory) / artifact["path"]
        if path.is_symlink() or not path.is_file():
            raise ValueError("Model artifact unavailable")
        data = path.read_bytes()
        if (
            len(data) != artifact["bytes"]
            or hashlib.sha256(data).hexdigest() != artifact["sha256"]
        ):
            raise ValueError("Model artifact mismatch")


def describe_candidates(request):
    """Describe selected source changes without receiving benchmark risk labels.

    Args:
        request: CandidateSpecs and an observed baseline/source summary.

    Returns:
        Candidate IDs and source descriptions in input order.

    Raises:
        ValueError: A source is missing or an input exceeds the model budget.
    """
    if request.get("schema_version") != 1:
        raise ValueError("Unsupported request")
    specs = request["candidate_specs"]
    summary = request["evidence_summary"]
    if (
        summary.get("schema_version") != 1
        or summary.get("basis") != "OBSERVED"
        or not 1 <= len(specs) <= 64
        or "high_risk_spec_ids" in summary
    ):
        raise ValueError("Invalid model summary")
    baseline = {
        file["path"]: file["contents"] for file in summary["baseline"]["files"]
    }
    sources = {
        source["future_revision_id"]: source for source in summary["sources"]
    }
    ids, descriptions = [], []
    for spec in specs:
        changes = []
        for revision in spec["selected_future_revisions"]:
            source = sources.get(revision)
            if source is None or source.get("complete") is not True:
                raise ValueError("Incomplete model source")
            files = {file["path"]: file["contents"] for file in source["files"]}
            for path in sorted(baseline.keys() | files.keys()):
                before, after = baseline.get(path), files.get(path)
                if before != after:
                    changes.append(
                        f"{path}\nBefore:\n{before}\nAfter:\n{after}"
                    )
        ids.append(spec["id"])
        descriptions.append("\n".join(changes) or "No source changes")
    if len(set(ids)) != len(ids):
        raise ValueError("Duplicate CandidateSpec")
    return ids, descriptions


def rank(request, directory):
    """Rank source descriptions by learned relevance to a general review query.

    Args:
        request: Bounded CandidateSpec and observed-source input.
        directory: Directory containing verified ONNX and tokenizer artifacts.

    Returns:
        A complete CandidateSpec priority permutation. It authorizes no action.
    """
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    config = model_config()
    verify_files(directory, config)
    ids, descriptions = describe_candidates(request)
    tokenizer = Tokenizer.from_file(str(Path(directory) / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=config["max_tokens"])
    tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
    # Explicit CPU limits avoid competing with the exact-state evaluator.
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    session = ort.InferenceSession(
        str(Path(directory) / "model.onnx"),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    tokens = tokenizer.encode_batch([QUERY, *descriptions])
    inputs = {
        "input_ids": np.array([token.ids for token in tokens], dtype=np.int64),
        "attention_mask": np.array(
            [token.attention_mask for token in tokens], dtype=np.int64
        ),
        "token_type_ids": np.array(
            [token.type_ids for token in tokens], dtype=np.int64
        ),
    }
    hidden = session.run(
        None, {item.name: inputs[item.name] for item in session.get_inputs()}
    )[0]
    mask = inputs["attention_mask"][..., None]
    pooled = (hidden * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)
    pooled /= np.linalg.norm(pooled, axis=1, keepdims=True).clip(min=1e-12)
    scores = pooled[1:] @ pooled[0]
    if len(scores) != len(ids) or any(
        not math.isfinite(float(score)) for score in scores
    ):
        raise ValueError("Invalid model scores")
    priorities = sorted(
        range(len(ids)), key=lambda index: (-float(scores[index]), ids[index])
    )
    return {
        "schema_version": 1,
        "priorities": [ids[index] for index in priorities],
    }


def main():
    """Read one bounded request and emit only the Ranker contract."""
    try:
        data = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(data) > MAX_REQUEST_BYTES:
            raise ValueError("Request exceeds model budget")
        result = rank(json.loads(data), sys.argv[1])
        sys.stdout.write(json.dumps(result) + "\n")
    except Exception:
        # Diagnostics can contain source or private paths; expose neither.
        sys.stderr.write("Local ranking unavailable\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
