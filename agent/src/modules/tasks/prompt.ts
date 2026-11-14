export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confidence', 'items'],
  properties: {
    confidence: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'match_id', 'title', 'context', 'steps'],
        properties: {
          kind: { type: 'string', enum: ['create', 'update'] },
          match_id: { type: 'string' },
          title: { type: 'string' },
          context: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `Du bist ein strenger Filter, der aus WhatsApp-Nachrichten Arbeitsaufgaben macht.

Keine Aufgabe:
- Smalltalk, Witze, bloße Bestätigungen, Danksagungen, Emojis, Statusmeldungen.
- Im Zweifel items leer lassen. Lieber nichts anlegen als Spam.

Aufteilen (create):
- Unabhängige Aufträge in EINER Nachricht werden getrennte items mit kind=create.
- Niemals mehrere sachlich getrennte Jobs in eine Aufgabe mit steps stopfen.
- Beispiel: „Pakete prüfen, Server recherchieren, Postfächer anlegen“ → drei create-items, steps jeweils leer.
- steps nur, wenn es aufeinanderfolgende Schritte EINER Sache sind (z. B. Zertifikat erneuern, dann Dienst neu starten).

Ergänzen (update):
- Unter „Bereits offen“ stehen Aufgaben desselben Chats (id, Titel, Kontext).
- Neue Infos, Dateien, Bilder, Links, Korrekturen oder Details zu einer offenen Aufgabe: kind=update und match_id = deren id. Keine zweite Aufgabe anlegen.
- context bei update: der vollständige, aktualisierte Anlass (alt plus neu, knapp). Nicht nur den neuen Satz.
- title bei update nur ändern, wenn er dadurch klarer wird, sonst denselben Titel lassen.
- steps bei update: nur wirklich neue Schritte, keine Wiederholungen.
- [Bild]/[Datei]/[Video] ohne weiteren Auftragstext: wenn offene Aufgaben existieren, fast immer update der passenden (sonst items leer, nichts Neues erfinden).
- Eine Nachricht kann beides enthalten: update einer alten und create einer neuen.

Stil:
- title: Deutsch, Imperativ, maximal 60 Zeichen, unaufgeregt.
- context: 1–3 Sätze mit Absender und Anlass. Keine Ausschmückung.
- confidence 0–1. Unter 0.6 lieber items leer.
- Nur JSON gemäß Schema, ohne Markdown.`;

export function userPrompt(input: {
  senderName: string;
  chatJid: string;
  isVoice: boolean;
  text: string;
  openTasks: { id: string; title: string; context: string; steps: string[] }[];
}): string {
  const kind = input.isVoice ? 'Sprachnachricht (Transkription)' : 'Textnachricht';
  const open =
    input.openTasks.length === 0
      ? 'Keine.'
      : input.openTasks
          .map((task) => {
            const steps = task.steps.length ? ` | Schritte: ${task.steps.join('; ')}` : '';
            const context = task.context.trim() ? task.context.trim().replace(/\s+/g, ' ').slice(0, 280) : '—';
            return `- id=${task.id} | ${task.title} | ${context}${steps}`;
          })
          .join('\n');
  return [
    `Absender: ${input.senderName}`,
    `Chat: ${input.chatJid}`,
    `Art: ${kind}`,
    '',
    'Bereits offen:',
    open,
    '',
    'Nachricht:',
    input.text.trim(),
  ].join('\n');
}
