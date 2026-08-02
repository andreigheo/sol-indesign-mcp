/** Encodes binary MCP image content as standard padded RFC 4648 base64. */
export function encodeStandardBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 16_384;
  for (let offset = 0; offset < bytes.length; offset += block) {
    const slice = bytes.subarray(offset, Math.min(offset + block, bytes.length));
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
