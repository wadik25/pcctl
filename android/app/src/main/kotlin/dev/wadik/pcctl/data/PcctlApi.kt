package dev.wadik.pcctl.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * Zugriff auf den Agent.
 *
 * Bewusst schlank gehalten: eine Methode je Endpunkt, alle liefern ApiResult,
 * damit die Oberfläche Fehler anzeigen kann, statt abzustürzen. Im Heimnetz
 * sind kurze Zeitgrenzen richtig – eine Aktion, die drei Sekunden braucht,
 * ist ohnehin fehlgeschlagen.
 */
object PcctlApi {

    private val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
        explicitNulls = false
    }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS) // Monitorerkennung darf länger dauern
        .writeTimeout(5, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    val httpClient: OkHttpClient get() = client
    val jsonFormat: Json get() = json

    private suspend fun request(
        connection: Connection,
        path: String,
        method: String = "GET",
        body: String? = null,
    ): ApiResult<String> = withContext(Dispatchers.IO) {
        if (!connection.isConfigured) {
            return@withContext ApiResult.Failure("Keine Verbindung eingerichtet")
        }

        val requestBody = when {
            body != null -> body.toRequestBody(jsonMediaType)
            method != "GET" -> "{}".toRequestBody(jsonMediaType) // POST braucht einen Rumpf
            else -> null
        }

        val request = Request.Builder()
            .url("${connection.baseUrl}$path")
            .header("Authorization", "Bearer ${connection.token}")
            .method(method, requestBody)
            .build()

        try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (response.isSuccessful) {
                    ApiResult.Success(text)
                } else {
                    // Der Agent liefert Fehler als {"error":"..."} – das ist die
                    // aussagekräftigste Meldung für die Oberfläche.
                    val message = runCatching {
                        json.parseToJsonElement(text).let { element ->
                            (element as? JsonObject)?.get("error")?.toString()?.trim('"')
                        }
                    }.getOrNull() ?: "HTTP ${response.code}"
                    ApiResult.Failure(message)
                }
            }
        } catch (e: SocketTimeoutException) {
            ApiResult.Failure("Zeitüberschreitung – reagiert der Rechner noch?")
        } catch (e: IOException) {
            ApiResult.Failure("Nicht erreichbar: ${e.message ?: "Netzwerkfehler"}")
        }
    }

    private suspend inline fun <reified T> get(connection: Connection, path: String): ApiResult<T> =
        when (val result = request(connection, path)) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> runCatching { ApiResult.Success(json.decodeFromString<T>(result.value)) }
                .getOrElse { ApiResult.Failure("Antwort nicht lesbar: ${it.message}") }
        }

    private suspend inline fun <reified T> post(
        connection: Connection,
        path: String,
        body: String? = null,
    ): ApiResult<T> =
        when (val result = request(connection, path, "POST", body)) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> runCatching { ApiResult.Success(json.decodeFromString<T>(result.value)) }
                .getOrElse { ApiResult.Failure("Antwort nicht lesbar: ${it.message}") }
        }

    /** Aktionen, deren Antwort nicht ausgewertet wird. */
    private suspend fun fire(connection: Connection, path: String, body: String? = null): ApiResult<Unit> =
        when (val result = request(connection, path, "POST", body)) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> ApiResult.Success(Unit)
        }

    // ---------------------------------------------------------------- Status

    suspend fun ping(connection: Connection): ApiResult<Unit> =
        when (val result = request(connection, "/api/ping")) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> ApiResult.Success(Unit)
        }

    suspend fun status(connection: Connection): ApiResult<SystemStatus> =
        get(connection, "/api/status")

    suspend fun compactStats(connection: Connection): ApiResult<CompactStats> =
        get(connection, "/api/stats/compact")

    suspend fun fullStats(connection: Connection): ApiResult<FullStats> =
        get(connection, "/api/stats")

    // ---------------------------------------------------------------- Energie

    suspend fun powerOff(connection: Connection) = fire(connection, "/api/power/poweroff")
    suspend fun reboot(connection: Connection) = fire(connection, "/api/power/reboot")
    suspend fun suspendPc(connection: Connection) = fire(connection, "/api/power/suspend")
    suspend fun lock(connection: Connection) = fire(connection, "/api/power/lock")

    suspend fun schedule(connection: Connection, action: String, minutes: Int): ApiResult<ScheduledAction> =
        post(connection, "/api/power/schedule", """{"action":"$action","minutes":$minutes}""")

    suspend fun cancelSchedule(connection: Connection): ApiResult<Unit> =
        when (val result = request(connection, "/api/power/scheduled", "DELETE")) {
            is ApiResult.Failure -> result
            is ApiResult.Success -> ApiResult.Success(Unit)
        }

    // ---------------------------------------------------------------- Monitore

    suspend fun displayOff(connection: Connection) = fire(connection, "/api/display/off")
    suspend fun displayOn(connection: Connection) = fire(connection, "/api/display/on")
    suspend fun displayToggle(connection: Connection) = fire(connection, "/api/display/toggle")

    suspend fun setBrightness(connection: Connection, percent: Int) =
        fire(connection, "/api/display/brightness", """{"percent":$percent}""")

    // ---------------------------------------------------------------- RGB

    suspend fun rgbOff(connection: Connection) = fire(connection, "/api/rgb/off")
    suspend fun rgbOn(connection: Connection) = fire(connection, "/api/rgb/on")
    suspend fun rgbToggle(connection: Connection) = fire(connection, "/api/rgb/toggle")

    suspend fun rgbColor(connection: Connection, hex: String) =
        fire(connection, "/api/rgb/color", """{"color":"$hex"}""")

    // ---------------------------------------------------------------- Audio

    suspend fun micToggle(connection: Connection): ApiResult<AudioChannel> =
        post(connection, "/api/audio/mic/toggle")

    suspend fun outputToggle(connection: Connection): ApiResult<AudioChannel> =
        post(connection, "/api/audio/output/toggle")

    suspend fun setVolume(connection: Connection, percent: Int) =
        fire(connection, "/api/audio/volume", """{"percent":$percent,"target":"output"}""")

    suspend fun media(connection: Connection, command: String) =
        fire(connection, "/api/audio/media/$command")

    // ---------------------------------------------------------------- Apps

    suspend fun apps(connection: Connection): ApiResult<AppList> = get(connection, "/api/apps")

    suspend fun quitApp(connection: Connection, pid: Int, force: Boolean = false) =
        fire(connection, "/api/apps/$pid/quit", """{"force":$force}""")

    // ---------------------------------------------------------------- Szenen

    suspend fun scenes(connection: Connection): ApiResult<List<SceneSummary>> = get(connection, "/api/scenes")

    suspend fun runScene(connection: Connection, id: String) = fire(connection, "/api/scenes/$id/run")

    // ---------------------------------------------------------------- Wake-on-LAN

    suspend fun wolStatus(connection: Connection): ApiResult<WolStatus> = get(connection, "/api/wol")
    suspend fun wake(connection: Connection) = fire(connection, "/api/wol/wake")

    // ---------------------------------------------------------------- Claude

    suspend fun claudeSessions(connection: Connection): ApiResult<List<ClaudeSession>> =
        get(connection, "/api/claude/sessions")

    suspend fun sessionHistory(connection: Connection, id: String, limit: Int = 50): ApiResult<List<SessionEvent>> =
        get(connection, "/api/claude/sessions/$id/history?limit=$limit")

    suspend fun claudeTasks(connection: Connection): ApiResult<List<ClaudeTask>> =
        get(connection, "/api/claude/tasks")

    suspend fun startTask(
        connection: Connection,
        prompt: String,
        cwd: String? = null,
        permissionMode: String = "acceptEdits",
    ): ApiResult<ClaudeTask> {
        val escapedPrompt = json.encodeToString(kotlinx.serialization.serializer<String>(), prompt)
        val cwdPart = cwd?.let { ""","cwd":${json.encodeToString(kotlinx.serialization.serializer<String>(), it)}""" }.orEmpty()
        return post(
            connection,
            "/api/claude/tasks",
            """{"prompt":$escapedPrompt,"permissionMode":"$permissionMode"$cwdPart}""",
        )
    }

    suspend fun cancelTask(connection: Connection, id: String) =
        fire(connection, "/api/claude/tasks/$id/cancel")

    suspend fun approvals(connection: Connection): ApiResult<String> =
        request(connection, "/api/claude/approvals")

    suspend fun decideApproval(connection: Connection, id: String, decision: String) =
        fire(connection, "/api/claude/approvals/$id/decide", """{"decision":"$decision"}""")

    suspend fun typeIntoEditor(connection: Connection, text: String, submit: Boolean): ApiResult<String> {
        val escaped = json.encodeToString(kotlinx.serialization.serializer<String>(), text)
        return request(
            connection,
            "/api/claude/input",
            "POST",
            """{"text":$escaped,"submit":$submit}""",
        )
    }

    suspend fun inputReadiness(connection: Connection): ApiResult<String> =
        request(connection, "/api/claude/input/readiness")

    // ---------------------------------------------------------------- Aufgaben-Inbox

    suspend fun inboxTasks(connection: Connection, status: String? = null): ApiResult<List<InboxTask>> {
        val suffix = status?.let { "?status=$it" }.orEmpty()
        return get(connection, "/api/tasks$suffix")
    }

    suspend fun inboxViews(connection: Connection): ApiResult<TaskViews> = get(connection, "/api/tasks/views")

    suspend fun activeInbox(connection: Connection): ApiResult<String> = request(connection, "/api/tasks/active")

    suspend fun startInboxTask(connection: Connection, id: String): ApiResult<InboxTask> =
        post(connection, "/api/tasks/$id/start")

    suspend fun pauseInboxTask(connection: Connection, id: String): ApiResult<InboxTask> =
        post(connection, "/api/tasks/$id/pause")

    suspend fun completeInboxTask(connection: Connection, id: String): ApiResult<InboxTask> =
        post(connection, "/api/tasks/$id/complete")

    suspend fun snoozeInboxTask(connection: Connection, id: String): ApiResult<InboxTask> =
        post(connection, "/api/tasks/$id/snooze", """{"hours":4}""")

    suspend fun dropInboxTask(connection: Connection, id: String): ApiResult<InboxTask> =
        post(connection, "/api/tasks/$id/drop")

    suspend fun toggleInboxStep(connection: Connection, id: String): ApiResult<InboxTask> =
        post(connection, "/api/tasks/steps/$id/toggle")

    suspend fun transcript(connection: Connection, id: String): ApiResult<TranscriptPayload> =
        get(connection, "/api/tasks/$id/transcript")

    suspend fun workMode(connection: Connection): ApiResult<WorkModeState> = get(connection, "/api/workmode")

    suspend fun setWorkMode(connection: Connection, enabled: Boolean): ApiResult<WorkModeState> =
        post(connection, "/api/workmode", """{"enabled":$enabled}""")

    /** Für Widgets: Verbindungsdaten selbst laden und eine Aktion auslösen. */
    suspend fun fireFromWidget(context: Context, path: String): ApiResult<Unit> {
        val connection = Settings.connection(context)
        return fire(connection, path)
    }
}
