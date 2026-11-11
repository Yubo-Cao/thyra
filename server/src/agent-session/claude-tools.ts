import type {
  AgentFileDiff,
  AgentPlanEntry,
  AgentToolKind,
} from "../../../shared/agentSession";
import { displayPath, oneLine, record, remainingInput, text } from "./adapter";
import {
  patchForWholeFile,
  patchFromHunks,
  patchFromTexts,
  truncatePatch,
} from "./diff";

/** A single file's patch stays below this; longer ones are cut at a line. */
export const DIFF_PATCH_LIMIT = 64 * 1024;

/** How a Claude Code tool call shows in the transcript. */
export type ToolView = {
  kind: AgentToolKind;
  title: string;
  command?: string;
  diffs?: AgentFileDiff[];
  input?: string;
};

function boundedDiff(path: string, patch: string): AgentFileDiff {
  return { path, patch: truncatePatch(patch, DIFF_PATCH_LIMIT).patch };
}

export function isTodoTool(name: string): boolean {
  return name === "TodoWrite";
}

/** `TodoWrite` input as plan entries; null when it is not a todo list. */
export function planEntries(input: unknown): AgentPlanEntry[] | null {
  const todos = record(input)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.flatMap((value): AgentPlanEntry[] => {
    const todo = record(value);
    const content = text(todo?.content);
    if (!content) return [];
    return [
      {
        text: content,
        status:
          todo?.status === "completed"
            ? "done"
            : todo?.status === "in_progress"
              ? "in_progress"
              : "pending",
      },
    ];
  });
}

function editDiffs(
  name: string,
  input: Record<string, unknown>,
): AgentFileDiff[] | undefined {
  const path = text(input.file_path) ?? text(input.notebook_path);
  if (!path) return undefined;
  if (name === "Write") {
    const content = text(input.content);
    return content === undefined
      ? undefined
      : [boundedDiff(path, patchForWholeFile(content, "+"))];
  }
  if (name === "Edit") {
    const from = text(input.old_string);
    const to = text(input.new_string);
    return from === undefined || to === undefined
      ? undefined
      : [boundedDiff(path, patchFromTexts(from, to))];
  }
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const hunks = input.edits.flatMap((value) => {
      const edit = record(value);
      const from = text(edit?.old_string);
      const to = text(edit?.new_string);
      return from === undefined || to === undefined
        ? []
        : [patchFromTexts(from, to)];
    });
    return hunks.length > 0
      ? [boundedDiff(path, hunks.filter(Boolean).join("\n"))]
      : undefined;
  }
  return undefined;
}

/** The title, kind and structured parts of one tool call. */
export function describeClaudeTool(
  name: string,
  rawInput: unknown,
  cwd: string,
): ToolView {
  const input = record(rawInput) ?? {};
  const path = text(input.file_path) ?? text(input.notebook_path);
  switch (name) {
    case "Bash": {
      const command = text(input.command) ?? "";
      return {
        kind: "command",
        title: oneLine(command) || name,
        ...(command ? { command } : {}),
        input: remainingInput(input, ["command", "description"]),
      };
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const diffs = editDiffs(name, input);
      return {
        kind: "edit",
        title: path ? displayPath(path, cwd) : name,
        ...(diffs ? { diffs } : {}),
        input: diffs
          ? undefined
          : remainingInput(input, ["file_path", "notebook_path"]),
      };
    }
    case "Read": {
      const range =
        typeof input.offset === "number"
          ? `:${input.offset}${typeof input.limit === "number" ? `-${input.offset + input.limit}` : ""}`
          : "";
      return {
        kind: "read",
        title: path ? displayPath(path, cwd) + range : name,
      };
    }
    case "Grep":
    case "Glob": {
      const where = text(input.path);
      return {
        kind: "search",
        title:
          oneLine(text(input.pattern) ?? name) +
          (where ? ` in ${displayPath(where, cwd)}` : ""),
        input: remainingInput(input, ["pattern", "path"]),
      };
    }
    case "LS":
      return {
        kind: "search",
        title: displayPath(text(input.path) ?? name, cwd),
      };
    case "WebSearch":
      return {
        kind: "search",
        title: oneLine(text(input.query) ?? name),
        input: remainingInput(input, ["query"]),
      };
    case "WebFetch":
      return {
        kind: "fetch",
        title: oneLine(text(input.url) ?? name),
        input: remainingInput(input, ["url"]),
      };
    case "Task":
    case "Agent":
      return {
        kind: "task",
        title: oneLine(
          text(input.description) ?? text(input.subagent_type) ?? name,
        ),
        input: remainingInput(input, ["description"]),
      };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return {
        kind: "other",
        title: mcp ? `${mcp[1]}: ${mcp[2]}` : name,
        input: remainingInput(input, []),
      };
    }
  }
}

/**
 * The patch Claude Code reports after an edit ran, with the file's real line
 * numbers; null when the result carries none.
 */
export function resultDiffs(toolUseResult: unknown): AgentFileDiff[] | null {
  const result = record(toolUseResult);
  const path = text(result?.filePath);
  if (!result || !path) return null;
  const patch = patchFromHunks(result.structuredPatch);
  return patch ? [boundedDiff(path, patch)] : null;
}

/** The text of a `tool_result` block's content. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => {
      const block = record(value);
      if (block?.type === "text") return text(block.text) ?? "";
      if (block?.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
