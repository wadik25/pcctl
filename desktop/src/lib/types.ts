export type TaskStatus = 'inbox' | 'active' | 'paused' | 'done' | 'snoozed' | 'dropped';
export type TaskSource = 'whatsapp' | 'manual';

export type TaskStep = {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  position: number;
};

export type InboxTask = {
  id: string;
  messageId: string | null;
  title: string;
  context: string;
  isVoiceMessage: boolean;
  status: TaskStatus;
  senderName: string | null;
  chatJid: string | null;
  createdAt: number;
  updatedAt: number;
  steps: TaskStep[];
  source?: TaskSource;
};

export type PendingEval = {
  chatJid: string;
  senderName: string;
  kind: 'text' | 'voice';
  receivedAt: number;
  waitingVoice: boolean;
};

export type WorkModeState = { enabled: boolean; changedAt: number };

export type WhatsAppStatus = {
  state: 'disconnected' | 'connecting' | 'qr' | 'connected';
  qr: string | null;
  me: string | null;
  error: string | null;
};

export type AgentConnection = {
  token: string;
  port: number;
  host: string;
};

export type ViewId = 'tasks' | 'settings';
export type TaskFilter = 'open' | 'later' | 'done';
