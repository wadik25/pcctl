export type MessageKind = 'text' | 'voice';

export type TaskStatus = 'inbox' | 'active' | 'paused' | 'done' | 'snoozed' | 'dropped';

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export type SuggestedSlot = 'QUICK_WIN_HEUTE' | 'FOKUS_HEUTE' | 'GEPLANT_SPAETER';

export type InboxMessage = {
  id: string;
  chatJid: string;
  senderName: string;
  kind: MessageKind;
  body: string | null;
  transcript: string | null;
  audioPath: string | null;
  durationSeconds: number | null;
  receivedAt: number;
  evaluatedAt: number | null;
  isTask: boolean | null;
  confidence: number | null;
  llmRaw: string | null;
  retryCount: number;
  lastAttemptAt: number | null;
  llmError: string | null;
};

export type TaskStep = {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  position: number;
};

export type TaskSource = 'whatsapp' | 'manual';

export type InboxTask = {
  id: string;
  messageId: string | null;
  title: string;
  context: string;
  priority: TaskPriority;
  estimatedMinutes: number;
  suggestedSlot: SuggestedSlot;
  canUseAi: boolean;
  recommendedTool: string;
  workflowHint: string;
  isVoiceMessage: boolean;
  status: TaskStatus;
  snoozedUntil: number | null;
  elapsedSeconds: number;
  senderName: string | null;
  chatJid: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  steps: TaskStep[];
  source: TaskSource;
};

export type ExtractionItem = {
  kind: 'create' | 'update';
  matchId: string;
  title: string;
  context: string;
  steps: string[];
};

export type ExtractionResult = {
  confidence: number;
  items: ExtractionItem[];
};

export type PendingEval = {
  chatJid: string;
  senderName: string;
  kind: MessageKind;
  receivedAt: number;
  waitingVoice: boolean;
};

export type WhatsAppStatus = {
  state: 'disconnected' | 'connecting' | 'qr' | 'connected';
  qr: string | null;
  me: string | null;
  error: string | null;
};

export type WhitelistEntry = {
  jid: string;
  name: string;
  enabled: boolean;
};

export type WorkModeState = {
  enabled: boolean;
  changedAt: number;
};

export type TaskViews = {
  quickWins: InboxTask[];
  focusBlocks: InboxTask[];
  later: InboxTask[];
};
