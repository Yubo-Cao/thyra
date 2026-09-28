import type {
  ShellCompletion,
  ShellHistoryEntry,
} from "../../../../shared/shell";

export function autoEnabled(samples: readonly number[], previous: boolean) {
  if (!samples.length) return false;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return previous ? median >= 40 : median > 60;
}

/** Deliberately a completeness heuristic, not a shell parser. */
export function incomplete(text: string): boolean {
  const stack: string[] = [];
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = "";
      continue;
    }
    if (c === "'" && !quote) {
      quote = c;
      continue;
    }
    if (c === '"') {
      quote = quote === '"' ? "" : '"';
      continue;
    }
    if (c === "`") {
      if (stack[stack.length - 1] === "`") stack.pop();
      else stack.push("`");
    }
    if (c === "$" && text[i + 1] === "(") {
      stack.push(quote);
      quote = "";
      i++;
    } else if (
      c === "(" &&
      !quote &&
      stack.length &&
      stack[stack.length - 1] !== "`"
    ) {
      stack.push("");
    } else if (
      c === ")" &&
      !quote &&
      stack.length &&
      stack[stack.length - 1] !== "`"
    )
      quote = stack.pop()!;
  }
  return escaped || !!quote || stack.length > 0;
}

export function historyMatches(
  entries: ShellHistoryEntry[],
  prefix: string,
  cwd?: string,
) {
  const sorted = [...entries].sort(
    (a, b) =>
      Number(b.cwd === cwd) - Number(a.cwd === cwd) || b.start_ts - a.start_ts,
  );
  return [
    ...new Set(
      sorted.filter((e) => e.command.startsWith(prefix)).map((e) => e.command),
    ),
  ];
}
export function ghostText(
  entries: ShellHistoryEntry[],
  text: string,
  cwd?: string,
) {
  return text
    ? (historyMatches(entries, text, cwd)
        .find((s) => s !== text)
        ?.slice(text.length) ?? "")
    : "";
}
export function searchHistory(entries: ShellHistoryEntry[], query: string) {
  const q = query.toLowerCase();
  return [
    ...new Set(
      [...entries]
        .sort((a, b) => b.start_ts - a.start_ts)
        .map((e) => e.command),
    ),
  ]
    .filter((command) => {
      let i = 0;
      for (const c of command.toLowerCase()) if (c === q[i]) i++;
      return i === q.length;
    })
    .slice(0, 50);
}
export function navigateHistory(
  matches: string[],
  index: number,
  direction: -1 | 1,
  draft: string,
) {
  const next = Math.max(-1, Math.min(matches.length - 1, index + direction));
  return { index: next, text: next < 0 ? draft : matches[next] };
}
export function applyCompletion(
  line: string,
  completion: ShellCompletion,
  text: string,
) {
  const start = Math.max(0, Math.min(line.length, completion.replace_start));
  const end = Math.max(start, Math.min(line.length, completion.replace_end));
  return {
    text: line.slice(0, start) + text + line.slice(end),
    caret: start + text.length,
  };
}
export function commonPrefix(items: ShellCompletion["items"]) {
  let prefix = items[0]?.text ?? "";
  for (const item of items)
    while (!item.text.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}
export function shellKey(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing"
  >,
  empty: boolean,
) {
  if (event.isComposing || event.metaKey) return null;
  if (event.ctrlKey) {
    if (event.key === "]") return "escape-hatch";
    if (event.key.toLowerCase() === "r") return "search";
    if (event.key.toLowerCase() === "c") return empty ? "\x03" : "clear";
    if (empty)
      return (
        ({ d: "\x04", l: "\x0c", z: "\x1a" } as Record<string, string>)[
          event.key.toLowerCase()
        ] ?? null
      );
    return null;
  }
  if (event.key === "Enter")
    return event.shiftKey || event.altKey ? "newline" : "submit";
  if (event.key === "Tab") return "complete";
  if (event.key === "Escape") return empty ? "\x1b" : "hide";
  if (empty && event.key === "PageUp") return "\x1b[5~";
  if (empty && event.key === "PageDown") return "\x1b[6~";
  return null;
}
