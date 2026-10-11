/** Linux process isolation. Trusted evaluators stay outside the producer namespace. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  V1Error,
  assertSchemaVersion,
  parseDigest,
  digestBytes,
} from '../../core/v1/conventions.mjs';
import { copyJsonData } from '../../core/v1/domain.mjs';

function valid(condition) {
  if (!condition) throw new V1Error('INVALID_ARGUMENT');
}

function pathName(value) {
  valid(
    typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0'),
  );
  valid(value.split('/').every((part) => part && part !== '.' && part !== '..'));
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function executionScope(input) {
  const value = copyJsonData(input);
  assertSchemaVersion(value);
  valid(Object.keys(value).length === 5);
  for (const key of ['tenant_id', 'system_id', 'trace_id'])
    valid(
      typeof value[key] === 'string' && value[key].trim() && !/[\x00-\x1f\x7f]/.test(value[key]),
    );
  parseDigest(value.candidate_digest, 'object-candidate');
  return freeze(value);
}

function limits(input) {
  const value = copyJsonData(input);
  const fields = [
    'schema_version',
    'timeout_ms',
    'cpu_seconds',
    'address_space_bytes',
    'open_files',
    'max_output_bytes',
    'max_input_bytes',
    'max_workspace_bytes',
    'max_files',
  ];
  assertSchemaVersion(value);
  valid(
    Object.keys(value).length === fields.length && fields.every((key) => Object.hasOwn(value, key)),
  );
  for (const key of fields.slice(1)) valid(Number.isSafeInteger(value[key]) && value[key] > 0);
  return freeze(value);
}

export class LinuxSandbox {
  constructor({ root, runtimes, limits: budget, broker, audit, secretGuard }) {
    valid(typeof root === 'string' && isAbsolute(root));
    valid(
      typeof broker?.read === 'function' &&
        typeof audit === 'function' &&
        typeof secretGuard === 'function',
    );
    const registry = copyJsonData(runtimes);
    valid(registry && !Array.isArray(registry) && Object.keys(registry).length > 0);
    for (const runtime of Object.values(registry)) {
      assertSchemaVersion(runtime);
      valid(Object.keys(runtime).length === 3 && isAbsolute(runtime.binary));
      parseDigest(runtime.digest, 'sandbox-runtime');
    }
    Object.assign(this, {
      root,
      runtimes: freeze(registry),
      budget: limits(budget),
      broker,
      audit,
      secretGuard,
    });
  }

  async #allowed(bytes) {
    if ((await this.secretGuard(bytes.slice())) !== true) throw new V1Error('FORBIDDEN');
  }

  async checkPayload(bytes) {
    valid(bytes instanceof Uint8Array);
    await this.#allowed(bytes);
  }

  async run(input, { workspaces, scope }) {
    const request = copyJsonData(input);
    assertSchemaVersion(request);
    valid(
      Object.keys(request).length === 5 &&
        Array.isArray(request.argv) &&
        Array.isArray(request.files),
    );
    valid(Object.hasOwn(this.runtimes, request.runtime_id));
    valid(request.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')));
    valid(typeof request.stdin === 'string');
    executionScope(scope);
    valid(workspaces instanceof Map);
    const control = this.runtimes[request.runtime_id];
    const runtime = await realpath(control.binary);
    const binary = new Uint8Array(await readFile(runtime));
    if ((await digestBytes('sandbox-runtime', binary)) !== control.digest)
      throw new V1Error('INTEGRITY_MISMATCH');
    const inputBytes = new TextEncoder().encode(request.stdin);
    const argumentBytes = request.argv.map((arg) => new TextEncoder().encode(arg));
    if (
      inputBytes.length + argumentBytes.reduce((sum, bytes) => sum + bytes.length, 0) >
        this.budget.max_input_bytes ||
      request.files.length > this.budget.max_files
    )
      throw new V1Error('INCOMPLETE_ANALYSIS');
    await this.#allowed(inputBytes);
    for (const bytes of argumentBytes) await this.#allowed(bytes);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(this.root, 'evaluation-'));
    const selected = new Set();
    let size = 0;
    try {
      for (const file of request.files) {
        assertSchemaVersion(file);
        valid(Object.keys(file).length === 4);
        pathName(file.path);
        pathName(file.destination);
        valid(!selected.has(file.destination));
        selected.add(file.destination);
        const workspace = workspaces.get(file.repo_id);
        if (!workspace) throw new V1Error('FORBIDDEN');
        const entry = workspace.listFiles().find(({ path }) => path === file.path);
        if (!entry) throw new V1Error('NOT_FOUND');
        if (entry.kind !== 'blob' || !['100644', '100755'].includes(entry.mode))
          throw new V1Error('UNSUPPORTED_CAPABILITY');
        const object = await workspace.readObject(entry.oid, 'blob');
        if (object.status !== 'AVAILABLE') throw new V1Error('INCOMPLETE_ANALYSIS');
        size += object.bytes.length;
        if (size > this.budget.max_workspace_bytes) throw new V1Error('INCOMPLETE_ANALYSIS');
        await this.#allowed(object.bytes);
        const destination = join(directory, file.destination);
        await mkdir(join(destination, '..'), { recursive: true, mode: 0o700 });
        await writeFile(destination, object.bytes, { flag: 'wx', mode: 0o400 });
      }
      const args = [
        '--as=' + this.budget.address_space_bytes,
        '--cpu=' + this.budget.cpu_seconds,
        '--nofile=' + this.budget.open_files,
        '--fsize=' + this.budget.max_output_bytes,
        '--',
        '/usr/bin/bwrap',
        '--info-fd',
        '3',
        '--unshare-user',
        '--unshare-pid',
        '--unshare-net',
        '--unshare-ipc',
        '--unshare-uts',
        '--die-with-parent',
        '--new-session',
        '--cap-drop',
        'ALL',
        '--clearenv',
        '--ro-bind',
        '/lib',
        '/lib',
        '--ro-bind',
        '/lib64',
        '/lib64',
        '--dir',
        '/runtime',
        '--ro-bind',
        runtime,
        '/runtime/program',
        '--ro-bind',
        directory,
        '/candidate',
        '--proc',
        '/proc',
        '--dev',
        '/dev',
        '--tmpfs',
        '/tmp',
        '--chdir',
        '/candidate',
        '--setenv',
        'LANG',
        'C.UTF-8',
        '--setenv',
        'TZ',
        'UTC',
        '--',
        '/runtime/program',
        ...request.argv,
      ];
      // The host observes process exit and bounded I/O. Producer output is data;
      // it cannot write to a trusted evaluator's result channel or memory.
      return await this.#execute(args, inputBytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  #execute(args, stdin) {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/prlimit', args, {
        env: { LANG: 'C.UTF-8', TZ: 'UTC' },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      let outputBytes = 0,
        completed = false;
      const stdout = [],
        stderr = [],
        info = [];
      const stop = () => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      };
      const finish = (error, result) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        stop();
        finish(new V1Error('INCOMPLETE_ANALYSIS'));
      }, this.budget.timeout_ms);
      child.on('error', () => finish(new V1Error('UNSUPPORTED_CAPABILITY')));
      child.stdin.on('error', () => {});
      for (const [stream, chunks] of [
        [child.stdout, stdout],
        [child.stderr, stderr],
        [child.stdio[3], info],
      ])
        stream.on('data', (chunk) => {
          outputBytes += chunk.length;
          if (outputBytes > this.budget.max_output_bytes) {
            stop();
            finish(new V1Error('INCOMPLETE_ANALYSIS'));
          } else chunks.push(chunk);
        });
      child.on('close', (code, signal) => {
        const error = Buffer.concat(stderr);
        // Namespace readiness arrives on bubblewrap's private control channel,
        // never through producer stdout/stderr.
        let ready;
        try {
          ready = JSON.parse(Buffer.concat(info).toString('utf8'));
        } catch {}
        if (!Number.isSafeInteger(ready?.['child-pid']) || ready['child-pid'] <= 0)
          return finish(new V1Error('UNSUPPORTED_CAPABILITY'));
        finish(
          null,
          Object.freeze({
            schema_version: 1,
            exit_code: code,
            signal,
            stdout: new Uint8Array(Buffer.concat(stdout)),
            stderr: new Uint8Array(error),
          }),
        );
      });
      child.stdin.end(stdin);
    });
  }

  async readBrokeredResource(input, scope) {
    const request = freeze(copyJsonData(input)),
      context = executionScope(scope);
    assertSchemaVersion(request);
    valid(
      Object.keys(request).length === 3 &&
        typeof request.resource_id === 'string' &&
        request.resource_id.trim() &&
        !/[\x00-\x1f\x7f]/.test(request.resource_id),
    );
    parseDigest(request.digest, 'broker-resource');
    const auditContext = {
      ...context,
      object_id: request.resource_id,
      event: 'sandbox.resource.requested',
      state: 'REQUESTED',
      failure_class: null,
    };
    await this.audit(freeze(auditContext));
    try {
      const bytes = await this.broker.read(request.resource_id, context);
      valid(bytes instanceof Uint8Array && bytes.length <= this.budget.max_workspace_bytes);
      if ((await digestBytes('broker-resource', bytes)) !== request.digest)
        throw new V1Error('INTEGRITY_MISMATCH');
      await this.#allowed(bytes);
      await this.audit(
        freeze({ ...auditContext, event: 'sandbox.resource.observed', state: 'VERIFIED' }),
      );
      return bytes.slice();
    } catch (error) {
      const code = error instanceof V1Error ? error.code : 'PROVIDER_UNAVAILABLE';
      await this.audit(
        freeze({
          ...auditContext,
          event: 'sandbox.resource.rejected',
          state: 'REJECTED',
          failure_class: code,
        }),
      );
      throw new V1Error(code);
    }
  }
}
