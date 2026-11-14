package dev.wadik.pcctl.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.glance.*
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.*
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.background
import androidx.glance.layout.*
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.wadik.pcctl.R
import dev.wadik.pcctl.data.ApiResult
import dev.wadik.pcctl.data.PcctlApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Homescreen-Widgets.
 *
 * Jeder Knopf löst unmittelbar eine Aktion aus, ohne die App zu öffnen –
 * das ist der eigentliche Zweck. Nach jeder Aktion wird der Zustand neu
 * geholt, damit etwa das Mikrofonsymbol sofort stimmt.
 *
 * Alle Widgets passen ihren Inhalt an die vom Nutzer gezogene Größe an. Statt
 * bei einem großen Widget unten leeren Raum zu lassen, kommen weitere Reihen
 * hinzu.
 */

internal val widgetClasses = listOf(
    ActionWidget::class.java,
    StatsWidget::class.java,
    SceneWidget::class.java,
    TaskWidget::class.java,
    WorkModeWidget::class.java,
)

// ---------------------------------------------------------------- Farben

private val Surface = ColorProvider(Color(0xF20E1116))
private val Tile = ColorProvider(Color(0xFF1C222B))
private val TileStrong = ColorProvider(Color(0xFF262D37))
private val OnSurface = ColorProvider(Color(0xFFE3E6EA))
private val Muted = ColorProvider(Color(0xFF8A94A3))
private val Track = ColorProvider(Color(0xFF2A323D))
private val Accent = ColorProvider(Color(0xFF4DD8E6))
private val Danger = ColorProvider(Color(0xFFF87171))
private val Warn = ColorProvider(Color(0xFFFBBF24))
private val Ok = ColorProvider(Color(0xFF4ADE80))

// ---------------------------------------------------------------- Aktionen

/**
 * Führt eine Aktion aus. Der Pfad kommt als Parameter, damit ein einziger
 * Rückruf für alle Knöpfe genügt.
 */
class RunActionCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val path = parameters[pathKey] ?: return
        PcctlApi.fireFromWidget(context, path)
        // Zustand nachziehen, sonst zeigt das Widget den alten Stand.
        refreshWidgetState(context)
        updateAllWidgets(context)
    }

    companion object {
        val pathKey = ActionParameters.Key<String>("path")
    }
}

/** Reines Aktualisieren ohne Aktion. */
class RefreshCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        refreshWidgetState(context)
        updateAllWidgets(context)
    }
}

private suspend fun updateAllWidgets(context: Context) {
    ActionWidget().updateAll(context)
    StatsWidget().updateAll(context)
    SceneWidget().updateAll(context)
    TaskWidget().updateAll(context)
    WorkModeWidget().updateAll(context)
}

/** Von der App aufgerufen, wenn sich der Zustand geändert hat. */
object WidgetRefresher {
    fun refreshAll(context: Context) {
        CoroutineScope(Dispatchers.IO).launch {
            refreshWidgetState(context)
            updateAllWidgets(context)
        }
    }
}

/**
 * Gemeinsame Grundlage der Empfänger.
 *
 * Android ruft onUpdate beim Hinzufügen eines Widgets und danach im Takt von
 * updatePeriodMillis auf. Ohne eigenes Zutun hätte Glance dabei keine Daten –
 * deshalb wird hier der Zustand vom Rechner geholt. Sonst stünde nach dem
 * Ablegen auf dem Startbildschirm dauerhaft „Nicht erreichbar“.
 */
abstract class RefreshingWidgetReceiver : GlanceAppWidgetReceiver() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: android.appwidget.AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetRefresher.refreshAll(context)
    }
}

// ---------------------------------------------------------------- Bausteine

/**
 * Aktionsknopf mit Symbol und Beschriftung.
 *
 * Der aktive Zustand färbt Symbol und Hintergrund ein – so ist auf einen Blick
 * erkennbar, ob das Mikrofon stumm oder die Beleuchtung an ist.
 */
@Composable
private fun IconAction(
    icon: Int,
    label: String,
    path: String,
    modifier: GlanceModifier = GlanceModifier,
    active: Boolean = false,
    activeColor: ColorProvider = Accent,
    compact: Boolean = false,
    available: Boolean = true,
) {
    // Fehlt die Voraussetzung auf dem Rechner, darf der Knopf nicht als
    // eingeschaltet leuchten – der Zustand dahinter gilt dann gar nicht.
    val active = active && available
    val iconTint = when {
        active -> Surface
        available -> OnSurface
        else -> Muted
    }

    Column(
        modifier = modifier
            .background(if (active) activeColor else Tile)
            .cornerRadius(16.dp)
            .clickable(
                actionRunCallback<RunActionCallback>(
                    actionParametersOf(RunActionCallback.pathKey to path),
                ),
            )
            .padding(vertical = if (compact) 6.dp else 8.dp, horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            provider = ImageProvider(icon),
            contentDescription = label,
            colorFilter = ColorFilter.tint(iconTint),
            modifier = GlanceModifier.size(if (compact) 18.dp else 20.dp),
        )
        if (!compact) {
            Spacer(GlanceModifier.height(3.dp))
            Text(
                label,
                style = TextStyle(
                    color = if (active) Surface else Muted,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Medium,
                    textAlign = TextAlign.Center,
                ),
                maxLines = 1,
            )
        }
    }
}

/** Kennzahl mit Balken. */
@Composable
private fun StatColumn(
    label: String,
    value: String,
    detail: String?,
    color: ColorProvider,
    progress: Float?,
    modifier: GlanceModifier = GlanceModifier,
    showBar: Boolean = true,
) {
    Column(modifier = modifier.padding(end = 10.dp)) {
        Text(label, style = TextStyle(color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Medium))
        Spacer(GlanceModifier.height(2.dp))
        Text(value, style = TextStyle(color = color, fontSize = 24.sp, fontWeight = FontWeight.Bold))

        if (showBar && progress != null) {
            Spacer(GlanceModifier.height(5.dp))
            LinearProgressIndicator(
                progress = progress.coerceIn(0f, 1f),
                modifier = GlanceModifier.fillMaxWidth().height(4.dp).cornerRadius(2.dp),
                color = color,
                backgroundColor = Track,
            )
        }

        if (detail != null) {
            Spacer(GlanceModifier.height(3.dp))
            Text(detail, style = TextStyle(color = Muted, fontSize = 10.sp))
        }
    }
}

@Composable
private fun WidgetHeader(uptime: String, modifier: GlanceModifier = GlanceModifier) {
    Row(
        modifier = modifier.fillMaxWidth().clickable(actionRunCallback<RefreshCallback>()),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Kleiner Punkt als Verbindungsanzeige – dass etwas angezeigt wird,
        // heißt bereits, dass der Rechner erreichbar war.
        Box(
            modifier = GlanceModifier.size(7.dp).background(Ok).cornerRadius(4.dp),
            content = {},
        )
        Spacer(GlanceModifier.width(7.dp))
        Text(
            "Rechner",
            style = TextStyle(color = OnSurface, fontSize = 12.sp, fontWeight = FontWeight.Medium),
            modifier = GlanceModifier.defaultWeight(),
        )
        if (uptime.isNotBlank()) {
            Text(uptime, style = TextStyle(color = Muted, fontSize = 11.sp))
        }
    }
}

@Composable
private fun OfflineNotice(error: String) {
    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            .background(Surface)
            .cornerRadius(24.dp)
            .padding(14.dp)
            .clickable(actionRunCallback<RefreshCallback>()),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Image(
            provider = ImageProvider(R.drawable.ic_refresh),
            contentDescription = null,
            colorFilter = ColorFilter.tint(Danger),
            modifier = GlanceModifier.size(22.dp),
        )
        Spacer(GlanceModifier.height(6.dp))
        Text(
            "Nicht erreichbar",
            style = TextStyle(color = Danger, fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        if (error.isNotBlank()) {
            Text(
                error.take(60),
                style = TextStyle(color = Muted, fontSize = 10.sp, textAlign = TextAlign.Center),
                maxLines = 2,
            )
        }
        Spacer(GlanceModifier.height(4.dp))
        Text("Tippen zum Neuversuch", style = TextStyle(color = Muted, fontSize = 10.sp))
    }
}

// ---------------------------------------------------------------- Zustandshilfen

private class WidgetState(private val prefs: Preferences) {
    val online = prefs[WidgetKeys.online] ?: false
    val error = prefs[WidgetKeys.lastError].orEmpty()
    val micMuted = prefs[WidgetKeys.micMuted] ?: false
    val displayBlanked = prefs[WidgetKeys.displayBlanked] ?: false
    val rgbOn = prefs[WidgetKeys.rgbOn] ?: false
    val displayAvailable = prefs[WidgetKeys.displayAvailable] ?: false
    val rgbAvailable = prefs[WidgetKeys.rgbAvailable] ?: false
    val cpuTemp = prefs[WidgetKeys.cpuTemp] ?: "–"
    val gpuTemp = prefs[WidgetKeys.gpuTemp] ?: "–"
    val cpuUsage = prefs[WidgetKeys.cpuUsage] ?: "–"
    val gpuUsage = prefs[WidgetKeys.gpuUsage] ?: "–"
    val memoryUsage = prefs[WidgetKeys.memoryUsage] ?: "–"
    val uptime = formatUptimeShort(prefs[WidgetKeys.uptime])

    val scenes: List<Pair<String, String>> = prefs[WidgetKeys.scenesJson]
        .orEmpty()
        .lines()
        .filter { it.isNotBlank() }
        .mapNotNull { line ->
            val parts = line.split("|")
            if (parts.size >= 2) parts[0] to parts[1] else null
        }
}

private fun tempColor(value: String?): ColorProvider {
    val temp = value?.toIntOrNull() ?: return Muted
    return when {
        temp >= 85 -> Danger
        temp >= 70 -> Warn
        else -> Ok
    }
}

private fun percentToFraction(value: String?): Float? = value?.toIntOrNull()?.let { it / 100f }

private fun formatUptimeShort(seconds: String?): String {
    val value = seconds?.toLongOrNull() ?: return ""
    val days = value / 86_400
    val hours = (value % 86_400) / 3600
    val minutes = (value % 3600) / 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes}min"
        else -> "${minutes}min"
    }
}

private fun sceneIcon(id: String): Int = when {
    id.contains("feierabend") -> R.drawable.ic_moon
    id.contains("meeting") -> R.drawable.ic_video
    id.contains("gaming") -> R.drawable.ic_gamepad
    id.contains("fokus") -> R.drawable.ic_target
    else -> R.drawable.ic_bolt
}

// ---------------------------------------------------------------- Aktionsreihen

/** Die wichtigsten Schalter. [count] begrenzt sie auf die verfügbare Breite. */
@Composable
private fun ControlRow(
    state: WidgetState,
    count: Int,
    modifier: GlanceModifier = GlanceModifier,
    compact: Boolean = false,
) {
    Row(modifier = modifier) {
        IconAction(
            icon = if (state.micMuted) R.drawable.ic_mic_off else R.drawable.ic_mic,
            label = if (state.micMuted) "Stumm" else "Mikro",
            path = "/api/audio/mic/toggle",
            active = state.micMuted,
            activeColor = Danger,
            compact = compact,
            modifier = GlanceModifier.defaultWeight().fillMaxHeight().padding(horizontal = 2.dp),
        )

        if (count >= 2) {
            IconAction(
                icon = if (state.displayBlanked) R.drawable.ic_monitor else R.drawable.ic_monitor_off,
                label = if (state.displayBlanked) "An" else "Monitor",
                path = if (state.displayBlanked) "/api/display/on" else "/api/display/off",
                active = state.displayBlanked,
                activeColor = Warn,
                compact = compact,
                available = state.displayAvailable,
                modifier = GlanceModifier.defaultWeight().fillMaxHeight().padding(horizontal = 2.dp),
            )
        }

        if (count >= 3) {
            IconAction(
                icon = R.drawable.ic_bulb,
                label = "RGB",
                path = if (state.rgbOn) "/api/rgb/off" else "/api/rgb/on",
                active = state.rgbOn,
                activeColor = Warn,
                compact = compact,
                available = state.rgbAvailable,
                modifier = GlanceModifier.defaultWeight().fillMaxHeight().padding(horizontal = 2.dp),
            )
        }

        if (count >= 4) {
            IconAction(
                icon = R.drawable.ic_pause,
                label = "Pause",
                path = "/api/audio/media/PlayPause",
                compact = compact,
                modifier = GlanceModifier.defaultWeight().fillMaxHeight().padding(horizontal = 2.dp),
            )
        }

        if (count >= 5) {
            IconAction(
                icon = R.drawable.ic_lock,
                label = "Sperren",
                path = "/api/power/lock",
                compact = compact,
                modifier = GlanceModifier.defaultWeight().fillMaxHeight().padding(horizontal = 2.dp),
            )
        }
    }
}

@Composable
private fun SceneRow(state: WidgetState, count: Int, modifier: GlanceModifier = GlanceModifier) {
    Row(modifier = modifier) {
        state.scenes.take(count).forEach { (id, name) ->
            IconAction(
                icon = sceneIcon(id),
                label = name,
                path = "/api/scenes/$id/run",
                modifier = GlanceModifier.defaultWeight().fillMaxHeight().padding(horizontal = 2.dp),
            )
        }
    }
}

// ---------------------------------------------------------------- Hauptwidget

/**
 * Kennzahlen und Bedienung in einem. Je höher das Widget gezogen wird, desto
 * mehr Reihen erscheinen – kein leerer Raum am unteren Rand.
 */
class StatsWidget : GlanceAppWidget() {

    override val stateDefinition = PreferencesGlanceStateDefinition

    override val sizeMode = SizeMode.Responsive(
        setOf(
            DpSize(250.dp, 60.dp),   // nur Kennzahlen
            DpSize(250.dp, 120.dp),  // Kennzahlen + Schalter
            DpSize(250.dp, 250.dp),  // zusätzlich Szenen
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            GlanceTheme {
                val state = WidgetState(currentState())
                if (!state.online) {
                    OfflineNotice(state.error)
                    return@GlanceTheme
                }

                val size = LocalSize.current
                val showControls = size.height >= 110.dp
                // Erst ab dieser Höhe passen Schalter- und Szenenreihe samt
                // Beschriftung nebeneinander. Darunter bliebe der Text weg.
                val showScenes = size.height >= 240.dp && state.scenes.isNotEmpty()
                // Bei niedrigen Widgets würden Balken den Text erdrücken.
                val showBars = size.height >= 90.dp

                Column(
                    modifier = GlanceModifier
                        .fillMaxSize()
                        .background(Surface)
                        .cornerRadius(24.dp)
                        .padding(14.dp),
                ) {
                    WidgetHeader(state.uptime)
                    Spacer(GlanceModifier.height(10.dp))

                    Row(modifier = GlanceModifier.fillMaxWidth()) {
                        StatColumn(
                            label = "CPU",
                            value = "${state.cpuTemp}°",
                            detail = "${state.cpuUsage} % Last",
                            color = tempColor(state.cpuTemp),
                            progress = percentToFraction(state.cpuUsage),
                            showBar = showBars,
                            modifier = GlanceModifier.defaultWeight(),
                        )
                        StatColumn(
                            label = "GPU",
                            value = "${state.gpuTemp}°",
                            detail = "${state.gpuUsage} % Last",
                            color = tempColor(state.gpuTemp),
                            progress = percentToFraction(state.gpuUsage),
                            showBar = showBars,
                            modifier = GlanceModifier.defaultWeight(),
                        )
                        StatColumn(
                            label = "RAM",
                            value = "${state.memoryUsage} %",
                            detail = null,
                            color = Accent,
                            progress = percentToFraction(state.memoryUsage),
                            showBar = showBars,
                            modifier = GlanceModifier.defaultWeight(),
                        )
                    }

                    // Die Reihen brauchen mindestens 58dp, damit unter dem Symbol
                    // noch die Beschriftung Platz hat – sonst schneidet Glance den
                    // Text kommentarlos ab. Die jeweils letzte Reihe bekommt den
                    // Rest der Höhe, damit unten kein leerer Streifen bleibt.
                    if (showControls) {
                        Spacer(GlanceModifier.height(10.dp))
                        ControlRow(
                            state = state,
                            count = if (size.width >= 300.dp) 5 else 4,
                            modifier = if (showScenes) {
                                GlanceModifier.fillMaxWidth().height(58.dp)
                            } else {
                                GlanceModifier.fillMaxWidth().defaultWeight()
                            },
                        )
                    }

                    if (showScenes) {
                        Spacer(GlanceModifier.height(6.dp))
                        SceneRow(
                            state = state,
                            count = if (size.width >= 300.dp) 4 else 3,
                            modifier = GlanceModifier.fillMaxWidth().defaultWeight(),
                        )
                    }
                }
            }
        }
    }
}

class StatsWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = StatsWidget()
}

// ---------------------------------------------------------------- Aktions-Widget

/** Reine Schalterleiste, für schmale Plätze auf dem Startbildschirm. */
class ActionWidget : GlanceAppWidget() {

    override val stateDefinition = PreferencesGlanceStateDefinition

    override val sizeMode = SizeMode.Responsive(
        setOf(
            DpSize(60.dp, 60.dp),
            DpSize(140.dp, 60.dp),
            DpSize(250.dp, 60.dp),
            DpSize(250.dp, 130.dp),
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            GlanceTheme {
                val state = WidgetState(currentState())
                if (!state.online) {
                    OfflineNotice(state.error)
                    return@GlanceTheme
                }

                val size = LocalSize.current
                val perRow = when {
                    size.width >= 250.dp -> 4
                    size.width >= 140.dp -> 2
                    else -> 1
                }

                Column(
                    modifier = GlanceModifier
                        .fillMaxSize()
                        .background(Surface)
                        .cornerRadius(24.dp)
                        .padding(8.dp),
                ) {
                    ControlRow(
                        state = state,
                        count = perRow,
                        modifier = GlanceModifier.fillMaxWidth().defaultWeight(),
                    )

                    // Zweite Reihe mit Szenen, sobald genug Höhe da ist.
                    if (size.height >= 120.dp && state.scenes.isNotEmpty()) {
                        Spacer(GlanceModifier.height(6.dp))
                        SceneRow(
                            state = state,
                            count = perRow,
                            modifier = GlanceModifier.fillMaxWidth().defaultWeight(),
                        )
                    }
                }
            }
        }
    }
}

class ActionWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ActionWidget()
}

// ---------------------------------------------------------------- Szenen-Widget

class SceneWidget : GlanceAppWidget() {

    override val stateDefinition = PreferencesGlanceStateDefinition

    override val sizeMode = SizeMode.Responsive(
        setOf(
            DpSize(180.dp, 60.dp),
            DpSize(250.dp, 60.dp),
            DpSize(250.dp, 130.dp),
        ),
    )

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            GlanceTheme {
                val state = WidgetState(currentState())
                if (!state.online) {
                    OfflineNotice(state.error)
                    return@GlanceTheme
                }

                val size = LocalSize.current

                Column(
                    modifier = GlanceModifier
                        .fillMaxSize()
                        .background(Surface)
                        .cornerRadius(24.dp)
                        .padding(8.dp),
                ) {
                    if (state.scenes.isEmpty()) {
                        Box(GlanceModifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("Keine Szenen", style = TextStyle(color = Muted, fontSize = 12.sp))
                        }
                    } else {
                        SceneRow(
                            state = state,
                            count = if (size.width >= 250.dp) 4 else 3,
                            modifier = GlanceModifier.fillMaxWidth().defaultWeight(),
                        )

                        if (size.height >= 120.dp) {
                            Spacer(GlanceModifier.height(6.dp))
                            ControlRow(
                                state = state,
                                count = if (size.width >= 250.dp) 4 else 3,
                                modifier = GlanceModifier.fillMaxWidth().defaultWeight(),
                            )
                        }
                    }
                }
            }
        }
    }
}

class SceneWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = SceneWidget()
}

class CompleteInboxCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[taskIdKey] ?: return
        val connection = dev.wadik.pcctl.data.Settings.connection(context)
        PcctlApi.completeInboxTask(connection, id)
        refreshWidgetState(context)
        updateAllWidgets(context)
    }

    companion object {
        val taskIdKey = ActionParameters.Key<String>("taskId")
    }
}

class ToggleWorkModeCallback : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val connection = dev.wadik.pcctl.data.Settings.connection(context)
        val current = PcctlApi.workMode(connection)
        val enabled = current is ApiResult.Success && current.value.enabled
        PcctlApi.setWorkMode(connection, !enabled)
        refreshWidgetState(context)
        updateAllWidgets(context)
    }
}

class TaskWidget : GlanceAppWidget() {
    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val prefs = currentState<Preferences>()
            val lines = prefs[WidgetKeys.inboxTasks].orEmpty().lines().filter { it.isNotBlank() }
            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(Surface)
                    .cornerRadius(20.dp)
                    .padding(12.dp),
            ) {
                Text("Aufgaben", style = TextStyle(color = OnSurface, fontWeight = FontWeight.Bold, fontSize = 14.sp))
                Spacer(GlanceModifier.height(8.dp))
                if (lines.isEmpty()) {
                    Text("Inbox leer", style = TextStyle(color = Muted, fontSize = 12.sp))
                } else {
                    lines.take(5).forEach { line ->
                        val parts = line.split("|")
                        val id = parts.getOrNull(0).orEmpty()
                        val title = parts.getOrNull(1).orEmpty()
                        Row(
                            modifier = GlanceModifier.fillMaxWidth().padding(vertical = 3.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            CheckBox(
                                checked = false,
                                onCheckedChange = actionRunCallback<CompleteInboxCallback>(
                                    actionParametersOf(CompleteInboxCallback.taskIdKey to id),
                                ),
                            )
                            Text(
                                title,
                                style = TextStyle(color = OnSurface, fontSize = 12.sp),
                                maxLines = 1,
                                modifier = GlanceModifier.defaultWeight(),
                            )
                        }
                    }
                }
            }
        }
    }
}

class TaskWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TaskWidget()
}

class WorkModeWidget : GlanceAppWidget() {
    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        provideContent {
            val on = currentState<Preferences>()[WidgetKeys.workModeOn] == true
            val bg = if (on) Danger else Ok
            Box(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .background(bg)
                    .cornerRadius(20.dp)
                    .clickable(actionRunCallback<ToggleWorkModeCallback>()),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (on) "Deep\nWork" else "Normal",
                    style = TextStyle(
                        color = ColorProvider(Color.Black),
                        fontWeight = FontWeight.Bold,
                        fontSize = 14.sp,
                        textAlign = TextAlign.Center,
                    ),
                )
            }
        }
    }
}

class WorkModeWidgetReceiver : RefreshingWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = WorkModeWidget()
}
