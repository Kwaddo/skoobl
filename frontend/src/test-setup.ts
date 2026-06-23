// jsdom has no 2D canvas context — stub a no-op implementation globally so every
// test file that renders a <canvas> runs without "Not implemented: getContext" noise.
// jsdom defines getContext but throws "Not implemented"; we override it here.
// Guard: only install if the stub is not already in place (avoids double-install).
const _existingGetContext = HTMLCanvasElement.prototype.getContext;
const _isAlreadyStubbed =
  typeof _existingGetContext === "function" &&
  _existingGetContext.toString().includes("fakeCtx");
if (!_isAlreadyStubbed) {
  const fakeCtx = {
    fillStyle: "" as string | CanvasGradient | CanvasPattern,
    strokeStyle: "" as string | CanvasGradient | CanvasPattern,
    lineWidth: 0,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    fillRect: () => {},
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    stroke: () => {},
    drawImage: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    putImageData: () => {},
  };
  // @ts-expect-error test stub
  HTMLCanvasElement.prototype.getContext = () => fakeCtx;
}

// jsdom does not implement PointerEvent, so synthetic pointer events fired via
// fireEvent do not carry `isPrimary`. Polyfill it so pointer handlers that guard
// with `!e.isPrimary` work correctly in tests — matching production behaviour
// where `isPrimary` is always a boolean.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEvent extends MouseEvent {
    readonly isPrimary: boolean;
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.isPrimary = init.isPrimary ?? false;
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error polyfill for jsdom
  globalThis.PointerEvent = PointerEvent;
}

// Node 26 adds an experimental `localStorage` / `sessionStorage` to globalThis
// (always undefined unless --localstorage-file is passed).  Because these keys
// already exist in globalThis, vitest's populateGlobal skips overriding them
// with jsdom's working implementations.  We fix that here by explicitly reading
// from the underlying jsdom window object (exposed as globalThis.jsdom.window
// by vitest's jsdom environment setup).
// jsdom doesn't implement ResizeObserver — stub a no-op so components that use it
// don't crash in tests (they just won't get resize callbacks, which is fine).
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom doesn't implement matchMedia — stub a no-op "never matches" media query
// so components that adapt to viewport (e.g. the drawing toolbar's short/wide
// breakpoint) render their default layout in tests instead of crashing.
if (typeof globalThis.matchMedia !== "function") {
  globalThis.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

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
