package dev.wadik.pcctl.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.wadik.pcctl.data.AppEntry
import dev.wadik.pcctl.ui.components.ConfirmDialog
import dev.wadik.pcctl.ui.components.formatBytes

@Composable
fun AppsScreen(state: UiState, viewModel: PcctlViewModel) {
    var toQuit by remember { mutableStateOf<AppEntry?>(null) }

    LaunchedEffect(Unit) { viewModel.refreshApps() }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text("Laufende Programme", style = MaterialTheme.typography.titleMedium)
                Text(
                    // Die Quelle ist wichtig: Ohne die GNOME-Erweiterung sieht man
                    // Prozesse statt Fenster, also auch Hintergrunddienste.
                    when (state.apps.source) {
                        "windows" -> "Offene Fenster"
                        else -> "Prozesse ab 50 MB – Erweiterung nicht aktiv"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { viewModel.refreshApps() }) {
                Icon(Icons.Filled.Refresh, contentDescription = "Aktualisieren")
            }
        }

        LazyColumn(
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(state.apps.apps, key = { it.pid }) { app ->
                AppRow(app) { toQuit = app }
            }
        }
    }

    toQuit?.let { app ->
        ConfirmDialog(
            title = "${app.name} beenden?",
            text = buildString {
                append("Das Programm wird zuerst höflich zum Schließen aufgefordert. ")
                append("Nicht gespeicherte Änderungen können verloren gehen.")
            },
            confirmLabel = "Beenden",
            onConfirm = { viewModel.quitApp(app.pid) },
            onDismiss = { toQuit = null },
        )
    }
}

@Composable
private fun AppRow(app: AppEntry, onQuit: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(14.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    app.title?.takeIf { it.isNotBlank() } ?: app.name,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    "${app.name} · PID ${app.pid} · ${formatBytes(app.memoryBytes)}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            if (app.isProtected) {
                // Geschützte Prozesse lassen sich nicht beenden – das Schloss
                // erklärt, warum hier kein Knopf steht.
                Icon(
                    Icons.Filled.Lock,
                    contentDescription = "Geschützt",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            } else {
                IconButton(onClick = onQuit) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "Beenden",
                        tint = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}
