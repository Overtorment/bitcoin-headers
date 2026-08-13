export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd hex length: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = nibble(hex.charCodeAt(i * 2));
    const lo = nibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) throw new Error("invalid hex string");
    out[i] = (hi << 4) | lo;
  }
  return out;
}

const HEX_NIBBLE = new Int8Array(128).fill(-1);
for (let i = 0; i < 10; i++) HEX_NIBBLE[48 + i] = i;
for (let i = 0; i < 6; i++) {
  HEX_NIBBLE[65 + i] = 10 + i;
  HEX_NIBBLE[97 + i] = 10 + i;
}

function nibble(code: number): number {
  return code < 128 ? HEX_NIBBLE[code]! : -1;
}

const HEX_BYTE = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

export function bytesToHex(bytes: Uint8Array): string {
  const hex = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) hex[i] = HEX_BYTE[bytes[i]!]!;
  return hex.join("");
}

export function bytesFromHex(
  value: string,
  byteLength: number,
  label: string,
): Uint8Array {
  if (value.length !== byteLength * 2 || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`${label} must be ${byteLength} bytes of lowercase hex`);
  }
  return hexToBytes(value);
}
