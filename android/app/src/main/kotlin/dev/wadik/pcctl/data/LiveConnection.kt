package dev.wadik.pcctl.data

import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * Live-Verbindung zum Agent.
 *
 * Der Agent schickt fortlaufend Kennzahlen und meldet Ereignisse (Aufgaben,
 * Genehmigungen, Sitzungsprotokolle). Die Verbindung wird als Flow angeboten;
 * bricht sie ab, schließt der Flow und die aufrufende Stelle verbindet neu.
 */
sealed interface LiveEvent {
    /**
     * Laufende Aktualisierung. Enthält neben den Kennzahlen auch die
     * Schaltzustände, damit Änderungen direkt am Rechner in der App ankommen.
     * Die Zusatzfelder können fehlen, wenn der Agent sie gerade nicht ermitteln konnte.
     */
    data class Live(
        val stats: CompactStats,
        val audio: AudioStatus? = null,
        val display: DisplayStatus? = null,
        val rgb: RgbStatus? = null,
    ) : LiveEvent
    data class TaskEvent(val taskId: String, val raw: JsonObject) : LiveEvent
    data class TaskStatus(val task: ClaudeTask) : LiveEvent
    data class ApprovalRequested(val request: ApprovalRequest) : LiveEvent
    data class ApprovalResolved(val id: String) : LiveEvent
    data class SessionMessage(val sessionId: String, val event: SessionEvent) : LiveEvent
    data class InboxCreated(val task: InboxTask) : LiveEvent
    data class InboxUpdated(val task: InboxTask) : LiveEvent
    data class ActiveTick(val task: InboxTask, val elapsedSeconds: Int) : LiveEvent
    data class WorkModeChanged(val enabled: Boolean) : LiveEvent
    data object Connected : LiveEvent
    data class Disconnected(val reason: String) : LiveEvent
}

class LiveConnection(private val json: Json = PcctlApi.jsonFormat) {

    /**
     * Öffnet die Verbindung und liefert alle eintreffenden Ereignisse.
     * Über [watchSessionId] wird zusätzlich ein Sitzungsprotokoll mitgelesen.
     */
    fun connect(connection: Connection, watchSessionId: String? = null): Flow<LiveEvent> = callbackFlow {
        if (!connection.isConfigured) {
            trySend(LiveEvent.Disconnected("Keine Verbindung eingerichtet"))
            close()
            return@callbackFlow
        }

        val request = Request.Builder().url(connection.webSocketUrl).build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                trySend(LiveEvent.Connected)
                watchSessionId?.let {
                    webSocket.send("""{"action":"watchSession","sessionId":"$it"}""")
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val message = runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
                val type = message["type"]?.jsonPrimitive?.content ?: return
                val payload = message["payload"]

                runCatching {
                    when (type) {
                        // "hello" kommt einmal beim Verbinden, "live" fortlaufend –
                        // beide tragen die Kennzahlen im Feld "stats".
                        "live", "hello" -> {
                            val obj = payload as? JsonObject ?: return
                            val statsElement = obj["stats"] ?: return
                            trySend(
                                LiveEvent.Live(
                                    stats = json.decodeFromJsonElement(CompactStats.serializer(), statsElement),
                                    audio = obj["audio"]?.let {
                                        json.decodeFromJsonElement(AudioStatus.serializer(), it)
                                    },
                                    display = obj["display"]?.let {
                                        json.decodeFromJsonElement(DisplayStatus.serializer(), it)
                                    },
                                    rgb = obj["rgb"]?.let {
                                        json.decodeFromJsonElement(RgbStatus.serializer(), it)
                                    },
                                ),
                            )
                        }

                        "taskEvent" -> {
                            val obj = payload as? JsonObject ?: return
                            val taskId = obj["taskId"]?.jsonPrimitive?.content ?: return
                            val event = obj["event"] as? JsonObject ?: return
                            trySend(LiveEvent.TaskEvent(taskId, event))
                        }

                        "taskStatus" -> {
                            payload ?: return
                            trySend(LiveEvent.TaskStatus(json.decodeFromJsonElement(ClaudeTask.serializer(), payload)))
                        }

                        "approvalRequested" -> {
                            payload ?: return
                            trySend(
                                LiveEvent.ApprovalRequested(
                                    json.decodeFromJsonElement(ApprovalRequest.serializer(), payload),
                                ),
                            )
                        }

                        "approvalDecided", "approvalExpired" -> {
                            val id = (payload as? JsonObject)?.get("id")?.jsonPrimitive?.content ?: return
                            trySend(LiveEvent.ApprovalResolved(id))
                        }

                        "sessionEvent" -> {
                            val obj = payload as? JsonObject ?: return
                            val sessionId = obj["sessionId"]?.jsonPrimitive?.content ?: return
                            val event = obj["event"] ?: return
                            trySend(
                                LiveEvent.SessionMessage(
                                    sessionId,
                                    json.decodeFromJsonElement(SessionEvent.serializer(), event),
                                ),
                            )
                        }

                        "taskCreated" -> {
                            payload ?: return
                            trySend(LiveEvent.InboxCreated(json.decodeFromJsonElement(InboxTask.serializer(), payload)))
                        }

                        "taskUpdated", "taskEnriched" -> {
                            payload ?: return
                            trySend(LiveEvent.InboxUpdated(json.decodeFromJsonElement(InboxTask.serializer(), payload)))
                        }

                        "activeTaskTick" -> {
                            val obj = payload as? JsonObject ?: return
                            val task = obj["task"] ?: return
                            val elapsed = obj["elapsedSeconds"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0
                            trySend(
                                LiveEvent.ActiveTick(
                                    json.decodeFromJsonElement(InboxTask.serializer(), task),
                                    elapsed,
                                ),
                            )
                        }

                        "workModeChanged" -> {
                            val enabled = (payload as? JsonObject)?.get("enabled")?.jsonPrimitive?.boolean == true
                            trySend(LiveEvent.WorkModeChanged(enabled))
                        }
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                trySend(LiveEvent.Disconnected(t.message ?: "Verbindung verloren"))
                close()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                trySend(LiveEvent.Disconnected(reason.ifBlank { "Verbindung geschlossen" }))
                close()
            }
        }

        val socket = PcctlApi.httpClient.newWebSocket(request, listener)
        awaitClose { socket.close(1000, "App beendet die Verbindung") }
    }
}
