import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The installed (patched) runtime chunk that restty/internal/runtime loads. */
const runtimeSource = () => {
  const entry = Bun.resolveSync("restty/internal/runtime", import.meta.dir);
  const index = readFileSync(entry, "utf8");
  const chunks = [...index.matchAll(/from "\.\.\/(chunk-[\w]+\.js)"/g)].map(
    (match) => readFileSync(join(dirname(entry), "..", match[1]), "utf8"),
  );
  return chunks.join("\n");
};

describe("restty patch", () => {
  const source = runtimeSource();

  test("mouse reports reach the pty while query replies stay off", () => {
    // restty's MouseController sends wheel, click and drag reports through a
    // reply sink; sharing the gated query-reply sink dropped every mouse
    // event a mouse-reporting app (htop, vim) should get.
    expect(source).toContain("sendReply: options.sendMouseReport || replySink");
    const mouse = source.match(/sendMouseReport: \(data\) => \{([^}]*)\}/);
    expect(mouse?.[1].trim()).toBe("ptyTransport.sendInput(data);");
    const replies = source.match(/sendReply: \(data\) => \{([^}]*)\}/);
    expect(replies?.[1]).toContain("if (forwardTerminalReplies)");
  });

  test("the native scroller can be turned off", () => {
    // It puts the canvas on a sticky, will-change layer shifted by
    // fractional pixels, which blurs text; Thyra owns scrolling.
    expect(source).toContain(
      "nativeScrollbar: terminal.nativeScrollbar ?? true",
    );
    expect(source).toContain(
      "const nativeScrollHost = options.nativeScrollbar !== false &&",
    );
  });

  test("coding ligatures substitute one cell-wide glyph per cell", () => {
    // Maple Mono joins runs of `-`, `->`, `==` with calt alternates that keep
    // one advance per character; restty capped runs at 8 cells and placed
    // their glyphs by font advance, so long runs broke and drifted.
    expect(source).not.toContain("MAX_LIGATURE_RUN_CHARS");
    expect(
      source.match(/gridAlignedLigature\(renderableLigatureRun/g),
    ).toHaveLength(2);
    expect(
      source.match(/searchPending: rowSearchCursor < rowSearchEndIndex/g),
    ).toHaveLength(2);
    const body = source.match(
      /function resolveRenderableLigatureRun\(options\) \{[^]*?\n\}\n/,
    )?.[0];
    const resolve = new Function(
      `${body}; return resolveRenderableLigatureRun;`,
    )();
    // Font 0 covers `-` and `>`, font 1 covers `\`; `-` alone is glyph 1.
    const glyphs: Record<string, number[]> = {
      "-": [1],
      ">": [2],
      "\\": [3],
      "--": [5, 6],
      "->": [7, 8],
      "-->": [5, 7, 8],
      "-x": [1, 0],
    };
    const run = (text: string, wide = false) => {
      const chars = [...text];
      return resolve({
        ligatureRun: {
          text,
          span: chars.length,
          indices: chars.map((_, i) => i),
        },
        stylePreference: "regular",
        fonts: [{}, {}],
        pickFontIndexForText: (t: string) => (t === "\\" ? 1 : 0),
        shapeClusterWithFont: (_: unknown, t: string) => {
          const ids = glyphs[t] ?? [...t].map(() => 1);
          const advance = wide && t.length > 1 ? 700 : 600;
          return {
            glyphs: ids.map((glyphId) => ({
              glyphId,
              xAdvance: advance,
              xOffset: 0,
            })),
            advance: advance * ids.length,
          };
        },
        readCellCluster: (i: number) => ({ text: chars[i], span: 1 }),
      });
    };
    expect(
      run("-->")?.shaped.glyphs.map((g: { glyphId: number }) => g.glyphId),
    ).toEqual([5, 7, 8]);
    expect(run("-->")?.fontIndex).toBe(0);
    // A cell that picks another font slice ends the run.
    expect(run("--\\")?.text).toBe("--");
    expect(run("\\--")).toBeNull();
    // Missing alternates, unchanged glyphs or other advances: cell by cell.
    expect(run("-x")).toBeNull();
    expect(run("---")).toBeNull();
    expect(run("->", true)).toBeNull();
  });

  test("slices of the primary face keep its scale", () => {
    // Thyra Mono ships as unicode-range slices; only some carry the ic-width
    // probe (水), which shrank their CJK by ~9% and resampled it.
    expect(source).toMatch(
      /function resolveFallbackScaleAdjustment\(primaryFont, fallbackFont\) \{[^]*?if \(isSameFaceMetrics\(primary, fallback\)\)\s*return 1;/,
    );
  });

  describe("IME input", () => {
    const fn = (name: string) =>
      source.match(new RegExp(`\\nfunction ${name}\\([^]*?\\n\\}\\n`))?.[0];
    const consts = source.match(
      /\nvar IME_INPUT_MAX_CHARS = [^]*?\n\]\);\n/,
    )?.[0];
    const bindImeEvents = new Function(
      `const requestAnimationFrame = (frame) => frame();${consts}${fn("imeInputEditsInPlace")}${fn("imeInputEdit")}${fn("bindImeEvents")}; return bindImeEvents;`,
    )();

    /** A hidden input bound like restty binds it, with a browser's edits. */
    const setup = () => {
      // Setting the value puts the caret at its end, as in a textarea.
      let text = "";
      const input = Object.assign(new EventTarget(), {
        selectionStart: 0,
        selectionEnd: 0,
        value: "",
      });
      Object.defineProperty(input, "value", {
        get: () => text,
        set: (next: string) => {
          text = next;
          input.selectionStart = input.selectionEnd = next.length;
        },
      });
      const sent: string[] = [];
      const imeState = {
        composing: false,
        preedit: "",
        selectionStart: 0,
        selectionEnd: 0,
      };
      bindImeEvents({
        bindOptions: {
          inputHandler: {
            encodeBeforeInput: (e: InputEvent) =>
              e.inputType === "insertText"
                ? e.data || ""
                : e.inputType.startsWith("delete")
                  ? "\x7f"
                  : e.inputType === "insertLineBreak"
                    ? "\r"
                    : "",
            mapKeyForPty: (text: string) => text,
          },
          sendKeyInput: (text: string) => sent.push(text),
          sendPasteText: (text: string) => sent.push(`paste:${text}`),
          sendPastePayloadFromDataTransfer: () => {},
          getLastKeydownSeq: () => "",
          getLastKeydownSeqAt: () => 0,
          keydownBeforeinputDedupeMs: 0,
        },
        imeInput: input,
        imeState,
        cleanupCanvasFns: [],
        getWasmReady: () => true,
        getWasmHandle: () => 1,
        setPreedit: (text: string) => (imeState.preedit = text),
        syncImeSelection: () => {},
      });
      const fire = (type: string, props: Record<string, unknown> = {}) => {
        const event = Object.assign(new Event(type, { cancelable: true }), {
          isComposing: false,
          ...props,
        });
        input.dispatchEvent(event);
        return !event.defaultPrevented;
      };
      const select = (start: number, end = start) => {
        input.selectionStart = start;
        input.selectionEnd = end;
      };
      const replace = (inserted: string) => {
        const { value, selectionStart: start, selectionEnd: end } = input;
        input.value = value.slice(0, start) + inserted + value.slice(end);
        select(start + inserted.length);
      };
      /** Composes text over the selection, as an IME commits or replaces. */
      const compose = (text: string) => {
        fire("compositionstart", { data: "" });
        fire("compositionupdate", { data: text });
        replace(text);
        fire("compositionend", { data: text });
      };
      /** An edit the browser applies itself unless it is cancelled. */
      const edit = (inputType: string, data: string | null = null) => {
        if (!fire("beforeinput", { inputType, data })) return;
        if (inputType === "deleteContentBackward") {
          if (input.selectionStart === input.selectionEnd)
            select(Math.max(0, input.selectionStart - 1), input.selectionEnd);
          replace("");
        } else replace(data ?? "");
        fire("input", { inputType, data });
      };
      return { input, sent, imeState, fire, select, compose, edit };
    };
    const last = (sent: string[]) => sent[sent.length - 1];

    test("a voice IME replacing its commit sends the correction once", () => {
      const ime = setup();
      ime.compose("hello world");
      expect(ime.sent).toEqual(["hello world"]);
      // The cleanup pass reselects the dictated text and composes over it.
      ime.select(0, ime.input.value.length);
      ime.compose("Hello, world.");
      expect(ime.sent[1]).toBe(`${"\x7f".repeat(11)}Hello, world.`);
      expect(ime.imeState.composing).toBe(false);
      expect(ime.imeState.preedit).toBe("");
    });

    test("replacement text, deletes and middle edits retype the tail", () => {
      const ime = setup();
      ime.compose("teh cat");
      ime.select(0, 3);
      ime.edit("insertReplacementText", "the");
      expect(ime.sent[1]).toBe(`${"\x7f".repeat(6)}he cat`);
      ime.select(ime.input.value.length);
      ime.edit("deleteContentBackward");
      expect(ime.sent[2]).toBe("\x7f");
      expect(ime.input.value).toBe("the ca");
    });

    test("deletes count code points, not UTF-16 units", () => {
      const ime = setup();
      ime.compose("语音😀");
      ime.select(0, ime.input.value.length);
      ime.compose("语音。");
      expect(ime.sent[1]).toBe("\x7f。");
    });

    test("keys and paste start over; IME keys keep the text", () => {
      const ime = setup();
      ime.compose("ls");
      ime.fire("keydown", { key: "Process", keyCode: 229 });
      expect(ime.input.value).toBe("ls");
      ime.fire("keydown", { key: "Enter", keyCode: 13 });
      expect(ime.input.value).toBe("");
      ime.compose("echo");
      // A backspace with nothing to delete still reaches the pty.
      ime.fire("keydown", { key: "ArrowLeft", keyCode: 37 });
      ime.edit("deleteContentBackward");
      expect(last(ime.sent)).toBe("\x7f");
      ime.edit("insertLineBreak");
      expect(last(ime.sent)).toBe("\r");
      expect(ime.input.value).toBe("");
      ime.compose("x");
      ime.fire("beforeinput", {
        inputType: "insertFromPaste",
        dataTransfer: { getData: () => "pasted" },
      });
      expect(last(ime.sent)).toBe("paste:pasted");
      expect(ime.input.value).toBe("");
    });
  });
});
