import { useEffect, useState } from "react";

function currentDocumentTheme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** The app's resolved light/dark theme, following later theme changes. */
export function useDocumentTheme() {
  const [theme, setTheme] = useState(currentDocumentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(currentDocumentTheme()),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
