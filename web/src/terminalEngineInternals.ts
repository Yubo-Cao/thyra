// The engine reads only these from restty's internal entry. Importing that
// whole namespace dynamically keeps every export alive, including restty's
// built-in theme catalogue (about 225 KB) that Thyra never uses.
export {
  PREEDIT_ACTIVE_BG,
  PREEDIT_BG,
  PREEDIT_CARET,
  PREEDIT_FG,
  PREEDIT_UL,
} from "restty/internal";
