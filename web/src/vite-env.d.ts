/// <reference types="vite/client" />

// restty's WASM core, shipped as its own asset (vite.restty.ts).
declare module "virtual:restty-wasm" {
  const url: string;
  export default url;
}

// noVNC ships untyped ES modules; only the RFB client the agent browser uses.
declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { shared?: boolean; wsProtocols?: string[] },
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    focusOnClick: boolean;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    focus(): void;
    disconnect(): void;
  }
}
