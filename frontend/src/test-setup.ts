// Node 26 adds an experimental `localStorage` / `sessionStorage` to globalThis
// (always undefined unless --localstorage-file is passed).  Because these keys
// already exist in globalThis, vitest's populateGlobal skips overriding them
// with jsdom's working implementations.  We fix that here by explicitly reading
// from the underlying jsdom window object (exposed as globalThis.jsdom.window
// by vitest's jsdom environment setup).
const g = globalThis as typeof globalThis & { jsdom?: { window?: Window } };
if (g.jsdom?.window) {
  const jsdWindow = g.jsdom.window;
  Object.defineProperty(globalThis, "localStorage", {
    get: () => jsdWindow.localStorage,
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    get: () => jsdWindow.sessionStorage,
    configurable: true,
  });
}
