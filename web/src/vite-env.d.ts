/// <reference types="vite/client" />

// Monaco ESM sources resolved through the `monaco-esm` Vite alias; only the
// editor API has published types.
declare module "monaco-esm/editor/editor.api.js" {
  export * from "monaco-editor";
}
declare module "monaco-esm/languages/definitions/*" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
declare module "monaco-esm/features/*";

// restty's WASM core, shipped as its own asset (vite.restty.ts).
declare module "virtual:restty-wasm" {
  const url: string;
  export default url;
}

declare module "virtual:file-icons" {
  /** URL prefix of the icon SVGs (see vite.fileIcons.ts). */
  export const base: string;
  /** Keys grouped by icon, space separated; names may use `stem.{a,b}`. */
  export const table: {
    extensions: Record<string, string>;
    names: Record<string, string>;
    /** Folder icons without their `folder-` prefix. */
    folders: Record<string, string>;
    light: string;
  };
}
