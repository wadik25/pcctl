<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import QRCode from 'qrcode';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { api, loadConnection, wsUrl } from './lib/api.ts';
  import type { InboxTask, PendingEval, TaskFilter, ViewId, WhatsAppStatus, WorkModeState } from './lib/types.ts';

  let view: ViewId = $state('tasks');
  let filter: TaskFilter = $state('open');
  let tasks: InboxTask[] = $state([]);
  let pending: PendingEval[] = $state([]);
  let selected: InboxTask | null = $state(null);
  let work: WorkModeState = $state({ enabled: false, changedAt: 0 });
  let wa: WhatsAppStatus = $state({ state: 'disconnected', qr: null, me: null, error: null });
  let whitelist: { jid: string; name: string; enabled: boolean }[] = $state([]);
  let discovered: { jid: string; name: string; allowed: boolean }[] = $state([]);
  let qrUrl = $state('');
  let transcript = $state('');
  let showTranscript = $state(false);
  let draft = $state('');
  let contactName = $state('');
  let contactPhone = $state('');
  let error = $state('');
  let socket: WebSocket | null = null;

  const openTasks = $derived(
    tasks.filter((task) => task.status === 'inbox' || task.status === 'active' || task.status === 'paused'),
  );
  const laterTasks = $derived(tasks.filter((task) => task.status === 'snoozed'));
  const doneTasks = $derived(tasks.filter((task) => task.status === 'done'));
  const visible = $derived.by(() => {
    const list = filter === 'later' ? laterTasks : filter === 'done' ? doneTasks : openTasks;
    return [...list].sort((a, b) => b.createdAt - a.createdAt);
  });

  function isWhatsApp(task: InboxTask) {
    return task.source === 'whatsapp' || Boolean(task.messageId);
  }

  async function focusApp() {
    try {
      const win = getCurrentWindow();
      await win.unminimize();
      await win.show();
      await win.setFocus();
    } catch {
      // Im Browser-Preview ohne Tauri
    }
  }

  async function refresh() {
    try {
      const [list, waiting, mode, status] = await Promise.all([
        api.tasks(),
        api.pending(),
        api.workMode(),
        api.whatsapp(),
      ]);
      tasks = list.filter((task) => task.status !== 'dropped');
      pending = waiting;
      work = mode;
      wa = status;
      if (selected) {
        selected = tasks.find((task) => task.id === selected?.id) ?? null;
      }
      if (status.qr) qrUrl = await QRCode.toDataURL(status.qr, { width: 220, margin: 1 });
      else qrUrl = '';
      error = '';
      if (view === 'settings') await refreshSettings();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function refreshSettings() {
    try {
      whitelist = await api.whitelist();
      discovered = await api.chats();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function connectWs() {
    try {
      socket?.close();
      socket = new WebSocket(wsUrl());
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; payload?: unknown };
        if (
          (message.type === 'taskCreated' || message.type === 'taskEnriched') &&
          message.payload &&
          typeof message.payload === 'object' &&
          'id' in message.payload
        ) {
          const incoming = message.payload as InboxTask;
          void refresh().then(() => {
            const found = tasks.find((task) => task.id === incoming.id);
            if (found) void select(found);
            view = 'tasks';
            filter = 'open';
            if (isWhatsApp(incoming)) void focusApp();
          });
          return;
        }
        if (
          message.type === 'taskUpdated' ||
          message.type === 'workModeChanged' ||
          message.type === 'whatsappStatus' ||
          message.type === 'voiceTranscribed' ||
          message.type === 'inboxPending'
        ) {
          void refresh();
        }
      };
      socket.onclose = () => {
        setTimeout(connectWs, 3000);
      };
    } catch {
      setTimeout(connectWs, 3000);
    }
  }

  async function act(run: () => Promise<unknown>) {
    try {
      await run();
      await refresh();
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function select(task: InboxTask) {
    selected = task;
    showTranscript = false;
    transcript = '';
    if (task.isVoiceMessage) {
      try {
        const data = await api.transcript(task.id);
        transcript = data.transcript || data.body || '';
      } catch {
        transcript = '';
      }
    }
  }

  async function create() {
    if (!draft.trim()) return;
    try {
      const created = await api.create(draft.trim());
      draft = '';
      await refresh();
      const found = tasks.find((task) => task.id === created.id) ?? created;
      view = 'tasks';
      filter = 'open';
      await select(found);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function toggleDone(task: InboxTask) {
    if (task.status === 'done') return;
    const wasSelected = selected?.id === task.id;
    await act(() => api.complete(task.id));
    if (wasSelected) selected = null;
  }

  async function dropSelected() {
    if (!selected) return;
    const id = selected.id;
    await act(() => api.drop(id));
    selected = null;
  }

  async function addContact() {
    if (!contactPhone.trim()) return;
    await act(async () => {
      whitelist = await api.addWhitelist(contactName.trim() || contactPhone.trim(), contactPhone.trim());
      contactName = '';
      contactPhone = '';
      await refreshSettings();
    });
  }

  async function toggleAllowed(jid: string, name: string, allowed: boolean) {
    const next = whitelist.filter((entry) => entry.jid !== jid);
    if (allowed) next.push({ jid, name, enabled: true });
    await act(async () => {
      await api.saveWhitelist(next);
      await refreshSettings();
    });
  }

  async function removeAllowed(jid: string) {
    await act(async () => {
      await api.saveWhitelist(whitelist.filter((entry) => entry.jid !== jid));
      await refreshSettings();
    });
  }

  onMount(async () => {
    await loadConnection();
    await refresh();
    connectWs();
  });

  onDestroy(() => socket?.close());

  function formatPhone(jid: string) {
    const user = jid.split('@')[0] ?? jid;
    if (user.startsWith('49') && user.length >= 11) return `+${user.slice(0, 2)} ${user.slice(2)}`;
    return user.startsWith('+') ? user : `+${user}`;
  }
</script>

<div class="app">
  <aside class="sidebar">
    <div class="brand">pcctl</div>
    <nav class="nav">
      <button class:active={view === 'tasks'} onclick={() => (view = 'tasks')}>Aufgaben</button>
      <button class:active={view === 'settings'} onclick={() => { view = 'settings'; void refreshSettings(); }}>
        Einstellungen
      </button>
    </nav>
    <button
      class="work"
      class:on={work.enabled}
      onclick={() => act(() => api.setWorkMode(!work.enabled))}
    >
      <span class="work-dot"></span>
      {work.enabled ? 'Deep Work' : 'Work-Mode'}
    </button>
    {#if error}
      <p class="error">{error}</p>
    {/if}
  </aside>

  <main class="main">
    {#if view === 'settings'}
      <header class="pagehead">
        <h1>Einstellungen</h1>
      </header>

      <section class="panel">
        <h2>WhatsApp</h2>
        <p class="statusline">
          <span class="status-dot" class:on={wa.state === 'connected'} class:off={wa.state !== 'connected'}></span>
          {#if wa.state === 'connected'}
            Verbunden als {formatPhone(wa.me ?? '')}
          {:else if wa.state === 'qr'}
            QR-Code scannen: WhatsApp → Verknüpfte Geräte
          {:else}
            {wa.state}
          {/if}
        </p>
        {#if wa.state === 'qr' && qrUrl}
          <img class="qr" src={qrUrl} alt="WhatsApp QR" />
        {/if}
        {#if wa.state !== 'connected'}
          <button class="primary" onclick={() => act(() => api.connectWhatsapp())}>Verbinden</button>
        {/if}
      </section>

      <section class="panel">
        <h2>Freigegebene Kontakte</h2>
        <p class="lede">
          Nur diese Chats werden gelesen. Smalltalk wird verworfen, echte Aufgaben landen in der Liste.
        </p>
        <div class="add-contact">
          <input bind:value={contactName} placeholder="Name, z. B. Anna" />
          <input bind:value={contactPhone} placeholder="Nummer, z. B. 0177 1234567" onkeydown={(event) => event.key === 'Enter' && addContact()} />
          <button class="primary" onclick={addContact}>Freigeben</button>
        </div>
        {#if whitelist.length === 0}
          <p class="empty">Noch niemand freigegeben.</p>
        {:else}
          <ul class="people">
            {#each whitelist as entry (entry.jid)}
              <li>
                <div>
                  <strong>{entry.name}</strong>
                  <span class="meta">{formatPhone(entry.jid)}</span>
                </div>
                <button class="ghost" onclick={() => removeAllowed(entry.jid)}>Entfernen</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if discovered.length > 0}
        <section class="panel">
          <h2>Gesehene Chats</h2>
          <ul class="people">
            {#each discovered as chat (chat.jid)}
              <li>
                <div>
                  <strong>{chat.name}</strong>
                  <span class="meta">{formatPhone(chat.jid)}</span>
                </div>
                <label class="switch">
                  <input
                    type="checkbox"
                    checked={chat.allowed}
                    onchange={() => toggleAllowed(chat.jid, chat.name, !chat.allowed)}
                  />
                  <span>lesen</span>
                </label>
              </li>
            {/each}
          </ul>
        </section>
      {/if}
    {:else}
      <header class="pagehead">
        <h1>Aufgaben</h1>
        <div class="filters">
          <button class:active={filter === 'open'} onclick={() => (filter = 'open')}>Offen {openTasks.length}</button>
          <button class:active={filter === 'later'} onclick={() => (filter = 'later')}>Später {laterTasks.length}</button>
          <button class:active={filter === 'done'} onclick={() => (filter = 'done')}>Erledigt {doneTasks.length}</button>
        </div>
      </header>

      <form class="composer" onsubmit={(event) => { event.preventDefault(); void create(); }}>
        <input bind:value={draft} placeholder="Neue Aufgabe" />
        <button class="primary" type="submit">Hinzufügen</button>
      </form>

      {#if filter === 'open' && pending.length > 0}
        <ul class="pending">
          {#each pending as item (item.chatJid)}
            <li>
              {item.kind === 'voice' || item.waitingVoice ? 'Sprachnachricht' : 'Nachricht'} von {item.senderName || 'Kontakt'} wird geprüft…
            </li>
          {/each}
        </ul>
      {/if}

      {#if visible.length === 0 && (filter !== 'open' || pending.length === 0)}
        <p class="empty">
          {filter === 'open' ? 'Nichts offen. Neue Aufgabe schreiben oder auf eine WhatsApp-Nachricht warten.' : 'Keine Einträge.'}
        </p>
      {:else if visible.length > 0}
        <ul class="todos">
          {#each visible as task (task.id)}
            <li class="todo" class:selected={selected?.id === task.id}>
              <label class="check">
                <input
                  type="checkbox"
                  checked={task.status === 'done'}
                  disabled={task.status === 'done'}
                  onchange={() => toggleDone(task)}
                />
                <span></span>
              </label>
              <button class="todo-body" onclick={() => select(task)}>
                <span class="todo-title">{task.title}</span>
                <span class="todo-meta">
                  {task.senderName ?? 'manuell'}
                  {#if task.isVoiceMessage} · Sprache{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </main>

  <aside class="detail">
    {#if selected && view === 'tasks'}
      <h2>{selected.title}</h2>
      {#if selected.context}
        <p class="context">{selected.context}</p>
      {/if}
      <p class="meta">{selected.senderName ?? 'manuell'}</p>
      {#if selected.steps.length}
        <ul class="steps">
          {#each selected.steps as step (step.id)}
            <li>
              <input type="checkbox" checked={step.done} onchange={() => act(() => api.toggleStep(step.id))} />
              {step.title}
            </li>
          {/each}
        </ul>
      {/if}
      {#if selected.isVoiceMessage}
        <button class="ghost" onclick={() => (showTranscript = !showTranscript)}>
          {showTranscript ? 'Transkript verbergen' : 'Transkript zeigen'}
        </button>
        {#if showTranscript}
          <pre class="transcript">{transcript || 'Kein Transkript gespeichert.'}</pre>
        {/if}
      {/if}
      <div class="actions">
        {#if selected.status !== 'done'}
          <button class="ghost" onclick={() => act(() => api.snooze(selected!.id))}>Später</button>
          <button class="ghost" onclick={() => toggleDone(selected!)}>Erledigt</button>
        {/if}
        <button class="danger" onclick={dropSelected}>Verwerfen</button>
      </div>
    {:else if view === 'tasks'}
      <p class="empty">Aufgabe wählen.</p>
    {/if}
  </aside>
</div>
