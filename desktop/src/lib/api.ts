import { invoke } from '@tauri-apps/api/core';
import { fetch } from '@tauri-apps/plugin-http';
import type {
  AgentConnection,
  InboxTask,
  PendingEval,
  WhatsAppStatus,
  WorkModeState,
} from './types.ts';

let connection: AgentConnection | null = null;

export async function loadConnection(): Promise<AgentConnection> {
  connection = await invoke<AgentConnection>('get_connection');
  return connection;
}

function base(): string {
  if (!connection) throw new Error('Keine Verbindung zum Agent');
  return `http://${connection.host}:${connection.port}`;
}

async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (!connection) await loadConnection();
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${connection!.token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Rohtext behalten
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const api = {
  tasks: (status?: string) => request<InboxTask[]>(status ? `/api/tasks?status=${status}` : '/api/tasks'),
  pending: () => request<PendingEval[]>('/api/tasks/pending'),
  create: (title: string) => request<InboxTask>('/api/tasks', 'POST', { title }),
  drop: (id: string) => request<InboxTask>(`/api/tasks/${id}/drop`, 'POST', {}),
  complete: (id: string) => request<InboxTask>(`/api/tasks/${id}/complete`, 'POST', {}),
  snooze: (id: string) => request<InboxTask>(`/api/tasks/${id}/snooze`, 'POST', { hours: 4 }),
  toggleStep: (id: string) => request<InboxTask>(`/api/tasks/steps/${id}/toggle`, 'POST', {}),
  transcript: (id: string) =>
    request<{ task: InboxTask; transcript: string | null; body: string | null; senderName: string | null; receivedAt: number | null }>(
      `/api/tasks/${id}/transcript`,
    ),
  workMode: () => request<WorkModeState>('/api/workmode'),
  setWorkMode: (enabled: boolean) => request<WorkModeState>('/api/workmode', 'POST', { enabled }),
  whatsapp: () => request<WhatsAppStatus>('/api/whatsapp/status'),
  connectWhatsapp: () => request<WhatsAppStatus>('/api/whatsapp/connect', 'POST'),
  whitelist: () => request<{ jid: string; name: string; enabled: boolean }[]>('/api/whatsapp/whitelist'),
  saveWhitelist: (chats: { jid: string; name: string; enabled: boolean }[]) =>
    request('/api/whatsapp/whitelist', 'PUT', { chats }),
  addWhitelist: (name: string, phone: string) =>
    request<{ jid: string; name: string; enabled: boolean }[]>('/api/whatsapp/whitelist/add', 'POST', { name, phone }),
  chats: () => request<{ jid: string; name: string; allowed: boolean }[]>('/api/whatsapp/chats'),
};

export function wsUrl(): string {
  if (!connection) throw new Error('Keine Verbindung zum Agent');
  return `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`;
}
