import { describe, expect, test } from "bun:test";
import {
  redirectScreenFocus,
  terminalFocusBlockedByOverlay,
  terminalPointerShouldBlurInput,
  terminalTapOpensInput,
  terminalTouchShouldDismissInput,
} from "./terminalFocus";

function docWithOpenPopper(open: boolean) {
  return {
    querySelector: (selector: string) =>
      open && selector === ".ui-popover" ? ({} as Element) : null,
  } as Pick<Document, "querySelector">;
}

function elementMatching(matching: string[] | null) {
  return {
    closest: (selector: string) =>
      matching?.includes(selector) ? ({} as Element) : null,
  } as Pick<Element, "closest">;
}

describe("terminalFocusBlockedByOverlay", () => {
  test("blocks refocusing whenever a popover is mounted", () => {
    const doc = docWithOpenPopper(true);
    expect(terminalFocusBlockedByOverlay(null, doc)).toBe(true);
    // Covers the open-animation frame where focus still sits on the trigger.
    expect(terminalFocusBlockedByOverlay(elementMatching(null), doc)).toBe(
      true,
    );
  });

  test("blocks when a navigation or resource surface owns focus", () => {
    const doc = docWithOpenPopper(false);
    expect(
      terminalFocusBlockedByOverlay(
        elementMatching([
          '.ui-popover, .workspace-tree-panel, .workspace-inspector, .tabbar-utilities, .mobile-nav, .pane-jump-backdrop, [role="dialog"], [role="menu"]',
        ]),
        doc,
      ),
    ).toBe(true);
  });

  test("allows refocusing with no overlay and no focused element", () => {
    expect(terminalFocusBlockedByOverlay(null, docWithOpenPopper(false))).toBe(
      false,
    );
  });

  test("allows refocusing ordinary page elements", () => {
    expect(
      terminalFocusBlockedByOverlay(
        elementMatching(null),
        docWithOpenPopper(false),
      ),
    ).toBe(false);
  });
});

describe("terminal pointer focus", () => {
  test("blurs coarse-pointer taps only outside terminal and editable input", () => {
    expect(terminalPointerShouldBlurInput(true, false, false)).toBe(true);
    expect(terminalPointerShouldBlurInput(true, true, false)).toBe(false);
    expect(terminalPointerShouldBlurInput(true, false, true)).toBe(false);
    expect(terminalPointerShouldBlurInput(false, false, false)).toBe(false);
  });

  test("only a completed light tap dismisses active input", () => {
    expect(terminalTouchShouldDismissInput(true, false, true)).toBe(true);
    expect(terminalTouchShouldDismissInput(true, true, true)).toBe(false);
    expect(terminalTouchShouldDismissInput(true, false, false)).toBe(false);
    expect(terminalTouchShouldDismissInput(false, false, true)).toBe(false);
  });
});

test("taps on the input rows near the bottom or cursor open the keyboard", () => {
  expect(terminalTapOpensInput(38, 40, null)).toBe(true);
  expect(terminalTapOpensInput(29, 40, null)).toBe(true);
  expect(terminalTapOpensInput(10, 40, null)).toBe(false);
  expect(terminalTapOpensInput(11, 40, 12)).toBe(true);
  expect(terminalTapOpensInput(2, 4, null)).toBe(true);
});

/**
 * Focus as WebKit runs it: focus() on an element that is not focused fires
 * its listeners synchronously, inside the caller.
 */
function reentrantFocusPair() {
  let active: string | null = null;
  let depth = 0;
  const element = (name: string) => {
    const listeners: (() => void)[] = [];
    return {
      addEventListener: (_type: string, listener: () => void) => {
        listeners.push(listener);
      },
      focus: () => {
        if (active === name) return;
        if (++depth > 50) throw new RangeError("Maximum call stack size");
        active = name;
        try {
          for (const listener of listeners) listener();
        } finally {
          depth--;
        }
      },
    };
  };
  return {
    screen: element("screen"),
    input: element("input"),
    active: () => active,
  };
}

describe("redirectScreenFocus", () => {
  test("moves canvas focus to the input before the engine runs", () => {
    const { screen, input, active } = reentrantFocusPair();
    redirectScreenFocus(
      screen as never,
      input as never,
      () => true,
      new AbortController().signal,
    );
    screen.focus();
    expect(active()).toBe("input");
  });

  test("leaves canvas focus to restty once it runs", () => {
    const { screen, input, active } = reentrantFocusPair();
    let engineRunning = false;
    redirectScreenFocus(
      screen as never,
      input as never,
      () => !engineRunning,
      new AbortController().signal,
    );
    // restty's own canvas focus handler: refocus the canvas, then the input.
    screen.addEventListener("focus", () => {
      screen.focus();
      input.focus();
    });
    engineRunning = true;
    expect(() => screen.focus()).not.toThrow();
    expect(active()).toBe("input");
  });
});
