import type { RefObject } from "react";
import type { PromptImages } from "./livePreview";

/** A text range as string offsets into the draft. */
export type PromptEditorSelection = { start: number; end: number };

/**
 * The editing surface under the prompt editor's chrome: the instant textarea
 * or Monaco once loaded. Both are uncontrolled; the editor pushes outside
 * changes to the draft (uploads, a restored failed send) through `setText`.
 */
export type PromptEditorSurface = {
  focus(): void;
  hasFocus(): boolean;
  /** The text as it stands now, ahead of a change still to be reported. */
  text(): string;
  selection(): PromptEditorSelection | null;
  /** Replaces the text if it differs and places the caret. */
  setText(text: string, caret?: number): void;
  /** Types text at the selection, as one undoable edit. */
  insertText(text: string): void;
};

export type PromptEditorFont = {
  family: string;
  /** CSS pixels. */
  size: number;
  /** CSS pixels: one terminal row, so edited lines sit on terminal rows. */
  lineHeight: number;
};

export type PromptEditorSurfaceProps = {
  surfaceRef: RefObject<PromptEditorSurface | null>;
  initialText: string;
  initialSelection: PromptEditorSelection | null;
  /** Take focus when mounted. */
  focus: boolean;
  /** May change while mounted. */
  placeholder: string;
  label: string;
  /** The text shows and selects but cannot be edited. May change while mounted. */
  readOnly?: boolean;
  /**
   * Written language rather than commands: the keyboard's capitalization,
   * correction and spell check stay on.
   */
  prose?: boolean;
  activeDescendant?: string;
  controls?: string;
  font: PromptEditorFont;
  onChange(text: string, selectionStart: number, selectionEnd: number): void;
  /**
   * While the text is empty, Tab and Shift+Tab move the focus on as anywhere
   * else on the page, without reaching `onKey` or the surface's own keys.
   */
  emptyTabMovesFocus?: boolean;
  /** Handles a key for the editor; true when the surface must not. */
  onKey(event: KeyboardEvent, empty: boolean): boolean;
  /** Uploads clipboard images; true when the paste was taken. */
  onPasteFiles(data: DataTransfer | null): boolean;
  onContentHeight(pixels: number): void;
  onCompositionChange(composing: boolean): void;
  /** Where the draft's images load from; the rich surface renders them. */
  images?: PromptImages;
  /** The user clicked or typed into the surface (loads Monaco on demand). */
  onUse?(): void;
};
