"""Verify v1 CBOR golden bytes and digests with an independent Python encoder."""

import hashlib
import json
import math
from pathlib import Path
import re
import unittest

import cbor2


VECTORS_PATH = Path(__file__).with_name("encoding.golden.json")
MAX_SAFE_INTEGER = (1 << 53) - 1


def normalize_json(value):
    """Match the JSON subset accepted by the JavaScript domain encoder.

    Args:
        value: A JSON scalar, array, or string-keyed object from a golden vector.

    Returns:
        The value with integer-valued floats represented as integers. JavaScript
        has one number type, so these values must use the same CBOR representation.

    Raises:
        ValueError: If the value cannot be represented by the v1 JSON subset.
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        value.encode("utf-8", errors="strict")
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ValueError("Unsafe integer in golden vector")
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or (
            value == 0 and math.copysign(1, value) < 0
        ):
            raise ValueError("Unsupported number in golden vector")
        if value.is_integer():
            return normalize_json(int(value))
        return value
    if isinstance(value, list):
        return [normalize_json(item) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError("Non-string object key in golden vector")
            result[normalize_json(key)] = normalize_json(item)
        return result
    raise ValueError("Unsupported value in golden vector")


def digest_bytes(domain, encoded):
    """Apply the versioned, domain-separated frame from conventions.mjs.

    Args:
        domain: The validated digest domain supplied by the golden vector.
        encoded: The exact deterministic CBOR bytes.

    Returns:
        The algorithm-tagged, domain-separated v1 SHA-256 digest.

    Raises:
        ValueError: If the domain does not satisfy the v1 naming convention.
    """
    if (
        not isinstance(domain, str)
        or len(domain) > 64
        or re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", domain) is None
    ):
        raise ValueError("Invalid digest domain in golden vector")
    frame = ("klocgit:v1:" + domain + "\0").encode("utf-8")
    digest = hashlib.sha256(frame + encoded).hexdigest()
    return "sha256:" + domain + ":v1:" + digest


def parse_integer(encoded):
    """Preserve the JavaScript rejection of the JSON integer token -0.

    Args:
        encoded: An integer token supplied by the JSON decoder.

    Returns:
        The parsed integer.

    Raises:
        ValueError: If the token is negative zero.
    """
    if encoded == "-0":
        raise ValueError("Negative zero in golden vector")
    return int(encoded)


class GoldenEncodingTest(unittest.TestCase):
    """Compare literal fixtures without invoking the production Node encoder."""

    def test_golden_vectors(self):
        """Both encoders must match the same reviewed bytes and digests."""
        corpus = json.loads(
            VECTORS_PATH.read_text(encoding="utf-8"), parse_int=parse_integer
        )
        self.assertIs(type(corpus["schema_version"]), int)
        self.assertEqual(corpus["schema_version"], 1)
        self.assertGreater(len(corpus["vectors"]), 0)
        for vector in corpus["vectors"]:
            with self.subTest(name=vector["name"]):
                value = normalize_json(vector["value"])
                # With string-only map keys, length-first and core deterministic
                # CBOR ordering agree. Nested arrays keep their declared order.
                encoded = cbor2.dumps(value, canonical=True)
                self.assertEqual(encoded.hex(), vector["cbor_hex"])
                self.assertEqual(
                    digest_bytes(vector["domain"], encoded), vector["digest"]
                )


if __name__ == "__main__":
    unittest.main()
