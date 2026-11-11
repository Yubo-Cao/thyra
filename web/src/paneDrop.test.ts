import { describe, expect, test } from "bun:test";
import {
  paneDropPreviewRect,
  paneDropRequest,
  paneDropResultLayout,
  paneDropTarget,
  paneDropZone,
} from "./paneDrop";

const rect = { x: 100, y: 0, width: 100, height: 50 };

describe("paneDropZone", () => {
  test("the middle 40% box swaps", () => {
    expect(paneDropZone({ x: 150, y: 25 }, rect)).toBe("center");
    expect(paneDropZone({ x: 130, y: 15 }, rect)).toBe("center");
    expect(paneDropZone({ x: 170, y: 35 }, rect)).toBe("center");
  });

  test("outside the centre the nearest edge wins, relative to size", () => {
    expect(paneDropZone({ x: 105, y: 25 }, rect)).toBe("left");
    expect(paneDropZone({ x: 195, y: 25 }, rect)).toBe("right");
    expect(paneDropZone({ x: 150, y: 2 }, rect)).toBe("top");
    expect(paneDropZone({ x: 150, y: 48 }, rect)).toBe("bottom");
    // 20% from the left beats 30% from the top.
    expect(paneDropZone({ x: 120, y: 15 }, rect)).toBe("left");
    // Just outside the centre box vertically, near the middle horizontally.
    expect(paneDropZone({ x: 150, y: 14 }, rect)).toBe("top");
  });

  test("points outside the pane have no zone", () => {
    expect(paneDropZone({ x: 99, y: 25 }, rect)).toBeNull();
    expect(paneDropZone({ x: 150, y: 51 }, rect)).toBeNull();
    expect(paneDropZone({ x: 0, y: 0 }, { ...rect, width: 0 })).toBeNull();
  });
});

describe("paneDropTarget", () => {
  const panes = [
    { pane_id: "w1:p1", rect: { x: 0, y: 0, width: 100, height: 50 } },
    { pane_id: "w1:p2", rect },
  ];

  test("finds the pane and zone under the pointer", () => {
    expect(paneDropTarget({ x: 150, y: 25 }, panes, "w1:p1")).toEqual({
      paneId: "w1:p2",
      zone: "center",
    });
    expect(paneDropTarget({ x: 190, y: 25 }, panes, "w1:p1")).toEqual({
      paneId: "w1:p2",
      zone: "right",
    });
  });

  test("the source pane and empty space are not targets", () => {
    expect(paneDropTarget({ x: 50, y: 25 }, panes, "w1:p1")).toBeNull();
    expect(paneDropTarget({ x: 300, y: 25 }, panes, "w1:p1")).toBeNull();
  });
});

describe("paneDropPreviewRect", () => {
  test("the centre highlights the whole target, an edge its half", () => {
    expect(paneDropPreviewRect("center", rect)).toEqual(rect);
    expect(paneDropPreviewRect("left", rect)).toEqual({
      x: 100,
      y: 0,
      width: 50,
      height: 50,
    });
    expect(paneDropPreviewRect("right", rect)).toEqual({
      x: 150,
      y: 0,
      width: 50,
      height: 50,
    });
    expect(paneDropPreviewRect("top", rect)).toEqual({
      x: 100,
      y: 0,
      width: 100,
      height: 25,
    });
    expect(paneDropPreviewRect("bottom", rect)).toEqual({
      x: 100,
      y: 25,
      width: 100,
      height: 25,
    });
  });
});

describe("paneDropRequest", () => {
  test("the centre swaps the two panes", () => {
    expect(
      paneDropRequest("w1:p1", { paneId: "w1:p2", zone: "center" }, "w1:t1"),
    ).toEqual({
      method: "pane.swap",
      params: { source_pane_id: "w1:p1", target_pane_id: "w1:p2" },
    });
  });

  test("edges move the pane beside the target in the same tab", () => {
    const placement = (zone: "left" | "right" | "top" | "bottom") => {
      const request = paneDropRequest(
        "w1:p1",
        { paneId: "w1:p2", zone },
        "w1:t1",
      );
      if (request?.method !== "pane.move") throw new Error("expected a move");
      expect(request.params).toMatchObject({
        pane_id: "w1:p1",
        focus: false,
        destination: {
          type: "tab",
          tab_id: "w1:t1",
          target_pane_id: "w1:p2",
        },
      });
      const { split, position } = request.params.destination;
      return `${split}+${position}`;
    };
    expect(placement("left")).toBe("right+before");
    expect(placement("right")).toBe("right+after");
    expect(placement("top")).toBe("down+before");
    expect(placement("bottom")).toBe("down+after");
  });

  test("dropping a pane on itself does nothing", () => {
    expect(
      paneDropRequest("w1:p1", { paneId: "w1:p1", zone: "left" }, "w1:t1"),
    ).toBeNull();
  });
});

describe("paneDropResultLayout", () => {
  const layout = {
    workspace_id: "w1",
    tab_id: "w1:t1",
    zoomed: false,
    area: { x: 0, y: 0, width: 200, height: 50 },
    focused_pane_id: "w1:p1",
    panes: [],
    splits: [],
  };

  test("reads the swap and move result layouts", () => {
    expect(
      paneDropResultLayout({ type: "pane_swap", swap: { layout } }),
    ).toEqual(layout);
    expect(
      paneDropResultLayout({
        type: "pane_move",
        move_result: { target_layout: layout, source_layout: layout },
      }),
    ).toEqual(layout);
  });

  test("ignores results without a layout", () => {
    expect(paneDropResultLayout(null)).toBeNull();
    expect(paneDropResultLayout({ swap: { changed: false } })).toBeNull();
    expect(
      paneDropResultLayout({ swap: { layout: { panes: [] } } }),
    ).toBeNull();
  });
});
