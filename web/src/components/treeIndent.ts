/** Horizontal indent per depth level in the workspace tree. */
export const TREE_DEPTH_INDENT = 12;

/** `px` as rem, so inline tree insets follow the UI scale like the CSS. */
export const treeInset = (px: number) => `${px / 16}rem`;
