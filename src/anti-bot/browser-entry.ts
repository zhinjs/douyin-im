import { installDesktopBdms, type DesktopBdmsRuntimeContext } from './desktop-runtime.js';

// Entry for the built classic-script asset, not an import-side effect of the SDK.
// Forward live browser bindings; do not copy a fingerprint or simulate missing APIs.
const context = new Proxy(globalThis, {
  get(target, key) {
    if (key === 'webpackGlobal') return globalThis;
    return Reflect.get(target, key, target);
  },
});

installDesktopBdms(context as unknown as DesktopBdmsRuntimeContext);
