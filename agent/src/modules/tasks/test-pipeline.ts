/**
 * Prüft Heuristik und Kimi-K3-Extraktion ohne WhatsApp.
 * Aufruf: node src/modules/tasks/test-pipeline.ts
 */
import { extractTask, looksLikeSmalltalk } from './extractor.ts';

const cases = [
  { name: 'Danke', text: 'Danke!', expectSmalltalk: true },
  { name: 'Bis gleich', text: 'Bis gleich', expectSmalltalk: true },
  { name: 'Emoji', text: '👍', expectSmalltalk: true },
  { name: 'SSL', text: 'Anna: Das Let\'s-Encrypt-Zertifikat für example.de ist abgelaufen, kannst du das heute noch erneuern?', expectSmalltalk: false },
];

let failed = 0;
for (const item of cases) {
  const small = looksLikeSmalltalk(item.text);
  const ok = small === item.expectSmalltalk;
  console.log(`${ok ? 'ok' : 'FEHLER'} Heuristik ${item.name}: smalltalk=${small}`);
  if (!ok) failed += 1;
}

const llmCases = [
  {
    name: 'Smalltalk LLM',
    text: 'Danke, bis später!',
    wantTask: false,
  },
  {
    name: 'Echte Aufgabe',
    text: 'Hey, das SSL-Zertifikat für die Domain example.de ist abgelaufen. Bitte Let\'s Encrypt heute noch erneuern und den Webserver neu starten.',
    wantTask: true,
  },
];

for (const item of llmCases) {
  try {
    const result = await extractTask({
      senderName: 'Anna',
      chatJid: 'test@s.whatsapp.net',
      isVoice: false,
      text: item.text,
      openTasks: [],
    });
    const isTask = result.items.length > 0;
    const ok = isTask === item.wantTask;
    console.log(
      `${ok ? 'ok' : 'FEHLER'} LLM ${item.name}: items=${result.items.length} confidence=${result.confidence}` +
        (result.items[0] ? ` title="${result.items[0].title}"` : ''),
    );
    if (!ok) failed += 1;
  } catch (err) {
    console.log(`FEHLER LLM ${item.name}: ${(err as Error).message}`);
    failed += 1;
  }
}

if (failed > 0) {
  console.error(`${failed} Prüfungen fehlgeschlagen`);
  process.exit(1);
}
console.log('Pipeline-Prüfung bestanden');
