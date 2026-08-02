const REPLACEMENT_CHARACTER = 0xfffd;

function scalarAt(input: string, index: number): { readonly value: number; readonly width: 1 | 2 } {
  const first = input.charCodeAt(index);
  if (first >= 0xd800 && first <= 0xdbff && index + 1 < input.length) {
    const second = input.charCodeAt(index + 1);
    if (second >= 0xdc00 && second <= 0xdfff) {
      return {
        value: 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
        width: 2,
      };
    }
  }
  return {
    value: first >= 0xd800 && first <= 0xdfff ? REPLACEMENT_CHARACTER : first,
    width: 1,
  };
}

function encodedLength(input: string): number {
  let length = 0;
  for (let index = 0; index < input.length;) {
    const scalar = scalarAt(input, index);
    length += scalar.value <= 0x7f ? 1 : scalar.value <= 0x7ff ? 2 : scalar.value <= 0xffff ? 3 : 4;
    index += scalar.width;
  }
  return length;
}

export function encodeUtf8(input: string): Uint8Array {
  const output = new Uint8Array(encodedLength(input));
  let offset = 0;
  for (let index = 0; index < input.length;) {
    const scalar = scalarAt(input, index);
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
    index += scalar.width;
  }
  return output;
}
