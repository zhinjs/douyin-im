/**
 * The installed bundle encloses every VM in "use strict".
 * Reflect preserves explicit receiver/evaluation ordering; a refused write must throw.
 */
export function setDesktopProperty(target: unknown, key: PropertyKey, value: unknown, receiver: unknown = target): void {
  if (target == null || !Reflect.set(Object(target), key, value, receiver)) {
    throw new TypeError('Desktop property write rejected: ' + String(key));
  }
}

export function deleteDesktopProperty(target: object, key: PropertyKey): void {
  if (!Reflect.deleteProperty(target, key)) throw new TypeError('Desktop property delete rejected: ' + String(key));
}
