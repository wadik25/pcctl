package dev.wadik.pcctl.ui

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.wadik.pcctl.data.InboxTask

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TasksScreen(state: UiState, viewModel: PcctlViewModel) {
    val context = LocalContext.current

    LaunchedEffect(state.connectionState) {
        if (state.connectionState == ConnectionState.Online) viewModel.refreshInbox()
    }

    if (state.needsDndAccess) {
        AlertDialog(
            onDismissRequest = { viewModel.clearDndPrompt() },
            title = { Text("Nicht stören") },
            text = { Text("Damit der Work-Mode das Telefon stumm schaltet, muss pcctl den Zugang zu „Nicht stören“ bekommen.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        context.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
                        viewModel.clearDndPrompt()
                    },
                ) { Text("Einstellungen öffnen") }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.clearDndPrompt() }) { Text("Später") }
            },
        )
    }

    val open = state.inboxTasks.filter { it.status == "inbox" || it.status == "paused" || it.status == "active" }
    val later = state.inboxTasks.filter { it.status == "snoozed" }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                Text("Work-Mode", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                Switch(checked = state.workMode, onCheckedChange = { viewModel.toggleWorkMode() })
            }
        }

        item { Text("Inbox", style = MaterialTheme.typography.titleMedium) }

        if (open.isEmpty()) {
            item { Text("Keine offenen Aufgaben.", color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }

        items(open, key = { it.id }) { task ->
            SwipeableTask(task, viewModel)
        }

        if (later.isNotEmpty()) {
            item { Text("Später", style = MaterialTheme.typography.titleMedium) }
            items(later, key = { it.id }) { task ->
                SwipeableTask(task, viewModel)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableTask(task: InboxTask, viewModel: PcctlViewModel) {
    val dismiss = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            when (value) {
                SwipeToDismissBoxValue.EndToStart -> {
                    viewModel.completeInbox(task.id)
                    true
                }
                SwipeToDismissBoxValue.StartToEnd -> {
                    viewModel.snoozeInbox(task.id)
                    true
                }
                else -> false
            }
        },
    )

    SwipeToDismissBox(
        state = dismiss,
        backgroundContent = {
            val color = when (dismiss.targetValue) {
                SwipeToDismissBoxValue.EndToStart -> MaterialTheme.colorScheme.primary.copy(alpha = 0.25f)
                SwipeToDismissBoxValue.StartToEnd -> MaterialTheme.colorScheme.tertiary.copy(alpha = 0.25f)
                else -> MaterialTheme.colorScheme.surfaceVariant
            }
            Box(Modifier.fillMaxSize().padding(4.dp), contentAlignment = Alignment.Center) {
                Surface(color = color, modifier = Modifier.fillMaxSize()) {}
            }
        },
    ) {
        TaskCard(task, viewModel)
    }
}

@Composable
private fun TaskCard(task: InboxTask, viewModel: PcctlViewModel) {
    var transcript by remember(task.id) { mutableStateOf<String?>(null) }

    ElevatedCard(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(task.title, style = MaterialTheme.typography.titleMedium)
            if (task.context.isNotBlank()) {
                Text(task.context, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                task.senderName ?: "manuell",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (task.isVoiceMessage) {
                    AssistChip(onClick = {}, label = { Text("Sprache") }, leadingIcon = { Icon(Icons.Filled.Mic, null) })
                }
                TextButton(onClick = { viewModel.completeInbox(task.id) }) { Text("Erledigt") }
                if (task.isVoiceMessage) {
                    TextButton(
                        onClick = {
                            if (transcript == null) viewModel.transcript(task.id) { transcript = it }
                            else transcript = null
                        },
                    ) { Text(if (transcript == null) "Transkript" else "Zuklappen") }
                }
            }
            transcript?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}
