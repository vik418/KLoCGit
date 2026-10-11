"""Install the published, checksum-pinned test toolchain outside the checkout.

Usage: python3 adapters/analysis/rust/install-toolchain.py [install-prefix]
The default prefix is /tmp/klocgit-rust-toolchain/1.90.0. curl preserves the
executor's proxy and CA settings; TLS verification is never disabled. This is
trusted tooling setup, not a command run against an analyzed repository.
"""

import concurrent.futures
import hashlib
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile


def main():
    metadata = json.loads(pathlib.Path(__file__).with_name("toolchain.json").read_text())
    prefix = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1 else "/tmp/klocgit-rust-toolchain/1.90.0"
    ).resolve()
    if len(sys.argv) > 2:
        raise ValueError("expected at most one install prefix")
    repository = pathlib.Path(__file__).resolve().parents[3]
    if prefix == repository or repository in prefix.parents:
        raise ValueError("the toolchain must be installed outside the repository")
    with tempfile.TemporaryDirectory(prefix="klocgit-rust-download-") as directory:
        downloads = pathlib.Path(directory)

        def download(component):
            name, checksum = component
            stem = f"{name}-{metadata['version']}-{metadata['target']}"
            archive = downloads / f"{stem}.tar.xz"
            subprocess.run(
                [
                    "curl", "--silent", "--show-error", "--fail", "--location",
                    "--max-time", "300", metadata["source"] + archive.name,
                    "--output", str(archive),
                ],
                check=True,
            )
            actual = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
            if actual != checksum:
                raise ValueError(f"checksum mismatch: {name}")
            with tarfile.open(archive) as package:
                package.extractall(downloads, filter="data")
            return downloads / stem / "install.sh"

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            installers = list(executor.map(download, metadata["archive_sha256"].items()))
        for installer in installers:
            subprocess.run(
                ["sh", str(installer), f"--prefix={prefix}", "--disable-ldconfig"],
                check=True,
            )
    version = subprocess.run(
        [str(prefix / "bin/rustc"), "--version"],
        check=True, capture_output=True, text=True, env={},
    ).stdout.strip()
    if version != metadata["compiler_identity"]:
        raise ValueError("installed compiler identity mismatch")
    print(f"Verified {metadata['compiler_identity']} at {prefix}")


if __name__ == "__main__":
    main()
