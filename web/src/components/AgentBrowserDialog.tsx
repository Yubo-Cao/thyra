import RFB from "@novnc/novnc";
import { Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type AgentBrowserInfo,
  activateAgentBrowserTab,
  closeAgentBrowser,
  fetchAgentBrowser,
  keysymOf,
  useAgentBrowserOpen,
} from "../agentBrowser";
import { t } from "../i18n";
import { useLayoutPreferences } from "../layoutPreferences";
import { Dialog } from "./ui/Dialog";
import { FloatingWindow } from "./ui/FloatingWindow";
import { IconButton } from "./ui/IconButton";
import { Select } from "./ui/Select";
import "./AgentBrowserDialog.css";

const NAMED_KEYS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
};

/** Chromium will not make a window narrower than this many pixels. */
const MIN_REMOTE_WIDTH = 500;

/**
 * Ask the remote for this view's size, but at least MIN_REMOTE_WIDTH wide at
 * the same aspect, so a phone gets the whole window scaled down rather than
 * a cut-off one. Wraps noVNC 1.7 internals: `_requestRemoteResize` reads the
 * size from `_screenSize`, which scaling also uses, so swap it only there.
 */
function keepMinimumRemoteWidth(rfb: RFB) {
  type Size = { w: number; h: number };
  const internal = rfb as unknown as {
    _screenSize(): Size;
    _requestRemoteResize(): void;
  };
  const screenSize = internal._screenSize.bind(rfb);
  const request = internal._requestRemoteResize.bind(rfb);
  internal._requestRemoteResize = () => {
    internal._screenSize = () => {
      const { w, h } = screenSize();
      const k = w > 0 ? Math.max(1, MIN_REMOTE_WIDTH / w) : 1;
      return { w: Math.round(w * k), h: Math.round(h * k) };
    };
    try {
      request();
    } finally {
      internal._screenSize = screenSize;
    }
  };
}

/**
 * The host's headed Chromium over VNC: a pane's tabs, or (opened without a
 * pane) the whole browser with every agent's tabs. Viewing only fronts tabs.
 */
export function AgentBrowserDialog() {
  const target = useAgentBrowserOpen();
  const { mobile } = useLayoutPreferences();
  const [info, setInfo] = useState<AgentBrowserInfo | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "closed">(
    "connecting",
  );
  // State, not refs: the dialog body mounts after its lazy chunk arrives.
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const [keys, setKeys] = useState<HTMLTextAreaElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const open = !!target;
  const paneId = target?.paneId;

  // Front the pane's most relevant tab (or the requested one), then poll the
  // list. The whole browser stays on whatever tab is already in front.
  useEffect(() => {
    setInfo(null);
    setActiveId(null);
    if (!open) return;
    let live = true;
    const load = async () => {
      const next = await fetchAgentBrowser(
        paneId ? { paneId } : { all: true },
      );
      if (live) setInfo(next);
    };
    void activateAgentBrowserTab(paneId, target?.targetId).then((id) => {
      if (!live) return;
      setActiveId(id);
      void load();
    });
    const timer = window.setInterval(load, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [open, paneId, target?.targetId]);

  const vnc = info?.vnc === true;
  useEffect(() => {
    if (!vnc || !screen) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const rfb = new RFB(screen, `${proto}://${location.host}/ws/browser`, {
      shared: true,
    });
    // The remote desktop follows this view's size (Xvnc accepts
    // SetDesktopSize; maximized windows follow it), so pages render 1:1.
    rfb.scaleViewport = true;
    keepMinimumRemoteWidth(rfb);
    rfb.resizeSession = true;
    // Tight JPEG at modest quality keeps slow links usable.
    rfb.qualityLevel = 5;
    rfb.compressionLevel = 6;
    rfb.addEventListener("connect", () => setState("connected"));
    rfb.addEventListener("disconnect", () => setState("closed"));
    rfbRef.current = rfb;
    setState("connecting");
    return () => {
      rfbRef.current = null;
      rfb.disconnect();
    };
  }, [vnc, screen]);

  const press = (keysym: number) => rfbRef.current?.sendKey(keysym, null);
  useEffect(() => {
    if (!keys) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "deleteContentBackward") press(0xff08);
      else if (/^insert(LineBreak|Paragraph)$/.test(event.inputType))
        press(0xff0d);
      else if (event.data) for (const char of event.data) press(keysymOf(char));
      event.preventDefault();
      keys.value = "";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const keysym = NAMED_KEYS[event.key];
      if (keysym === undefined) return;
      event.preventDefault();
      press(keysym);
    };
    keys.addEventListener("beforeinput", onBeforeInput);
    keys.addEventListener("keydown", onKeyDown);
    return () => {
      keys.removeEventListener("beforeinput", onBeforeInput);
      keys.removeEventListener("keydown", onKeyDown);
    };
  }, [keys]);

  const tabs = info?.tabs ?? [];
  const current =
    tabs.find((tab) => tab.targetId === activeId) ??
    tabs.find((tab) => tab.review?.state === "pending");
  const review = tabs.find((tab) => tab.review?.state === "pending")?.review;
  const title = t("Agent browser");
  const description = review?.message || current?.title || undefined;
  const headerActions = (
    <>
      {tabs.length > (paneId ? 1 : 0) ? (
        <Select
          aria-label={t("Browser tab")}
          variant="ghost"
          value={current?.targetId ?? ""}
          placeholder={t("Choose a tab")}
          options={tabs.map((tab) => ({
            value: tab.targetId,
            label: tab.title || tab.url,
            description: tab.url,
          }))}
          onChange={(id) => {
            setActiveId(id);
            void activateAgentBrowserTab(paneId, id);
            rfbRef.current?.focus();
          }}
        />
      ) : null}
      {mobile && vnc ? (
        <IconButton
          label={t("Open device keyboard")}
          icon={<Keyboard size={15} />}
          onClick={() => keys?.focus()}
        />
      ) : null}
    </>
  );
  const content =
    info && !vnc ? (
      <p className="agent-browser-note">
        {t("The browser display is not available on this host.")}
      </p>
    ) : (
      <>
        <div ref={setScreen} className="agent-browser-screen" />
        {state !== "connected" ? (
          <p className="agent-browser-note">
            {state === "closed"
              ? t("Browser display disconnected.")
              : t("Connecting to the browser display...")}
          </p>
        ) : null}
        <textarea
          ref={setKeys}
          className="agent-browser-keys"
          aria-label={t("Type into the browser")}
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
        />
      </>
    );
  // Desktop: a window to move and resize while the terminals stay usable;
  // the remote display follows its size. Phones: a bottom sheet.
  if (!mobile)
    return open ? (
      <FloatingWindow
        title={title}
        description={description}
        headerActions={headerActions}
        onClose={closeAgentBrowser}
        storageKey="agentBrowser.window"
        className="agent-browser-window"
        bodyClassName="agent-browser-body"
      >
        {content}
      </FloatingWindow>
    ) : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && closeAgentBrowser()}
      title={title}
      description={description}
      keyboardDismissable={false}
      size="lg"
      className="agent-browser-dialog"
      bodyClassName="agent-browser-body"
      headerActions={headerActions}
    >
      {content}
    </Dialog>
  );
}
