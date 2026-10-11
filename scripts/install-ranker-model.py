"""Download the pinned public ranker artifacts; inference itself stays offline."""

import hashlib
import json
from pathlib import Path
import sys
import urllib.request


def install(directory):
    """Install verified model files without executing downloaded Python code.

    Args:
        directory: Destination for the pinned ONNX model and tokenizer.

    Raises:
        ValueError: A download differs from its recorded size or digest.
    """
    manifest = json.loads(
        (
            Path(__file__).resolve().parent.parent
            / "benchmarks/support/ranker-model.json"
        ).read_text()
    )
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for artifact in manifest["files"]:
        target = directory / artifact["path"]
        if target.is_symlink():
            raise ValueError("Model target is a symbolic link")
        url = (
            f"https://huggingface.co/{manifest['repository']}/resolve/"
            f"{manifest['revision']}/{artifact['source']}"
        )
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(artifact["bytes"] + 1)
        if (
            len(data) != artifact["bytes"]
            or hashlib.sha256(data).hexdigest() != artifact["sha256"]
        ):
            raise ValueError("Model download mismatch")
        target.write_bytes(data)


if __name__ == "__main__":
    install(sys.argv[1])
