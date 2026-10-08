import { keepFocus } from "./keepFocus";
import { File, Folder, GitBranch, History, Terminal } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ShellCompletion } from "../../../../shared/shell";
import { Button } from "./Button";

const icons = {
  file: File,
  dir: Folder,
  branch: GitBranch,
  history: History,
  command: Terminal,
};
export function ShellSuggestions({
  id,
  items,
  selected,
  label,
  onSelect,
}: {
  id: string;
  items: ShellCompletion["items"];
  selected: number;
  label: string;
  onSelect(index: number): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={root}
      id={id}
      role="listbox"
      aria-label={label}
      className="shell-editor-suggestions"
    >
      {items.map((item, index) => {
        const Icon = icons[item.kind];
        return (
          <Button
            key={index}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === selected}
            tabIndex={-1}
            onMouseDown={keepFocus}
            onClick={() => onSelect(index)}
          >
            <Icon size={14} />
            <span>{item.text}</span>
            {item.detail && <small>{item.detail}</small>}
          </Button>
        );
      })}
    </div>
  );
}
