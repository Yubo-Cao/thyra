import { initLocale } from "./i18n";
import { initializeLayoutPreferences } from "./layoutPreferences";
import { initializeShortcutPreferences } from "./shortcutPreferences";
import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/vendor.css";
import "./styles/ui.css";
import "./styles/heroui.css";
import App from "./App";
import { store } from "./store";
import { registerAppServiceWorker } from "./appServiceWorker";
import { initDirectPath } from "./directPath";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <pre
          style={{
            color: "#ff9a9a",
            padding: 20,
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
          }}
        >
          {this.state.error.message}
          {"\n\n"}
          {this.state.error.stack}
        </pre>
      );
    }
    return this.props.children;
  }
}

// `/admin` and below is the instance admin page (the bridge serves it to
// admins only): one lazy chunk, without the workspace store, its socket or
// the terminal.
const adminPage = /^\/admin(?:\/|$)/.test(window.location.pathname);

initializeLayoutPreferences();
if (!adminPage) {
  initializeShortcutPreferences();
  // Connect before the first render requests the terminal chunks.
  store.init();
  // Move to the tailnet origin when this device reaches it (after hello).
  initDirectPath();
  // Cache the shell and fingerprinted assets so repeat visits on slow links
  // only fetch what a deploy changed (web/public/task-notifications-sw.js).
  if (import.meta.env.PROD) registerAppServiceWorker();
}

// Load the interface catalog before the first render so no text flips language.
void Promise.all([
  initLocale(),
  adminPage && import("./components/AdminPage"),
]).then(([, admin]) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>{admin ? <admin.AdminPage /> : <App />}</ErrorBoundary>
    </React.StrictMode>,
  );
});
