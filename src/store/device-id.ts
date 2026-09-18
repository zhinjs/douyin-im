/** Desktop's Eo(app.getGuid()) fallback; registration replaces this with a server DID. */
export function guidDeviceId(guid: string): string {
  let hash = 0;
  for (let index = 0; index < guid.length; index++) hash = (31 * hash + guid.charCodeAt(index)) >>> 0;
  return String(hash);
}
