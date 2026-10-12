/**
 * RFC 8949 Deterministic CBOR Serialization & Canonical Projections
 */

export function encodeCBOR(val: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];

  function write(chunk: Uint8Array) {
    chunks.push(chunk);
  }

  function writeTypeAndNum(majorType: number, num: number | bigint) {
    const major = majorType << 5;
    if (typeof num === 'number') {
      if (num < 24) {
        write(new Uint8Array([major | num]));
      } else if (num <= 0xff) {
        write(new Uint8Array([major | 24, num]));
      } else if (num <= 0xffff) {
        write(new Uint8Array([major | 25, (num >> 8) & 0xff, num & 0xff]));
      } else if (num <= 0xffffffff) {
        write(
          new Uint8Array([
            major | 26,
            (num >>> 24) & 0xff,
            (num >>> 16) & 0xff,
            (num >>> 8) & 0xff,
            num & 0xff,
          ])
        );
      } else {
        const big = BigInt(num);
        const buf = new Uint8Array(9);
        buf[0] = major | 27;
        for (let i = 0; i < 8; i++) {
          buf[8 - i] = Number((big >> BigInt(i * 8)) & 0xffn);
        }
        write(buf);
      }
    } else {
      const buf = new Uint8Array(9);
      buf[0] = major | 27;
      for (let i = 0; i < 8; i++) {
        buf[8 - i] = Number((num >> BigInt(i * 8)) & 0xffn);
      }
      write(buf);
    }
  }

  function serialize(item: unknown): void {
    if (item === null || item === undefined) {
      write(new Uint8Array([0xf6])); // null
      return;
    }
    if (typeof item === 'boolean') {
      write(new Uint8Array([item ? 0xf5 : 0xf4]));
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isInteger(item)) {
        throw new Error(`Float values not supported in canonical projection: ${item}`);
      }
      if (item >= 0) {
        writeTypeAndNum(0, item);
      } else {
        writeTypeAndNum(1, -1 - item);
      }
      return;
    }
    if (typeof item === 'bigint') {
      if (item >= 0n) {
        writeTypeAndNum(0, item);
      } else {
        writeTypeAndNum(1, -1n - item);
      }
      return;
    }
    if (typeof item === 'string') {
      // Strict UTF-8 normalization (NFC)
      const normalized = item.normalize('NFC');
      const utf8 = new TextEncoder().encode(normalized);
      writeTypeAndNum(3, utf8.length);
      write(utf8);
      return;
    }
    if (item instanceof Uint8Array) {
      writeTypeAndNum(2, item.length);
      write(item);
      return;
    }
    if (Array.isArray(item)) {
      writeTypeAndNum(4, item.length);
      for (const el of item) {
        serialize(el);
      }
      return;
    }
    if (typeof item === 'object') {
      // Sorted keys lexicographically by UTF-8 bytes (RFC 8949 deterministic encoding)
      const obj = item as Record<string, unknown>;
      const keys = Object.keys(obj).sort((a, b) => {
        const aBytes = new TextEncoder().encode(a);
        const bBytes = new TextEncoder().encode(b);
        const minLen = Math.min(aBytes.length, bBytes.length);
        for (let i = 0; i < minLen; i++) {
          if (aBytes[i] !== bBytes[i]) {
            return aBytes[i] - bBytes[i];
          }
        }
        return aBytes.length - bBytes.length;
      });

      writeTypeAndNum(5, keys.length);
      for (const k of keys) {
        serialize(k);
        serialize(obj[k]);
      }
      return;
    }
    throw new Error(`Unsupported type for CBOR encoding: ${typeof item}`);
  }

  serialize(val);

  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ============================================================================
// CANONICAL PROJECTION HELPERS (Field-Level Canonicalization Rules)
// ============================================================================

export function sortStrings(arr: string[]): string[] {
  return [...arr].sort((a, b) => {
    const aBytes = new TextEncoder().encode(a);
    const bBytes = new TextEncoder().encode(b);
    const minLen = Math.min(aBytes.length, bBytes.length);
    for (let i = 0; i < minLen; i++) {
      if (aBytes[i] !== bBytes[i]) return aBytes[i] - bBytes[i];
    }
    return aBytes.length - bBytes.length;
  });
}

export function sortKeyedRecord<T>(record: Record<string, T>): Record<string, T> {
  const sortedKeys = sortStrings(Object.keys(record));
  const res: Record<string, T> = {};
  for (const k of sortedKeys) {
    res[k] = record[k];
  }
  return res;
}
