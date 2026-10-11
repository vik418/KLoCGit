/** Content-derived Git identities for controlled benchmark fixtures. */
import { gitObjectOid } from '../../core/v1/workspace.mjs';

const encoder = new TextEncoder();

export async function treeOid(files) {
  const root = new Map();
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/'),
      name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
    }
    node.set(name, content);
  }
  const build = async (node) => {
    const entries = [];
    for (const [name, content] of node) {
      const directory = content instanceof Map;
      const oid = directory
        ? await build(content)
        : await gitObjectOid('blob', encoder.encode(content));
      const header = encoder.encode((directory ? '40000' : '100644') + ' ' + name + '\0');
      const bytes = new Uint8Array(header.length + oid.length / 2);
      bytes.set(header);
      bytes.set(
        Uint8Array.from(oid.match(/../g), (hex) => Number.parseInt(hex, 16)),
        header.length,
      );
      entries.push({ order: name + (directory ? '/' : ''), bytes });
    }
    entries.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const payload = new Uint8Array(entries.reduce((size, entry) => size + entry.bytes.length, 0));
    let offset = 0;
    for (const entry of entries) {
      payload.set(entry.bytes, offset);
      offset += entry.bytes.length;
    }
    return gitObjectOid('tree', payload);
  };
  return build(root);
}

export async function commitOid(tree, parent, message) {
  const body = `tree ${tree}\n${parent ? 'parent ' + parent + '\n' : ''}author Benchmark <benchmark@localhost> 0 +0000\ncommitter Benchmark <benchmark@localhost> 0 +0000\n\n${message}\n`;
  return gitObjectOid('commit', encoder.encode(body));
}
