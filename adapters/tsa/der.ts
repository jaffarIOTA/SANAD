/**
 * The DER this adapter needs, and no more: read a tag-length-value tree keeping
 * each element's exact bytes (signatures are over the bytes as received, never
 * a re-encoding), and write the few types a timestamp request is made of.
 *
 * Definite lengths only, as DER requires; anything else is refused rather than
 * guessed at. No dependency: a parser on the signature path is code we can read.
 */

export interface Der {
  /** The identifier octet: class, constructed bit and tag number (low tags only). */
  readonly tag: number;
  /** The whole element, header included: what a signature or hash covers. */
  readonly bytes: Uint8Array;
  /** The contents octets. */
  readonly value: Uint8Array;
  /** The child elements, for a constructed element. */
  readonly children: readonly Der[];
}

export class DerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DerError';
  }
}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
} as const;

/** A context-specific tag: `[n]`, constructed unless `primitive`. */
export const context = (n: number, primitive = false): number => (primitive ? 0x80 : 0xa0) | n;

function readOne(buf: Uint8Array, at: number): { node: Der; next: number } {
  if (at + 2 > buf.length) throw new DerError('truncated element');
  const tag = buf[at] as number;
  if ((tag & 0x1f) === 0x1f) throw new DerError('high tag numbers are not used here');
  let length = buf[at + 1] as number;
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new DerError('indefinite or oversized length');
    if (at + 2 + count > buf.length) throw new DerError('truncated length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (buf[at + 2 + i] as number);
    header += count;
  }
  const end = at + header + length;
  if (end > buf.length) throw new DerError('element runs past its container');
  const value = buf.subarray(at + header, end);
  const children: Der[] = [];
  if (tag & 0x20) {
    let p = 0;
    while (p < value.length) {
      const child = readOne(value, p);
      children.push(child.node);
      p = child.next;
    }
  }
  return { node: { tag, bytes: buf.subarray(at, end), value, children }, next: end };
}

/** Parse exactly one element filling `buf`; trailing bytes are refused. */
export function parse(buf: Uint8Array): Der {
  const { node, next } = readOne(buf, 0);
  if (next !== buf.length) throw new DerError('trailing bytes after the element');
  return node;
}

/** The `i`th child, which must carry `tag`. */
export function child(node: Der, i: number, tag?: number): Der {
  const c = node.children[i];
  if (c === undefined) throw new DerError(`missing element ${String(i)}`);
  if (tag !== undefined && c.tag !== tag)
    throw new DerError(`element ${String(i)}: tag 0x${c.tag.toString(16)}, expected 0x${tag.toString(16)}`);
  return c;
}

/** The first child carrying `tag`, if any. */
export const find = (node: Der, tag: number): Der | undefined => node.children.find((c) => c.tag === tag);

export function oid(node: Der): string {
  if (node.tag !== TAG.OID || node.value.length === 0) throw new DerError('not an object identifier');
  const v = node.value;
  const parts: bigint[] = [];
  let acc = 0n;
  for (const byte of v) {
    acc = (acc << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(acc);
      acc = 0n;
    }
  }
  const first = parts[0] as bigint;
  const head = first < 40n ? [0n, first] : first < 80n ? [1n, first - 40n] : [2n, first - 80n];
  return [...head, ...parts.slice(1)].join('.');
}

/** An INTEGER as a signed bigint. */
export function integer(node: Der): bigint {
  if (node.tag !== TAG.INTEGER || node.value.length === 0) throw new DerError('not an integer');
  let n = 0n;
  for (const byte of node.value) n = (n << 8n) | BigInt(byte);
  if ((node.value[0] as number) & 0x80) n -= 1n << BigInt(node.value.length * 8);
  return n;
}

/** A GeneralizedTime (`YYYYMMDDHHMMSS[.f*]Z`, as RFC 3161 requires) as whole epoch seconds. */
export function generalizedTime(node: Der): bigint {
  if (node.tag !== TAG.GENERALIZED_TIME) throw new DerError('not a GeneralizedTime');
  const text = new TextDecoder().decode(node.value);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(text);
  if (m === null) throw new DerError('GeneralizedTime is not in UTC to the second');
  const [, y, mo, d, h, mi, s] = m.map(Number) as [number, number, number, number, number, number, number];
  return BigInt(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---- writing -----------------------------------------------------------------

function lengthOctets(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return [0x80 | out.length, ...out];
}

export function encode(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...lengthOctets(value.length), ...value]);
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((p) => [...p]));

export const sequence = (...parts: Uint8Array[]): Uint8Array => encode(TAG.SEQUENCE, concat(parts));
export const set = (...parts: Uint8Array[]): Uint8Array => encode(TAG.SET, concat(parts));
export const explicit = (n: number, ...parts: Uint8Array[]): Uint8Array => encode(context(n), concat(parts));
export const octetString = (v: Uint8Array): Uint8Array => encode(TAG.OCTET_STRING, v);
export const nullValue = (): Uint8Array => encode(TAG.NULL, new Uint8Array(0));
export const boolean = (v: boolean): Uint8Array => encode(TAG.BOOLEAN, Uint8Array.of(v ? 0xff : 0x00));

/** A non-negative INTEGER, minimally encoded. */
export function writeInteger(n: bigint): Uint8Array {
  if (n < 0n) throw new DerError('only non-negative integers are written');
  const bytes: number[] = [];
  for (let v = n; v > 0n; v >>= 8n) bytes.unshift(Number(v & 0xffn));
  if (bytes.length === 0 || (bytes[0] as number) & 0x80) bytes.unshift(0);
  return encode(TAG.INTEGER, Uint8Array.from(bytes));
}

export function writeOid(dotted: string): Uint8Array {
  const parts = dotted.split('.').map((p) => BigInt(p));
  const [a, b, ...rest] = parts as [bigint, bigint, ...bigint[]];
  const out: number[] = [];
  for (const arc of [a * 40n + b, ...rest]) {
    const group: number[] = [Number(arc & 0x7fn)];
    for (let v = arc >> 7n; v > 0n; v >>= 7n) group.unshift(Number(v & 0x7fn) | 0x80);
    out.push(...group);
  }
  return encode(TAG.OID, Uint8Array.from(out));
}
