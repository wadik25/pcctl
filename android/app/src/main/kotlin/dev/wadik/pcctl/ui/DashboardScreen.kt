package dev.wadik.pcctl.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import dev.wadik.pcctl.data.SceneSummary
import dev.wadik.pcctl.data.SystemStatus
import dev.wadik.pcctl.ui.components.*
import dev.wadik.pcctl.ui.theme.*

@Composable
fun DashboardScreen(state: UiState, viewModel: PcctlViewModel) {
    var pendingConfirm by remember { mutableStateOf<PendingAction?>(null) }
    var showSleepTimer by remember { mutableStateOf(false) }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { StatsSection(state) }

        item {
            SectionHeader("Szenen")
            ScenesRow(state.status?.scenes.orEmpty()) { viewModel.runScene(it) }
        }

        item { SectionHeader("Schnellzugriff") }

        item {
            QuickActionsGrid(
                state = state,
                viewModel = viewModel,
                onConfirmNeeded = { pendingConfirm = it },
                onSleepTimer = { showSleepTimer = true },
            )
        }

        item {
            SectionHeader("Medien")
            MediaRow(viewModel)
        }

        state.status?.power?.scheduled?.let { scheduled ->
            item { ScheduledBanner(scheduled.action, scheduled.remainingSeconds) { viewModel.cancelSchedule() } }
        }

        item { SystemNotes(state.status) }
    }

    pendingConfirm?.let { action ->
        ConfirmDialog(
            title = action.title,
            text = action.text,
            confirmLabel = action.confirmLabel,
            onConfirm = action.onConfirm,
            onDismiss = { pendingConfirm = null },
        )
    }

    if (showSleepTimer) {
        SleepTimerDialog(
            onDismiss = { showSleepTimer = false },
            onSchedule = { minutes -> viewModel.schedule("poweroff", minutes) },
        )
    }
}

data class PendingAction(
    val title: String,
    val text: String,
    val confirmLabel: String,
    val onConfirm: () -> Unit,
)

// ---------------------------------------------------------------- Kennzahlen

@Composable
private fun StatsSection(state: UiState) {
    val stats = state.stats

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard(
                label = "CPU",
                value = stats.cpuTempC?.let { "${it.toInt()}°" } ?: "–",
                accent = temperatureColor(stats.cpuTempC),
                progress = stats.cpuUsagePercent?.let { (it / 100).toFloat() },
                detail = stats.cpuUsagePercent?.let { "${it.toInt()} % Last" } ?: "keine Daten",
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "GPU",
                value = stats.gpuTempC?.let { "${it.toInt()}°" } ?: "–",
                accent = temperatureColor(stats.gpuTempC),
                progress = stats.gpuUsagePercent?.let { (it / 100).toFloat() },
                detail = stats.gpuUsagePercent?.let { "${it.toInt()} % Last" } ?: "keine Daten",
                modifier = Modifier.weight(1f),
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatCard(
                label = "Arbeitsspeicher",
                value = stats.memoryUsagePercent?.let { "${it.toInt()} %" } ?: "–",
                accent = usageColor(stats.memoryUsagePercent),
                progress = stats.memoryUsagePercent?.let { (it / 100).toFloat() },
                modifier = Modifier.weight(1f),
            )
            StatCard(
                label = "Laufzeit",
                value = formatUptime(stats.uptimeSeconds),
                accent = MaterialTheme.colorScheme.tertiary,
                modifier = Modifier.weight(1f),
            )
        }
    }
}

// ---------------------------------------------------------------- Szenen

@Composable
private fun ScenesRow(scenes: List<SceneSummary>, onRun: (String) -> Unit) {
    if (scenes.isEmpty()) {
        Text(
            "Keine Szenen eingerichtet",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        items(scenes, key = { it.id }) { scene ->
            SceneChip(scene) { onRun(scene.id) }
        }
    }
}

@Composable
private fun SceneChip(scene: SceneSummary, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.primaryContainer,
        modifier = Modifier.widthIn(min = 110.dp),
    ) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Icon(
                iconForScene(scene.icon),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
                modifier = Modifier.size(22.dp),
            )
            Spacer(Modifier.height(8.dp))
            Text(
                scene.name,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
    }
}

private fun iconForScene(icon: String): ImageVector = when (icon) {
    "moon" -> Icons.Filled.Bedtime
    "video" -> Icons.Filled.Videocam
    "gamepad" -> Icons.Filled.SportsEsports
    "target" -> Icons.Filled.CenterFocusStrong
    else -> Icons.Filled.Bolt
}

// ---------------------------------------------------------------- Schnellzugriff

@Composable
private fun QuickActionsGrid(
    state: UiState,
    viewModel: PcctlViewModel,
    onConfirmNeeded: (PendingAction) -> Unit,
    onSleepTimer: () -> Unit,
) {
    val status = state.status
    val micMuted = status?.audio?.microphone?.muted == true
    val outputMuted = status?.audio?.output?.muted == true
    val displayBlanked = status?.display?.blanked == true
    val displayAvailable = status?.display?.available == true
    val rgbOn = status?.rgb?.on == true
    val rgbAvailable = status?.rgb?.available == true

    // Ein festes Raster statt einer scrollbaren Liste: Die Kacheln sollen
    // immer an derselben Stelle liegen, damit sie blind treffbar sind.
    LazyVerticalGrid(
        columns = GridCells.Fixed(3),
        modifier = Modifier.heightIn(max = 460.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        userScrollEnabled = false,
    ) {
        item {
            ActionTile(
                label = if (micMuted) "Mikro stumm" else "Mikrofon",
                icon = if (micMuted) Icons.Filled.MicOff else Icons.Filled.Mic,
                active = micMuted,
                activeColor = StatusCritical,
                onClick = viewModel::toggleMic,
            )
        }

        item {
            ActionTile(
                label = "Monitore aus",
                icon = Icons.Filled.DesktopAccessDisabled,
                active = displayBlanked,
                enabled = displayAvailable,
                subtitle = if (!displayAvailable) "ddcutil fehlt" else null,
                onClick = viewModel::displayOff,
            )
        }

        item {
            ActionTile(
                label = "Monitore an",
                icon = Icons.Filled.DesktopWindows,
                enabled = displayAvailable,
                onClick = viewModel::displayOn,
            )
        }

        item {
            ActionTile(
                label = if (rgbOn) "RGB aus" else "RGB an",
                icon = Icons.Filled.Lightbulb,
                active = rgbOn,
                activeColor = StatusWarn,
                enabled = rgbAvailable,
                subtitle = if (!rgbAvailable) "OpenRGB fehlt" else null,
                onClick = { if (rgbOn) viewModel.rgbOff() else viewModel.rgbOn() },
            )
        }

        item {
            ActionTile(
                label = if (outputMuted) "Ton aus" else "Ton",
                icon = if (outputMuted) Icons.Filled.VolumeOff else Icons.Filled.VolumeUp,
                active = outputMuted,
                onClick = viewModel::toggleOutput,
            )
        }

        item {
            ActionTile(
                label = "Sperren",
                icon = Icons.Filled.Lock,
                onClick = viewModel::lock,
            )
        }

        item {
            ActionTile(
                label = "Sleep-Timer",
                icon = Icons.Filled.Timer,
                onClick = onSleepTimer,
            )
        }

        item {
            ActionTile(
                label = "Neustart",
                icon = Icons.Filled.RestartAlt,
                activeColor = StatusWarn,
                onClick = {
                    onConfirmNeeded(
                        PendingAction(
                            title = "Neu starten?",
                            text = "Der Rechner wird sofort neu gestartet. Nicht gespeicherte Arbeit geht verloren.",
                            confirmLabel = "Neu starten",
                            onConfirm = viewModel::reboot,
                        ),
                    )
                },
            )
        }

        item {
            ActionTile(
                label = "Ausschalten",
                icon = Icons.Filled.PowerSettingsNew,
                activeColor = StatusCritical,
                onClick = {
                    onConfirmNeeded(
                        PendingAction(
                            title = "Rechner ausschalten?",
                            text = "Der Rechner fährt herunter. Einschalten geht danach nur am Gerät selbst " +
                                "oder per Wake-on-LAN – dafür muss ein Netzwerkkabel gesteckt sein.",
                            confirmLabel = "Ausschalten",
                            onConfirm = viewModel::powerOff,
                        ),
                    )
                },
            )
        }
    }
}

// ---------------------------------------------------------------- Medien

@Composable
private fun MediaRow(viewModel: PcctlViewModel) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        MediaButton(Icons.Filled.SkipPrevious, "Zurück", Modifier.weight(1f)) { viewModel.media("Previous") }
        MediaButton(Icons.Filled.PlayArrow, "Wiedergabe", Modifier.weight(1f)) { viewModel.media("PlayPause") }
        MediaButton(Icons.Filled.SkipNext, "Weiter", Modifier.weight(1f)) { viewModel.media("Next") }
    }
}

@Composable
private fun MediaButton(icon: ImageVector, description: String, modifier: Modifier, onClick: () -> Unit) {
    FilledTonalIconButton(
        onClick = onClick,
        modifier = modifier.height(52.dp),
        shape = RoundedCornerShape(14.dp),
    ) {
        Icon(icon, contentDescription = description)
    }
}

// ---------------------------------------------------------------- Hinweise

@Composable
private fun ScheduledBanner(action: String, remainingSeconds: Long, onCancel: () -> Unit) {
    val minutes = remainingSeconds / 60
    val label = when (action) {
        "poweroff" -> "Herunterfahren"
        "reboot" -> "Neustart"
        else -> "Ruhezustand"
    }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.secondaryContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Timer, null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
            Spacer(Modifier.width(12.dp))
            Text(
                "$label in $minutes min",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onCancel) { Text("Abbrechen") }
        }
    }
}

/**
 * Weist auf fehlende Voraussetzungen hin, statt Kacheln kommentarlos
 * auszugrauen – sonst sucht man den Fehler an der falschen Stelle.
 */
@Composable
private fun SystemNotes(status: SystemStatus?) {
    if (status == null) return

    val notes = buildList {
        if (!status.display.available) add("Monitorsteuerung inaktiv – ddcutil fehlt oder kein DDC/CI-Monitor erkannt")
        if (!status.rgb.available) add("RGB inaktiv – OpenRGB fehlt oder der SMBus ist nicht freigeschaltet")
        else status.rgb.note?.let { add(it) }
        if (!status.gnomeBridge.available) add("GNOME-Erweiterung nicht aktiv – Fensterliste und Editor-Eingabe eingeschränkt")
        if (!status.wol.ready) add(status.wol.note)
    }

    if (notes.isEmpty()) return

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                "Hinweise",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            notes.forEach { note ->
                Row(verticalAlignment = Alignment.Top) {
                    Icon(
                        Icons.Outlined.Info,
                        null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.size(16.dp).padding(top = 2.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(
                        note,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun SleepTimerDialog(onDismiss: () -> Unit, onSchedule: (Int) -> Unit) {
    val options = listOf(15, 30, 45, 60, 90, 120)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Herunterfahren in …") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                options.chunked(3).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { minutes ->
                            FilledTonalButton(
                                onClick = {
                                    onSchedule(minutes)
                                    onDismiss()
                                },
                                modifier = Modifier.weight(1f),
                            ) {
                                Text("$minutes")
                            }
                        }
                    }
                }
                Text(
                    "Angaben in Minuten. Der Zeitplan lässt sich jederzeit abbrechen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}
