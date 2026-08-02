const REPLACEMENT_CHARACTER = 0xfffd;

interface UnicodeScalar {
  readonly value: number;
  readonly codeUnits: 1 | 2;
}

function unicodeScalarAt(input: string, index: number): UnicodeScalar {
  const first = input.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < input.length) {
    const second = input.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return {
        value: 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
        codeUnits: 2,
      };
    }
  }
  if (first >= 0xd800 && first <= 0xdfff) {
    return { value: REPLACEMENT_CHARACTER, codeUnits: 1 };
  }
  return { value: first, codeUnits: 1 };
}

function scalarByteLength(value: number): 1 | 2 | 3 | 4 {
  if (value <= 0x7f) return 1;
  if (value <= 0x7ff) return 2;
  if (value <= 0xffff) return 3;
  return 4;
}

/** UTF-8 primitives for runtimes such as InDesign UXP that omit TextEncoder. */
export function utf8ByteLength(input: string): number {
  let bytes = 0;
  for (let index = 0; index < input.length;) {
    const scalar = unicodeScalarAt(input, index);
    bytes += scalarByteLength(scalar.value);
    index += scalar.codeUnits;
  }
  return bytes;
}

export function encodeUtf8(input: string): Uint8Array {
  const output = new Uint8Array(utf8ByteLength(input));
  let offset = 0;
  for (let index = 0; index < input.length;) {
    const scalar = unicodeScalarAt(input, index);
    const value = scalar.value;
    if (value <= 0x7f) {
      output[offset] = value;
      offset += 1;
    } else if (value <= 0x7ff) {
      output[offset] = 0xc0 | (value >> 6);
      output[offset + 1] = 0x80 | (value & 0x3f);
      offset += 2;
    } else if (value <= 0xffff) {
      output[offset] = 0xe0 | (value >> 12);
      output[offset + 1] = 0x80 | ((value >> 6) & 0x3f);
      output[offset + 2] = 0x80 | (value & 0x3f);
      offset += 3;
    } else {
      output[offset] = 0xf0 | (value >> 18);
      output[offset + 1] = 0x80 | ((value >> 12) & 0x3f);
      output[offset + 2] = 0x80 | ((value >> 6) & 0x3f);
      output[offset + 3] = 0x80 | (value & 0x3f);
      offset += 4;
    }
    index += scalar.codeUnits;
  }
  return output;
}

export function decodeUtf8(input: Uint8Array): string {
  let output = "";
  for (let index = 0; index < input.byteLength;) {
    const first = input[index];
    if (first === undefined) throw new TypeError("The UTF-8 byte sequence is truncated.");
    if (first <= 0x7f) {
      output += String.fromCodePoint(first);
      index += 1;
      continue;
    }

    let length: 2 | 3 | 4;
    let value: number;
    let minimum: number;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      value = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      value = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      value = first & 0x07;
      minimum = 0x10000;
    } else {
      throw new TypeError("The stored value is not valid UTF-8.");
    }

    if (index + length > input.byteLength) {
      throw new TypeError("The UTF-8 byte sequence is truncated.");
    }
    for (let continuationIndex = 1; continuationIndex < length; continuationIndex += 1) {
      const continuation = input[index + continuationIndex];
      if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
        throw new TypeError("The stored value is not valid UTF-8.");
      }
      value = (value << 6) | (continuation & 0x3f);
    }
    if (
      value < minimum
      || value > 0x10ffff
      || (value >= 0xd800 && value <= 0xdfff)
    ) {
      throw new TypeError("The stored value is not valid UTF-8.");
    }
    output += String.fromCodePoint(value);
    index += length;
  }
  return output;
}
