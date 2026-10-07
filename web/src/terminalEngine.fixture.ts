// Tests run Herdr's frames through the engine's own VT core (restty's WASM,
// headless) and mode tracking, as the browser does.
import { createHeadlessTerminal } from "restty/headless";
import { createInputHandler } from "restty/internal";
import {
  GRAPHEME_CLUSTERING,
  type RenderState,
  stateLine,
} from "./terminalEngine";

export async function headlessTerminal(cols: number, rows: number) {
  const core = await createHeadlessTerminal({ cols, rows, replay: false });
  const modes = createInputHandler({
    getCursorPosition: () => ({ row: 1, col: 1 }),
    sendReply: () => {},
  } as never);
  core.write(GRAPHEME_CLUSTERING);
  const state = () => core.snapshot() as unknown as RenderState;
  return {
    write(text: string, parsed?: () => void) {
      modes.filterOutput(text);
      core.write(text);
      if (parsed) queueMicrotask(parsed);
    },
    line: (row: number) => stateLine(state(), row),
    cursor: () => state().cursor,
    mouseTracking: () => modes.isMouseActive(),
    dispose: () => core.dispose(),
  };
}
