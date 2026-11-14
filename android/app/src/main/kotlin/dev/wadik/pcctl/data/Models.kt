package dev.wadik.pcctl.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Gegenstücke zu den Antworten des Agents.
 *
 * Alle Felder, die der Agent als null liefern kann (Sensoren, die es auf einem
 * anderen Rechner nicht gibt), sind hier bewusst nullable. So bleibt die App
 * auch dann bedienbar, wenn einzelne Werte fehlen.
 */

@Serializable
data class CompactStats(
    val timestamp: Long = 0,
    val cpuTempC: Double? = null,
    val cpuUsagePercent: Double? = null,
    val gpuTempC: Double? = null,
    val gpuUsagePercent: Double? = null,
    val memoryUsagePercent: Double? = null,
    val uptimeSeconds: Long? = null,
)

@Serializable
data class CpuStats(
    val usagePercent: Double? = null,
    val temps: Map<String, Double> = emptyMap(),
    val frequencyMhz: Double? = null,
    val cores: Int = 0,
)

@Serializable
data class GpuStats(
    val tempC: Double? = null,
    val powerW: Double? = null,
    val powerCapW: Double? = null,
    val fanRpm: Double? = null,
    val usagePercent: Double? = null,
    val vramUsedBytes: Long? = null,
    val vramTotalBytes: Long? = null,
    val vramPercent: Double? = null,
    val coreClockMhz: Double? = null,
    val memClockMhz: Double? = null,
)

@Serializable
data class MemoryStats(
    val totalBytes: Long = 0,
    val usedBytes: Long = 0,
    val availableBytes: Long = 0,
    val usagePercent: Double? = null,
    val swapTotalBytes: Long = 0,
    val swapUsedBytes: Long = 0,
)

@Serializable
data class DiskTemp(val name: String, val tempC: Double)

@Serializable
data class NetworkInterface(
    val name: String,
    val rxBytes: Long = 0,
    val txBytes: Long = 0,
    val rxRateBps: Long? = null,
    val txRateBps: Long? = null,
    val up: Boolean = false,
)

@Serializable
data class FullStats(
    val timestamp: Long = 0,
    val cpu: CpuStats = CpuStats(),
    val gpu: GpuStats = GpuStats(),
    val memory: MemoryStats? = null,
    val disks: List<DiskTemp> = emptyList(),
    val network: List<NetworkInterface> = emptyList(),
    val uptimeSeconds: Long? = null,
    val loadAverage: List<Double>? = null,
)

// ---------------------------------------------------------------- Audio

@Serializable
data class AudioChannel(
    val volume: Int? = null,
    val muted: Boolean? = null,
    val available: Boolean = false,
)

@Serializable
data class AudioStatus(
    val microphone: AudioChannel = AudioChannel(),
    val output: AudioChannel = AudioChannel(),
)

// ---------------------------------------------------------------- Monitore / RGB

@Serializable
data class DisplayInfo(val bus: Int, val model: String, val serial: String? = null)

@Serializable
data class DisplayStatus(
    val available: Boolean = false,
    val displays: List<DisplayInfo> = emptyList(),
    val blanked: Boolean = false,
    val mode: String = "brightness",
    val changedAt: Long = 0,
)

@Serializable
data class RgbStatus(
    val available: Boolean = false,
    val deviceCount: Int = 0,
    val devices: List<String> = emptyList(),
    val on: Boolean = false,
    val color: String = "FFFFFF",
    val note: String? = null,
)

// ---------------------------------------------------------------- Energie

@Serializable
data class PowerCapabilities(
    val poweroff: String = "no",
    val reboot: String = "no",
    val suspend: String = "no",
)

@Serializable
data class ScheduledAction(
    val id: String,
    val action: String,
    val firesAt: Long,
    val remainingSeconds: Long,
)

@Serializable
data class PowerStatus(
    val capabilities: PowerCapabilities = PowerCapabilities(),
    val scheduled: ScheduledAction? = null,
)

// ---------------------------------------------------------------- Szenen / Apps

@Serializable
data class SceneSummary(
    val id: String,
    val name: String,
    val icon: String = "bolt",
    val description: String? = null,
)

@Serializable
data class AppEntry(
    val pid: Int,
    val name: String,
    val title: String? = null,
    val windowId: Long? = null,
    val memoryBytes: Long = 0,
    val cpuSeconds: Long = 0,
    @SerialName("protected") val isProtected: Boolean = false,
)

@Serializable
data class AppList(val source: String = "processes", val apps: List<AppEntry> = emptyList())

// ---------------------------------------------------------------- Wake-on-LAN

@Serializable
data class WolInterface(
    val name: String,
    val carrier: Boolean = false,
    val mac: String? = null,
    val wired: Boolean = false,
)

@Serializable
data class WolStatus(
    val interfaces: List<WolInterface> = emptyList(),
    val ready: Boolean = false,
    val note: String = "",
)

// ---------------------------------------------------------------- Claude

@Serializable
data class ClaudeSession(
    val id: String,
    val project: String,
    val title: String? = null,
    val lastActivity: Long = 0,
    val sizeBytes: Long = 0,
)

@Serializable
data class ContentBlock(
    val type: String = "",
    val text: String? = null,
    val name: String? = null,
    val thinking: String? = null,
)

@Serializable
data class SessionEvent(
    val uuid: String = "",
    val type: String = "",
    val role: String = "",
    val timestamp: Long = 0,
    val blocks: List<ContentBlock> = emptyList(),
    val model: String? = null,
)

@Serializable
data class ClaudeTask(
    val id: String,
    val sessionId: String,
    val prompt: String,
    val cwd: String,
    val status: String,
    val startedAt: Long,
    val endedAt: Long? = null,
    val exitCode: Int? = null,
    val resultText: String? = null,
    val error: String? = null,
)

@Serializable
data class ApprovalRequest(
    val id: String,
    val sessionId: String = "",
    val toolName: String = "",
    val toolInput: JsonElement? = null,
    val cwd: String = "",
    val createdAt: Long = 0,
    val expiresAt: Long = 0,
)

@Serializable
data class ClaudeSummary(val runningTasks: Int = 0, val pendingApprovals: Int = 0)

@Serializable
data class GnomeBridgeStatus(val available: Boolean = false, val windowCount: Int = 0)

@Serializable
data class WorkModeState(val enabled: Boolean = false, val changedAt: Long = 0)

@Serializable
data class WhatsAppStatus(
    val state: String = "disconnected",
    val qr: String? = null,
    val me: String? = null,
    val error: String? = null,
)

@Serializable
data class InboxStep(
    val id: String,
    val taskId: String = "",
    val title: String = "",
    val done: Boolean = false,
    val position: Int = 0,
)

@Serializable
data class InboxTask(
    val id: String,
    val messageId: String? = null,
    val title: String,
    val context: String = "",
    val priority: String = "MEDIUM",
    val estimatedMinutes: Int = 15,
    val suggestedSlot: String = "GEPLANT_SPAETER",
    val canUseAi: Boolean = false,
    val recommendedTool: String = "Manuell",
    val workflowHint: String = "",
    val isVoiceMessage: Boolean = false,
    val status: String = "inbox",
    val snoozedUntil: Long? = null,
    val elapsedSeconds: Int = 0,
    val senderName: String? = null,
    val chatJid: String? = null,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val startedAt: Long? = null,
    val completedAt: Long? = null,
    val steps: List<InboxStep> = emptyList(),
)

@Serializable
data class TaskViews(
    val quickWins: List<InboxTask> = emptyList(),
    val focusBlocks: List<InboxTask> = emptyList(),
    val later: List<InboxTask> = emptyList(),
)

@Serializable
data class InboxSummary(val open: Int = 0, val active: InboxTask? = null)

@Serializable
data class TranscriptPayload(
    val task: InboxTask,
    val transcript: String? = null,
    val body: String? = null,
    val senderName: String? = null,
    val receivedAt: Long? = null,
)

// ---------------------------------------------------------------- Gesamtstatus

@Serializable
data class SystemStatus(
    val stats: CompactStats = CompactStats(),
    val audio: AudioStatus = AudioStatus(),
    val display: DisplayStatus = DisplayStatus(),
    val rgb: RgbStatus = RgbStatus(),
    val power: PowerStatus = PowerStatus(),
    val scenes: List<SceneSummary> = emptyList(),
    val gnomeBridge: GnomeBridgeStatus = GnomeBridgeStatus(),
    val claude: ClaudeSummary = ClaudeSummary(),
    val wol: WolStatus = WolStatus(),
    val workMode: WorkModeState = WorkModeState(),
    val whatsapp: WhatsAppStatus = WhatsAppStatus(),
    val inbox: InboxSummary = InboxSummary(),
)

/** Ergebnis eines Aufrufs – die Oberfläche unterscheidet nur Erfolg und Fehler. */
sealed interface ApiResult<out T> {
    data class Success<T>(val value: T) : ApiResult<T>
    data class Failure(val message: String) : ApiResult<Nothing>
}

inline fun <T> ApiResult<T>.onSuccess(block: (T) -> Unit): ApiResult<T> {
    if (this is ApiResult.Success) block(value)
    return this
}

inline fun <T> ApiResult<T>.onFailure(block: (String) -> Unit): ApiResult<T> {
    if (this is ApiResult.Failure) block(message)
    return this
}
