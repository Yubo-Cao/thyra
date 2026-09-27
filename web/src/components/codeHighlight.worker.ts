// Highlights read-only previews off the main thread with Shiki's JavaScript
// regex engine, which is far smaller to download than the Oniguruma WASM.
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from "@shikijs/core";
import { createJavaScriptRegexEngine } from "../shiki";
import { codeLinesHtml, SYNTAX_THEME } from "./codeHighlight";

export type HighlightRequest = {
  id: number;
  text: string;
  language: string;
  grammar?: LanguageRegistration[];
};
export type HighlightResponse = { id: number; html: string | null };

let highlighter: Promise<HighlighterCore> | null = null;

export async function highlightToHtml(
  text: string,
  language: string,
  grammar?: LanguageRegistration[],
) {
  highlighter ??= createHighlighterCore({
    themes: [SYNTAX_THEME],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  const instance = await highlighter;
  if (grammar) await instance.loadLanguage(...grammar);
  const { tokens, fg } = instance.codeToTokens(text, {
    lang: language,
    theme: "thyra",
    // Same per-line limit as the diff viewer; longer lines stay plain.
    tokenizeMaxLineLength: 4_000,
    // The JavaScript engine compiles each grammar rule on first use, which
    // can exceed Shiki's default 500 ms line budget on the first lines.
    tokenizeTimeLimit: 5_000,
  });
  return codeLinesHtml(tokens, fg);
}

self.onmessage = async ({ data }: MessageEvent<HighlightRequest>) => {
  let html: string | null = null;
  try {
    html = await highlightToHtml(data.text, data.language, data.grammar);
  } catch {
    // Unsupported grammars leave the preview as plain text.
  }
  self.postMessage({ id: data.id, html } satisfies HighlightResponse);
};
