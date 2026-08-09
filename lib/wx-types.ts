export interface WxSession {
  chat: string;
  chat_type: 'private' | 'group';
  is_group: boolean;
  last_msg_type: string;
  last_sender: string;
  summary: string;
  time: string;
  timestamp: number;
  unread: number;
  username: string;
}

export interface WxMessage {
  local_id?: number;
  sender: string;
  content: string;
  time: string;
  timestamp: number;
  type: string;
}

export interface WxNewMessage extends WxMessage {
  chat: string;
  chat_type: 'private' | 'group';
  is_group: boolean;
  username: string;
}

export interface WxNewMessagesMeta {
  status?: string;
  shards_hit?: number;
  shards_scanned?: number;
  unknown_shards?: number;
}

export interface WxNewMessagesResponse {
  count: number;
  messages: WxNewMessage[];
  meta?: WxNewMessagesMeta;
}

export interface WxDaemonStatus {
  running: boolean;
  pid?: number;
  uptime_seconds?: number;
}
