/** Local trusted-fixture harness; this is not a production security sandbox. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
let preparation;

export function prepareRustCompiler() {
  preparation ??= (async () => {
    const toolchain = process.env.KLOCGIT_RUST_TOOLCHAIN ?? '/tmp/klocgit-rust-toolchain/1.90.0';
    const bin = join(toolchain, 'bin');
    const rustc = join(bin, 'rustc');
    const cargo = join(bin, 'cargo');
    const target = await mkdtemp(join(tmpdir(), 'klocgit-rust-helper-'));
    const environment = {
      PATH: `${bin}:/usr/bin:/bin`,
      RUSTC: rustc,
      CARGO_HOME: join(target, 'cargo-home'),
    };
    try {
      const version = await exec(rustc, ['--version'], { env: {}, timeout: 10_000 });
      assert.equal(version.stdout.trim(), 'rustc 1.90.0 (1159e78c4 2025-09-14)');
      await exec(
        cargo,
        [
          'build',
          '--locked',
          '--offline',
          '--manifest-path',
          join(repository, 'adapters/analysis/rust/Cargo.toml'),
          '--target-dir',
          target,
        ],
        { env: environment, timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      return { rustc, helper: join(target, 'debug/klocgit-rust-mir'), target };
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw new Error(
        'Rust semantic tests require the verified pinned 1.90.0 toolchain; set KLOCGIT_RUST_TOOLCHAIN to its install prefix.',
        { cause: error },
      );
    }
  })();
  return preparation;
}

export async function cleanupRustCompiler() {
  if (preparation) {
    const compiler = await preparation;
    await rm(compiler.target, { recursive: true, force: true });
  }
}

export async function fixture(name) {
  return readFile(join(repository, 'tests/fixtures/rust-semantic', name), 'utf8');
}

/** Execute only caller-owned fixtures; production supplies an isolated runner. */
export async function fixtureCompilerRunner(request) {
  assert.equal(request.schema_version, 1);
  assert.equal(request.tool, 'rust-mir-v1');
  assert.equal(request.toolchain_version, '1.90.0');
  assert.equal(request.compiler_identity, 'rustc 1.90.0 (1159e78c4 2025-09-14)');
  assert.deepEqual(request.environment, {});
  assert.deepEqual(request.isolation, {
    network: 'deny',
    credentials: 'none',
    filesystem: 'subject-readonly',
    build_scripts: false,
    proc_macros: false,
  });
  const compiler = await prepareRustCompiler();
  const workspace = await mkdtemp(join(tmpdir(), 'klocgit-rust-subject-'));
  const project = join(workspace, 'subject');
  const output = join(workspace, 'subject.mir');
  try {
    await mkdir(project);
    for (const file of request.project.files) {
      const path = join(project, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.contents);
    }
    const response = await exec(
      compiler.helper,
      [compiler.rustc, project, request.entry_point, request.edition, output],
      { env: {}, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return JSON.parse(response.stdout);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
