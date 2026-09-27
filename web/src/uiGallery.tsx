// Dev-only gallery of components/ui, served by `bun run dev:web` at
// /ui-gallery.html. Query parameters: theme=dark|light, layout=desktop|mobile,
// accent=neutral|teal|green|amber|rose|violet. Not part of the production
// build (vite.config.ts builds index.html only). Strings are fixtures, so
// they are intentionally not wrapped in t().
import {
  Copy,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/vendor.css";
import "./styles/ui.css";
import "./styles/heroui.css";
import {
  AvatarGroup,
  type AvatarGroupPerson,
} from "./components/ui/AvatarGroup";
import { Button } from "./components/ui/Button";
import { Checkbox } from "./components/ui/Checkbox";
import { CloseButton } from "./components/ui/CloseButton";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import {
  ContextMenu,
  type ContextMenuPosition,
} from "./components/ui/ContextMenu";
import { Dialog } from "./components/ui/Dialog";
import { IconButton } from "./components/ui/IconButton";
import { Kbd } from "./components/ui/Kbd";
import { Menu, type MenuEntry } from "./components/ui/Menu";
import { Popover } from "./components/ui/Popover";
import { SearchField } from "./components/ui/SearchField";
import { SegmentedControl } from "./components/ui/SegmentedControl";
import { Select } from "./components/ui/Select";
import { Spinner } from "./components/ui/Spinner";
import { Switch } from "./components/ui/Switch";
import { Tabs } from "./components/ui/Tabs";
import { TextArea } from "./components/ui/TextArea";
import { TextField } from "./components/ui/TextField";
import { ToastRegion, toast } from "./components/ui/Toast";
import { Token } from "./components/ui/Token";
import { Tooltip } from "./components/ui/Tooltip";
import { GlobalTooltip } from "./components/GlobalTooltip";
import "./uiGallery.css";

const params = new URLSearchParams(window.location.search);
const root = document.documentElement;
root.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
root.style.colorScheme = root.dataset.theme;
if (params.get("layout") === "mobile") root.dataset.layout = "mobile";
root.dataset.accent = params.get("accent") ?? "neutral";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-section">
      <h2>{title}</h2>
      <div className="gallery-body">{children}</div>
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="gallery-row">{children}</div>;
}

const workspaceMenu: MenuEntry[] = [
  {
    title: "Inspect",
    items: [
      {
        id: "browse",
        label: "Browse files",
        icon: <FolderOpen size={14} />,
        shortcut: "Ctrl+P",
      },
      {
        id: "review",
        label: "Review changes",
        icon: <GitBranch size={14} />,
        description: "3 files",
      },
    ],
  },
  {
    title: "Organize",
    items: [
      { id: "pin", label: "Pin workspace", icon: <Pin size={14} /> },
      {
        id: "rename",
        label: "Rename workspace...",
        icon: <Pencil size={14} />,
      },
      { id: "copy", label: "Copy checkout path", icon: <Copy size={14} /> },
      { id: "sync", label: "Pull from Git", disabled: true },
    ],
  },
  {
    title: "Close",
    danger: true,
    items: [
      { id: "remove", label: "Remove worktree", icon: <Trash2 size={14} /> },
      { id: "close", label: "Close workspace" },
    ],
  },
];

const portrait = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="${color}"/><circle cx="4" cy="3.2" r="1.6" fill="#fff"/><rect x="1.5" y="5.4" width="5" height="3" fill="#fff"/></svg>`,
  )}`;

const people: AvatarGroupPerson[] = [
  {
    key: "y",
    name: "Yubo Cao",
    avatarUrl: portrait("#2f81f7"),
    controller: true,
  },
  { key: "a", name: "Alice Park", color: "#cf222e" },
  {
    key: "b",
    name: "Bea",
    color: "#1a7f37",
    avatarUrl: "https://invalid.test/x.png",
  },
  { key: "c", name: "Carl Diaz", color: "#8250df" },
  { key: "d", name: "Dana Ito", avatarUrl: portrait("#bf8700") },
];

function Gallery() {
  const [segment, setSegment] = useState<"tree" | "list" | "agents">("tree");
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [checked, setChecked] = useState(true);
  const [unchecked, setUnchecked] = useState(false);
  const [name, setName] = useState("feature/ui-kit");
  const [search, setSearch] = useState("worktree");
  const [notes, setNotes] = useState("Square, borderless, token heights.");
  const [tab, setTab] = useState<"general" | "terminal" | "agents">("general");
  const [shell, setShell] = useState("zsh");
  const [order, setOrder] = useState("recent");
  const [wrap, setWrap] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [full, setFull] = useState(false);
  const [side, setSide] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(
    null,
  );
  const [pinned, setPinned] = useState(false);
  const [lastAction, setLastAction] = useState("none");

  return (
    <div className="gallery">
      <header className="ui-bar">
        <span className="ui-bar-title">Thyra UI gallery</span>
        <Token tone="accent">{root.dataset.theme}</Token>
        <Token>{root.dataset.layout ?? "desktop"}</Token>
        <span className="ui-bar-spacer" />
        <IconButton label="Refresh" icon={<RefreshCw size={14} />} />
        <IconButton label="Settings" icon={<Settings size={14} />} />
        <Menu
          aria-label="More actions"
          trigger={
            <IconButton
              label="More actions"
              icon={<MoreHorizontal size={15} />}
            />
          }
          items={workspaceMenu}
          header={{ title: "thyra", subtitle: "Linked worktree" }}
          onAction={setLastAction}
          placement="bottom end"
        />
      </header>

      <Section title="Button">
        <Row>
          <Button>Ghost</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="danger-soft">Danger soft</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button aria-pressed={wrap} onClick={() => setWrap(!wrap)}>
            Wrap {wrap ? "on" : "off"}
          </Button>
        </Row>
        <Row>
          <Button size="md" variant="secondary">
            Cancel
          </Button>
          <Button size="md" variant="primary">
            Save changes
          </Button>
          <Button size="md" variant="danger">
            Remove
          </Button>
          <Button variant="secondary">
            <Copy size={13} /> With icon
          </Button>
        </Row>
        <Row>
          <IconButton label="Copy path" icon={<Copy size={14} />} />
          <IconButton
            label="Delete"
            tone="danger"
            icon={<Trash2 size={14} />}
          />
          <IconButton label="Pinned" aria-pressed icon={<Pin size={14} />} />
          <IconButton
            label="Settings"
            variant="secondary"
            icon={<Settings size={14} />}
          />
          <CloseButton />
          <Tooltip
            content={
              <>
                Rich tooltip with <Kbd>Ctrl+K</Kbd>
              </>
            }
          >
            <Button variant="secondary">Hover for Tooltip</Button>
          </Tooltip>
        </Row>
      </Section>

      <Section title="SegmentedControl, Token, Kbd, Spinner">
        <Row>
          <SegmentedControl
            aria-label="View"
            value={segment}
            onChange={setSegment}
            options={[
              { value: "tree", label: "Tree" },
              { value: "list", label: "List" },
              { value: "agents", label: "Agents", disabled: true },
            ]}
          />
          <Token>neutral</Token>
          <Token tone="accent">accent</Token>
          <Token tone="success">success</Token>
          <Token tone="warning">warning</Token>
          <Token tone="danger">danger</Token>
          <Token code>w1:p12</Token>
          <Token as="button" icon={<FolderOpen size={11} />} onClick={() => {}}>
            workspace
          </Token>
          <Kbd>Ctrl+Shift+K</Kbd>
          <Spinner size="sm" label="Loading" />
          <Spinner tone="accent" />
        </Row>
        <SegmentedControl
          aria-label="Scope"
          stretch
          value={segment}
          onChange={setSegment}
          options={[
            { value: "tree", label: "Workspace" },
            { value: "list", label: "Repository" },
            { value: "agents", label: "Agents" },
          ]}
        />
      </Section>

      <Section title="AvatarGroup">
        <Row>
          <AvatarGroup
            people={people.slice(1, 3)}
            label="Viewing: Alice, Bea"
          />
          <AvatarGroup people={people} label="Viewing: 5 people" />
          <AvatarGroup size="md" people={people.slice(1)} max={4} />
        </Row>
      </Section>

      <Section title="Switch, Checkbox">
        <Row>
          <Switch checked={on} onChange={setOn}>
            Auto-sync
          </Switch>
          <Switch checked={off} onChange={setOff}>
            Notifications
          </Switch>
          <Switch checked disabled onChange={() => {}}>
            Locked
          </Switch>
          <Checkbox checked={checked} onChange={setChecked}>
            Show hidden
          </Checkbox>
          <Checkbox checked={unchecked} onChange={setUnchecked}>
            Include ignored
          </Checkbox>
          <Checkbox checked={false} indeterminate onChange={() => {}}>
            Some
          </Checkbox>
          <Checkbox checked={false} invalid onChange={() => {}}>
            Required
          </Checkbox>
        </Row>
        <div className="gallery-settings-row">
          <Switch
            checked={on}
            onChange={setOn}
            labelPosition="start"
            description="Pull the default branch every 5 minutes."
          >
            Branch auto-update
          </Switch>
        </div>
      </Section>

      <Section title="TextField, TextArea, SearchField">
        <div className="gallery-grid">
          <TextField
            label="Branch"
            value={name}
            onValueChange={setName}
            description="Created from origin/main."
          />
          <TextField
            label="Name"
            value=""
            onChange={() => {}}
            placeholder="Workspace name"
            error="A name is required."
          />
          <TextField label="Disabled" value="read only" disabled readOnly />
          <SearchField
            aria-label="Filter"
            placeholder="Filter files"
            value={search}
            onValueChange={setSearch}
          />
          <TextArea
            label="Notes"
            value={notes}
            onValueChange={setNotes}
            fullWidth
          />
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs
          aria-label="Settings sections"
          value={tab}
          onChange={setTab}
          items={[
            { id: "general", label: "General", icon: <Settings size={13} /> },
            { id: "terminal", label: "Terminal" },
            { id: "agents", label: "Agents" },
          ]}
        >
          <p className="gallery-panel">Panel: {tab}</p>
        </Tabs>
      </Section>

      <Section title="Select, Menu, ContextMenu, Popover">
        <Row>
          <Select
            label="Shell"
            value={shell}
            onChange={setShell}
            options={[
              { value: "zsh", label: "zsh" },
              { value: "bash", label: "bash" },
              { value: "fish", label: "fish", description: "not installed" },
              { value: "nu", label: "nushell", disabled: true },
            ]}
          />
          <Select
            aria-label="Order"
            variant="ghost"
            value={order}
            onChange={setOrder}
            options={[
              { value: "recent", label: "Recent first" },
              { value: "name", label: "By name" },
            ]}
          />
          <Menu
            aria-label="Workspace actions"
            trigger={<Button variant="secondary">Menu</Button>}
            items={[
              ...workspaceMenu,
              {
                items: [
                  {
                    id: "pin-toggle",
                    label: "Pinned",
                    checked: pinned,
                    onAction: () => setPinned(!pinned),
                  },
                ],
              },
            ]}
            onAction={setLastAction}
          />
          <Popover
            aria-label="Rename"
            trigger={<Button variant="secondary">Popover</Button>}
          >
            {(close) => (
              <div className="gallery-popover">
                <TextField
                  label="Display name"
                  value={name}
                  onValueChange={setName}
                  autoFocus
                />
                <Button variant="primary" onClick={close}>
                  Save
                </Button>
              </div>
            )}
          </Popover>
          <span className="gallery-muted">last action: {lastAction}</span>
        </Row>
        <div
          className="gallery-context-target"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          Right-click here for a ContextMenu
        </div>
        <ContextMenu
          aria-label="Workspace"
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          header={{ title: "herdr", subtitle: "Git workspace" }}
          items={workspaceMenu}
          onAction={setLastAction}
        />
      </Section>

      <Section title="Dialog, ConfirmDialog, Toast">
        <Row>
          <Button variant="secondary" onClick={() => setDialog(true)}>
            Open dialog
          </Button>
          <Button variant="danger-soft" onClick={() => setConfirm(true)}>
            Confirm dialog
          </Button>
          <Button variant="secondary" onClick={() => setFull(true)}>
            Full dialog
          </Button>
          <Button variant="secondary" onClick={() => setSide(true)}>
            Side dialog
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.info("Thyra 0.8.0 is available", {
                description: "Current 0.7.9, ready to update and restart",
                action: { label: "Update", onAction: () => {} },
              })
            }
          >
            Info toast
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const id = toast.show({
                title: "Pulling from Git",
                loading: true,
              });
              window.setTimeout(
                () =>
                  toast.update(
                    id,
                    {
                      title: "Pulled 3 commits",
                      tone: "success",
                      loading: false,
                    },
                    { timeout: 5000 },
                  ),
                1500,
              );
            }}
          >
            Loading toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast.danger("Failed to copy checkout path", {
                description: "Clipboard permission denied",
              })
            }
          >
            Error toast
          </Button>
        </Row>
        <Dialog
          open={dialog}
          onOpenChange={setDialog}
          title="New Worktree"
          description="Creates a branch from the current HEAD."
          onSubmit={() => setDialog(false)}
          footer={
            <>
              <Button
                size="md"
                variant="secondary"
                onClick={() => setDialog(false)}
              >
                Cancel
              </Button>
              <Button size="md" variant="primary" type="submit">
                Create
              </Button>
            </>
          }
        >
          <div className="gallery-dialog-body">
            <TextField
              label="Branch"
              value={name}
              onValueChange={setName}
              autoFocus
              fullWidth
            />
            <Switch checked={on} onChange={setOn}>
              Open in a new tab
            </Switch>
            <Select
              label="Base"
              value={shell}
              onChange={setShell}
              options={[
                { value: "zsh", label: "origin/main" },
                { value: "bash", label: "origin/dev" },
              ]}
            />
          </div>
        </Dialog>
        <ConfirmDialog
          open={confirm}
          onOpenChange={setConfirm}
          title="Remove Worktree"
          message='Remove worktree "feature/ui-kit"? Uncommitted changes are lost.'
          confirmLabel="Remove"
          tone="danger"
          onConfirm={() => new Promise((resolve) => setTimeout(resolve, 600))}
        />
        <Dialog
          open={side}
          onOpenChange={setSide}
          title="Launch agent"
          placement="side"
          headerStart={<IconButton label="Back" icon={<Copy size={14} />} />}
          headerActions={
            <IconButton label="Settings" icon={<Settings size={14} />} />
          }
          footer={
            <Button size="md" variant="primary" onClick={() => setSide(false)}>
              Start
            </Button>
          }
        >
          <SearchField
            aria-label="Filter folders"
            placeholder="Filter or type a path"
            value={search}
            onValueChange={setSearch}
            fullWidth
          />
        </Dialog>
        <Dialog
          open={full}
          onOpenChange={setFull}
          title="File explorer"
          size="full"
          footer={
            <Button size="md" variant="primary" onClick={() => setFull(false)}>
              Done
            </Button>
          }
        >
          <p>Full-size dialogs cover the viewport.</p>
        </Dialog>
      </Section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Gallery />
    <ToastRegion />
    <GlobalTooltip />
  </StrictMode>,
);
