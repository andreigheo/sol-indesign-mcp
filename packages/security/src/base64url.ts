const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map(
  Array.from(ALPHABET, (character, index) => [character, index] as const),
);

export class Base64UrlError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "Base64UrlError";
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += ALPHABET[(first >>> 2) & 63] ?? "";
    output += ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)] ?? "";
    if (second !== undefined) {
      output +=
        ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)] ?? "";
    }
    if (third !== undefined) {
      output += ALPHABET[third & 63] ?? "";
    }
  }
  return output;
}

export function decodeBase64Url(
  input: string,
  expectedBytes?: number,
): Uint8Array {
  if (input.includes("=") || !/^[A-Za-z0-9_-]*$/u.test(input)) {
    throw new Base64UrlError("Value is not unpadded base64url.");
  }
  if (input.length % 4 === 1) {
    throw new Base64UrlError("Invalid base64url length.");
  }
  const outputLength = Math.floor((input.length * 6) / 8);
  const output = new Uint8Array(outputLength);
  let accumulator = 0;
  let bits = 0;
  let outputIndex = 0;
  for (const character of input) {
    const value = LOOKUP.get(character);
    if (value === undefined) {
      throw new Base64UrlError("Value contains an invalid base64url character.");
    }
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputIndex++] = (accumulator >>> bits) & 255;
    }
  }
  if (bits > 0 && (accumulator & ((1 << bits) - 1)) !== 0) {
    throw new Base64UrlError("Value is not in canonical base64url form.");
  }
  if (encodeBase64Url(output) !== input) {
    throw new Base64UrlError("Value is not in canonical base64url form.");
  }
  if (expectedBytes !== undefined && output.byteLength !== expectedBytes) {
    throw new Base64UrlError(
      `Expected ${expectedBytes} decoded bytes, received ${output.byteLength}.`,
    );
  }
  return output;
}
