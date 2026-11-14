package dev.wadik.pcctl.ui

import android.app.Application
import android.app.NotificationManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.wadik.pcctl.data.*
import dev.wadik.pcctl.widget.WidgetRefresher
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class ConnectionState { Unconfigured, Connecting, Online, Offline }

data class UiState(
    val connectionState: ConnectionState = ConnectionState.Connecting,
    val connection: Connection = Connection("", 8765, ""),
    val stats: CompactStats = CompactStats(),
    val status: SystemStatus? = null,
    val apps: AppList = AppList(),
    val sessions: List<ClaudeSession> = emptyList(),
    val tasks: List<ClaudeTask> = emptyList(),
    val approvals: List<ApprovalRequest> = emptyList(),
    /** Verlauf der gerade verfolgten Sitzung. */
    val watchedSessionId: String? = null,
    val sessionEvents: List<SessionEvent> = emptyList(),
    val inboxTasks: List<InboxTask> = emptyList(),
    val activeInbox: InboxTask? = null,
    val workMode: Boolean = false,
    val needsDndAccess: Boolean = false,
    val message: String? = null,
    val busy: Boolean = false,
)

class PcctlViewModel(app: Application) : AndroidViewModel(app) {

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val live = LiveConnection()
    private var liveJob: Job? = null

    init {
        viewModelScope.launch {
            Settings.connectionFlow(getApplication()).collect { connection ->
                _state.update { it.copy(connection = connection) }
                if (connection.isConfigured) {
                    reconnect()
                } else {
                    _state.update { it.copy(connectionState = ConnectionState.Unconfigured) }
                }
            }
        }
    }

    // ---------------------------------------------------------------- Verbindung

    private fun reconnect() {
        liveJob?.cancel()
        liveJob = viewModelScope.launch {
            val connection = _state.value.connection
            if (!connection.isConfigured) return@launch

            _state.update { it.copy(connectionState = ConnectionState.Connecting) }
            refreshStatus()

            // Bei Abbruch neu verbinden – im WLAN passiert das beim Aufwachen ständig.
            while (true) {
                live.connect(connection, _state.value.watchedSessionId).collect { event ->
                    when (event) {
                        is LiveEvent.Connected ->
                            _state.update { it.copy(connectionState = ConnectionState.Online) }

                        is LiveEvent.Disconnected ->
                            _state.update { it.copy(connectionState = ConnectionState.Offline) }

                        is LiveEvent.Live ->
                            _state.update { current ->
                                // Die laufende Meldung überträgt nur veränderliche
                                // Zustände. Ob eine Funktion überhaupt verfügbar ist,
                                // steht im vollen Status und bleibt deshalb erhalten.
                                val merged = current.status?.let { status ->
                                    status.copy(
                                        stats = event.stats,
                                        audio = event.audio ?: status.audio,
                                        display = event.display?.let {
                                            status.display.copy(blanked = it.blanked, mode = it.mode)
                                        } ?: status.display,
                                        rgb = event.rgb?.let {
                                            status.rgb.copy(on = it.on, color = it.color)
                                        } ?: status.rgb,
                                    )
                                }
                                current.copy(
                                    stats = event.stats,
                                    status = merged,
                                    connectionState = ConnectionState.Online,
                                )
                            }

                        is LiveEvent.TaskStatus -> {
                            _state.update { current ->
                                val others = current.tasks.filterNot { it.id == event.task.id }
                                current.copy(tasks = (listOf(event.task) + others).sortedByDescending { it.startedAt })
                            }
                        }

                        is LiveEvent.ApprovalRequested ->
                            _state.update { it.copy(approvals = it.approvals + event.request) }

                        is LiveEvent.ApprovalResolved ->
                            _state.update { current ->
                                current.copy(approvals = current.approvals.filterNot { it.id == event.id })
                            }

                        is LiveEvent.SessionMessage ->
                            _state.update { current ->
                                if (current.watchedSessionId != event.sessionId) current
                                // Der Verlauf bleibt begrenzt, sonst wächst er unbegrenzt.
                                else current.copy(sessionEvents = (current.sessionEvents + event.event).takeLast(200))
                            }

                        is LiveEvent.TaskEvent -> Unit

                        is LiveEvent.InboxCreated ->
                            _state.update { current ->
                                current.copy(inboxTasks = (listOf(event.task) + current.inboxTasks.filterNot { it.id == event.task.id }))
                            }

                        is LiveEvent.InboxUpdated ->
                            _state.update { current ->
                                val others = current.inboxTasks.filterNot { it.id == event.task.id }
                                current.copy(
                                    inboxTasks = listOf(event.task) + others,
                                    activeInbox = if (event.task.status == "active") event.task
                                    else if (current.activeInbox?.id == event.task.id) null
                                    else current.activeInbox,
                                    workMode = current.workMode,
                                )
                            }

                        is LiveEvent.ActiveTick ->
                            _state.update { it.copy(activeInbox = event.task.copy(elapsedSeconds = event.elapsedSeconds)) }

                        is LiveEvent.WorkModeChanged -> {
                            _state.update { it.copy(workMode = event.enabled) }
                            applyLocalDnd(event.enabled)
                        }
                    }
                }
                _state.update { it.copy(connectionState = ConnectionState.Offline) }
                delay(3000)
            }
        }
    }

    fun saveConnection(host: String, port: Int, token: String) {
        viewModelScope.launch {
            Settings.save(getApplication(), host, port, token)
            notify("Verbindung gespeichert")
        }
    }

    // ---------------------------------------------------------------- Abrufe

    fun refreshStatus() {
        viewModelScope.launch {
            val connection = _state.value.connection
            if (!connection.isConfigured) return@launch

            when (val result = PcctlApi.status(connection)) {
                is ApiResult.Success ->
                    _state.update {
                        it.copy(
                            status = result.value,
                            stats = result.value.stats,
                            connectionState = ConnectionState.Online,
                            workMode = result.value.workMode.enabled,
                            activeInbox = result.value.inbox.active,
                        )
                    }

                is ApiResult.Failure ->
                    _state.update { it.copy(connectionState = ConnectionState.Offline, message = result.message) }
            }
        }
    }

    fun refreshApps() {
        launchWithConnection { connection ->
            PcctlApi.apps(connection).onSuccess { list -> _state.update { it.copy(apps = list) } }
        }
    }

    fun refreshClaude() {
        launchWithConnection { connection ->
            PcctlApi.claudeSessions(connection).onSuccess { list -> _state.update { it.copy(sessions = list) } }
            PcctlApi.claudeTasks(connection).onSuccess { list -> _state.update { it.copy(tasks = list) } }
        }
    }

    // ---------------------------------------------------------------- Aktionen

    /**
     * Führt eine Aktion aus und aktualisiert danach den Status. Nach jeder
     * Zustandsänderung werden auch die Widgets aufgefrischt, damit deren
     * Anzeige (etwa das Mikrofonsymbol) nicht veraltet.
     */
    private fun act(label: String, block: suspend (Connection) -> ApiResult<*>) {
        viewModelScope.launch {
            val connection = _state.value.connection
            if (!connection.isConfigured) return@launch

            _state.update { it.copy(busy = true) }
            when (val result = block(connection)) {
                is ApiResult.Success -> notify(label)
                is ApiResult.Failure -> notify("$label fehlgeschlagen: ${result.message}")
            }
            _state.update { it.copy(busy = false) }
            refreshStatus()
            WidgetRefresher.refreshAll(getApplication())
        }
    }

    private fun launchWithConnection(block: suspend (Connection) -> Unit) {
        viewModelScope.launch {
            val connection = _state.value.connection
            if (connection.isConfigured) block(connection)
        }
    }

    fun toggleMic() = act("Mikrofon umgeschaltet") { PcctlApi.micToggle(it) }
    fun toggleOutput() = act("Wiedergabe umgeschaltet") { PcctlApi.outputToggle(it) }
    fun displayOff() = act("Monitore aus") { PcctlApi.displayOff(it) }
    fun displayOn() = act("Monitore an") { PcctlApi.displayOn(it) }
    fun rgbOff() = act("RGB aus") { PcctlApi.rgbOff(it) }
    fun rgbOn() = act("RGB an") { PcctlApi.rgbOn(it) }
    fun rgbColor(hex: String) = act("Farbe gesetzt") { PcctlApi.rgbColor(it, hex) }
    fun lock() = act("Gesperrt") { PcctlApi.lock(it) }
    fun powerOff() = act("Wird heruntergefahren") { PcctlApi.powerOff(it) }
    fun reboot() = act("Wird neu gestartet") { PcctlApi.reboot(it) }
    fun suspendPc() = act("Ruhezustand") { PcctlApi.suspendPc(it) }
    fun wake() = act("Magic Packet gesendet") { PcctlApi.wake(it) }
    fun setVolume(percent: Int) = act("Lautstärke $percent %") { PcctlApi.setVolume(it, percent) }
    fun media(command: String) = act("Medienbefehl") { PcctlApi.media(it, command) }
    fun runScene(id: String) = act("Szene ausgeführt") { PcctlApi.runScene(it, id) }
    fun setBrightness(percent: Int) = act("Helligkeit $percent %") { PcctlApi.setBrightness(it, percent) }

    fun schedule(action: String, minutes: Int) =
        act("In $minutes Minuten: $action") { PcctlApi.schedule(it, action, minutes) }

    fun cancelSchedule() = act("Zeitplan abgebrochen") { PcctlApi.cancelSchedule(it) }

    fun quitApp(pid: Int, force: Boolean = false) {
        viewModelScope.launch {
            val connection = _state.value.connection
            when (val result = PcctlApi.quitApp(connection, pid, force)) {
                is ApiResult.Success -> notify("Beendet")
                is ApiResult.Failure -> notify(result.message)
            }
            refreshApps()
        }
    }

    // ---------------------------------------------------------------- Claude

    fun startTask(prompt: String, cwd: String?) {
        viewModelScope.launch {
            val connection = _state.value.connection
            _state.update { it.copy(busy = true) }
            when (val result = PcctlApi.startTask(connection, prompt, cwd)) {
                is ApiResult.Success -> {
                    _state.update { it.copy(tasks = listOf(result.value) + it.tasks) }
                    notify("Aufgabe gestartet")
                }
                is ApiResult.Failure -> notify("Start fehlgeschlagen: ${result.message}")
            }
            _state.update { it.copy(busy = false) }
        }
    }

    fun cancelTask(id: String) = act("Aufgabe abgebrochen") { PcctlApi.cancelTask(it, id) }

    /** Wechselt die verfolgte Sitzung und lädt deren bisherigen Verlauf. */
    fun watchSession(sessionId: String) {
        viewModelScope.launch {
            val connection = _state.value.connection
            _state.update { it.copy(watchedSessionId = sessionId, sessionEvents = emptyList()) }

            PcctlApi.sessionHistory(connection, sessionId, 40).onSuccess { history ->
                _state.update { it.copy(sessionEvents = history) }
            }
            // Neu verbinden, damit der Agent das neue Protokoll verfolgt.
            reconnect()
        }
    }

    fun decideApproval(id: String, decision: String) {
        viewModelScope.launch {
            val connection = _state.value.connection
            PcctlApi.decideApproval(connection, id, decision)
            _state.update { current -> current.copy(approvals = current.approvals.filterNot { it.id == id }) }
        }
    }

    fun typeIntoEditor(text: String, submit: Boolean) {
        viewModelScope.launch {
            val connection = _state.value.connection
            _state.update { it.copy(busy = true) }
            when (val result = PcctlApi.typeIntoEditor(connection, text, submit)) {
                is ApiResult.Success -> notify("In den Editor getippt")
                // Ein abgelehnter Versuch ist der Normalfall, wenn der Fokus woanders liegt.
                is ApiResult.Failure -> notify(result.message)
            }
            _state.update { it.copy(busy = false) }
        }
    }

    // ---------------------------------------------------------------- Aufgaben-Inbox

    fun refreshInbox() {
        launchWithConnection { connection ->
            PcctlApi.inboxTasks(connection).onSuccess { list ->
                _state.update { it.copy(inboxTasks = list) }
            }
            PcctlApi.workMode(connection).onSuccess { mode ->
                _state.update { it.copy(workMode = mode.enabled) }
            }
        }
    }

    fun completeInbox(id: String) = inboxAct("Erledigt") { PcctlApi.completeInboxTask(it, id) }
    fun snoozeInbox(id: String) = inboxAct("Verschoben") { PcctlApi.snoozeInboxTask(it, id) }

    fun toggleWorkMode() {
        viewModelScope.launch {
            val connection = _state.value.connection
            val next = !_state.value.workMode
            if (!ensureDndAccess() && next) return@launch
            when (val result = PcctlApi.setWorkMode(connection, next)) {
                is ApiResult.Success -> {
                    _state.update { it.copy(workMode = result.value.enabled) }
                    applyLocalDnd(result.value.enabled)
                    notify(if (result.value.enabled) "Work-Mode an" else "Work-Mode aus")
                }
                is ApiResult.Failure -> notify(result.message)
            }
            WidgetRefresher.refreshAll(getApplication())
        }
    }

    fun transcript(id: String, onResult: (String) -> Unit) {
        launchWithConnection { connection ->
            PcctlApi.transcript(connection, id).onSuccess { payload ->
                onResult(payload.transcript ?: payload.body ?: "Kein Transkript")
            }
        }
    }

    fun clearDndPrompt() {
        _state.update { it.copy(needsDndAccess = false) }
    }

    private fun inboxAct(label: String, block: suspend (Connection) -> ApiResult<InboxTask>) {
        viewModelScope.launch {
            val connection = _state.value.connection
            when (val result = block(connection)) {
                is ApiResult.Success -> {
                    notify(label)
                    val task = result.value
                    _state.update { current ->
                        current.copy(
                            inboxTasks = listOf(task) + current.inboxTasks.filterNot { it.id == task.id },
                            activeInbox = if (task.status == "active") task else current.activeInbox,
                        )
                    }
                }
                is ApiResult.Failure -> notify("$label fehlgeschlagen: ${result.message}")
            }
            refreshInbox()
            WidgetRefresher.refreshAll(getApplication())
        }
    }

    private fun ensureDndAccess(): Boolean {
        val nm = getApplication<Application>().getSystemService(NotificationManager::class.java)
        if (nm.isNotificationPolicyAccessGranted) return true
        _state.update { it.copy(needsDndAccess = true) }
        return false
    }

    private fun applyLocalDnd(enabled: Boolean) {
        val nm = getApplication<Application>().getSystemService(NotificationManager::class.java)
        if (!nm.isNotificationPolicyAccessGranted) return
        nm.setInterruptionFilter(
            if (enabled) NotificationManager.INTERRUPTION_FILTER_PRIORITY
            else NotificationManager.INTERRUPTION_FILTER_ALL,
        )
    }

    // ---------------------------------------------------------------- Meldungen

    private fun notify(message: String) {
        _state.update { it.copy(message = message) }
    }

    fun clearMessage() {
        _state.update { it.copy(message = null) }
    }
}
