export type MessageAttachment = {
  label: string;
  kind: "url" | "file";
  url?: string;
  path?: string;
  preview_url?: string;
  download_url?: string;
};
export type MessageSource = {
  connection_id?: string;
  workspace_id?: string;
  pane_id?: string;
};
export type BoardMessage = {
  id: string;
  owner_id: string;
  title: string;
  body: string;
  author_label: string;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  read_at: number | null;
  archived_at: number | null;
  source?: MessageSource;
  attachments: MessageAttachment[];
};
export type MessageBoardList = {
  messages: BoardMessage[];
  unread_count: number;
  next_cursor: string | null;
};
export type CreateBoardMessage = {
  title: string;
  body: string;
  author_label?: string;
  source?: MessageSource;
  attachments?: MessageAttachment[];
  idempotency_key?: string;
};
export type UpdateBoardMessage = {
  id: string;
  pinned?: boolean;
  read?: boolean;
  archived?: boolean;
};
