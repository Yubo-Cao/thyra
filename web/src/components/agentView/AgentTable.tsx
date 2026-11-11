import {
  Check,
  Copy,
  Download,
  FileCode,
  FileSpreadsheet,
  FileText,
  Table,
} from "lucide-react";
import type { Tokens } from "marked";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n";
import { copyTextFromUserGesture } from "../../terminalClipboard";
import { IconButton } from "../ui/IconButton";
import { Menu } from "../ui/Menu";
import {
  tableData,
  toCsv,
  toHtmlTable,
  toMarkdownTable,
  toTsv,
} from "./tableData";

// A byte order mark, so Excel opens the CSV as UTF-8.
const BOM = String.fromCharCode(0xfeff);

/** Save `data` as a file named `name` through the browser's download. */
function download(data: BlobPart, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A reply's table with its tools: copy as cells (tab-separated text and an
 * HTML table, which spreadsheets paste as cells), copy as Markdown, and
 * downloads. Everything is built from the cells' text, never the page's HTML.
 */
export function AgentTable({
  table,
  children,
}: {
  table: Tokens.Table;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = (text: string, html?: string) =>
    void copyTextFromUserGesture(text, { html }).then(
      () => setCopied(true),
      () => {},
    );
  const markdown = () => {
    const data = tableData(table);
    return `${toMarkdownTable(data.markdown, data.align)}\n`;
  };
  return (
    <div className="agent-table">
      {children}
      <div className="agent-table-tools" data-md-skip="">
        <IconButton
          label={copied ? t("Copied") : t("Copy table")}
          icon={copied ? <Check size={13} /> : <Copy size={13} />}
          onClick={() => {
            const { rows } = tableData(table);
            copy(toTsv(rows), toHtmlTable(rows));
          }}
        />
        <Menu
          aria-label={t("Table actions")}
          placement="bottom end"
          trigger={
            <IconButton
              label={t("Export table")}
              icon={<Download size={13} />}
            />
          }
          items={[
            {
              id: "copy-markdown",
              label: t("Copy as Markdown"),
              icon: <FileCode size={14} />,
              onAction: () => copy(markdown()),
            },
            {
              id: "csv",
              label: t("Download CSV"),
              icon: <Table size={14} />,
              onAction: () =>
                download(
                  BOM + toCsv(tableData(table).rows),
                  "text/csv;charset=utf-8",
                  "table.csv",
                ),
            },
            {
              id: "xlsx",
              label: t("Download Excel"),
              icon: <FileSpreadsheet size={14} />,
              onAction: () =>
                void import("./xlsx").then(({ xlsxWorkbook }) =>
                  download(
                    xlsxWorkbook(
                      tableData(table).rows,
                    ) as Uint8Array<ArrayBuffer>,
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "table.xlsx",
                  ),
                ),
            },
            {
              id: "markdown",
              label: t("Download Markdown"),
              icon: <FileText size={14} />,
              onAction: () =>
                download(markdown(), "text/markdown;charset=utf-8", "table.md"),
            },
          ]}
        />
      </div>
    </div>
  );
}
