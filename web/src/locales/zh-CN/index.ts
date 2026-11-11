// Simplified Chinese catalog, loaded lazily by initLocale(). Each group file
// covers one area of the interface; see i18n.ts for conventions.
import agent from "./agent";
import core from "./core";
import inspector from "./inspector";
import settings from "./settings";
import shell from "./shell";
import terminal from "./terminal";
import workspace from "./workspace";

const messages: Readonly<Record<string, string>> = {
  ...agent,
  ...core,
  ...inspector,
  ...settings,
  ...shell,
  ...terminal,
  ...workspace,
};

export default messages;
