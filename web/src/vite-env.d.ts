/// <reference types="vite/client" />

// An agent icon's SVG as inline markup (vite.agentIcons.ts).
declare module "*.svg?agent-icon" {
  const markup: string;
  export default markup;
}

// restty's WASM core, shipped as its own asset (vite.restty.ts).
declare module "virtual:restty-wasm" {
  const url: string;
  export default url;
}

// The WOFF2 decoder's Brotli dictionary, a lazy chunk (vite.brotli.ts).
declare module "virtual:thyra-brotli-dictionary" {
  const bytes: Uint8Array;
  export default bytes;
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
