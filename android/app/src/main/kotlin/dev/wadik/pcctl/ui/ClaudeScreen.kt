package dev.wadik.pcctl.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.wadik.pcctl.data.ApprovalRequest
import dev.wadik.pcctl.data.ClaudeSession
import dev.wadik.pcctl.data.ClaudeTask
import dev.wadik.pcctl.data.SessionEvent
import dev.wadik.pcctl.ui.components.SectionHeader
import dev.wadik.pcctl.ui.theme.StatusCritical
import dev.wadik.pcctl.ui.theme.StatusOk
import dev.wadik.pcctl.ui.theme.StatusWarn
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Claude-Steuerung.
 *
 * Vier Bereiche: wartende Genehmigungen (haben Vorrang), eine neue Aufgabe
 * starten, laufende Aufgaben und das Mitlesen einer Sitzung.
 */
@Composable
fun ClaudeScreen(state: UiState, viewModel: PcctlViewModel) {
    var prompt by remember { mutableStateOf("") }
    var showSessionPicker by remember { mutableStateOf(false) }
    var showEditorInput by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.refreshClaude() }

    val listState = rememberLazyListState()

    // Bei neuen Nachrichten nach unten mitlaufen.
    LaunchedEffect(state.sessionEvents.size) {
        if (state.sessionEvents.isNotEmpty()) {
            listState.animateScrollToItem(state.sessionEvents.lastIndex)
        }
    }

    Column(Modifier.fillMaxSize()) {

        // Genehmigungen zuerst – hier wartet jemand auf eine Antwort.
        AnimatedVisibility(visible = state.approvals.isNotEmpty()) {
            Column(
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                state.approvals.forEach { approval ->
                    ApprovalCard(
                        approval = approval,
                        onAllow = { viewModel.decideApproval(approval.id, "allow") },
                        onDeny = { viewModel.decideApproval(approval.id, "deny") },
                    )
                }
            }
        }

        Column(Modifier.padding(horizontal = 16.dp)) {
            NewTaskField(
                prompt = prompt,
                busy = state.busy,
                onPromptChange = { prompt = it },
                onSend = {
                    if (prompt.isNotBlank()) {
                        viewModel.startTask(prompt, null)
                        prompt = ""
                    }
                },
            )

            Row(
                Modifier.padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AssistChip(
                    onClick = { showSessionPicker = true },
                    label = { Text("Sitzung mitlesen") },
                    leadingIcon = { Icon(Icons.Filled.Visibility, null, Modifier.size(18.dp)) },
                )
                AssistChip(
                    onClick = { showEditorInput = true },
                    label = { Text("In Editor tippen") },
                    leadingIcon = { Icon(Icons.Filled.Keyboard, null, Modifier.size(18.dp)) },
                )
            }
        }

        if (state.tasks.any { it.status == "running" }) {
            Column(Modifier.padding(horizontal = 16.dp)) {
                SectionHeader("Laufende Aufgaben")
                state.tasks.filter { it.status == "running" }.forEach { task ->
                    TaskRow(task) { viewModel.cancelTask(task.id) }
                }
            }
        }

        HorizontalDivider(Modifier.padding(vertical = 8.dp))

        if (state.watchedSessionId == null) {
            EmptyTranscript()
        } else {
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.sessionEvents, key = { it.uuid.ifBlank { it.timestamp.toString() } }) { event ->
                    TranscriptEntry(event)
                }
            }
        }
    }

    if (showSessionPicker) {
        SessionPickerDialog(
            sessions = state.sessions,
            onPick = {
                viewModel.watchSession(it)
                showSessionPicker = false
            },
            onDismiss = { showSessionPicker = false },
        )
    }

    if (showEditorInput) {
        EditorInputDialog(
            onSend = { text, submit ->
                viewModel.typeIntoEditor(text, submit)
                showEditorInput = false
            },
            onDismiss = { showEditorInput = false },
        )
    }
}

// ---------------------------------------------------------------- Genehmigung

@Composable
private fun ApprovalCard(approval: ApprovalRequest, onAllow: () -> Unit, onDeny: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.errorContainer,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.PrivacyTip,
                    null,
                    tint = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    "Genehmigung nötig: ${approval.toolName}",
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
            }

            approval.toolInput?.let { input ->
                Spacer(Modifier.height(8.dp))
                Text(
                    input.toString().take(300),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.85f),
                    maxLines = 5,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onAllow, modifier = Modifier.weight(1f)) { Text("Erlauben") }
                OutlinedButton(onClick = onDeny, modifier = Modifier.weight(1f)) { Text("Ablehnen") }
            }
        }
    }
}

// ---------------------------------------------------------------- Eingabe

@Composable
private fun NewTaskField(prompt: String, busy: Boolean, onPromptChange: (String) -> Unit, onSend: () -> Unit) {
    OutlinedTextField(
        value = prompt,
        onValueChange = onPromptChange,
        modifier = Modifier.fillMaxWidth(),
        label = { Text("Neue Aufgabe für Claude") },
        placeholder = { Text("z. B. Tests ausführen und Fehler beheben") },
        minLines = 2,
        maxLines = 5,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
        trailingIcon = {
            IconButton(onClick = onSend, enabled = prompt.isNotBlank() && !busy) {
                if (busy) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Starten")
                }
            }
        },
    )
}

// ---------------------------------------------------------------- Aufgaben

@Composable
private fun TaskRow(task: ClaudeTask, onCancel: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(12.dp))
            Text(
                task.prompt,
                style = MaterialTheme.typography.bodySmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = onCancel) { Text("Stopp") }
        }
    }
}

// ---------------------------------------------------------------- Verlauf

@Composable
private fun TranscriptEntry(event: SessionEvent) {
    val isUser = event.role == "user"
    val time = remember(event.timestamp) {
        SimpleDateFormat("HH:mm", Locale.GERMANY).format(Date(event.timestamp))
    }

    // Werkzeugaufrufe und Denkschritte werden verdichtet dargestellt –
    // der volle Inhalt wäre auf dem Handy unlesbar.
    val text = event.blocks.firstNotNullOfOrNull { block ->
        when (block.type) {
            "text" -> block.text
            "tool_use" -> "→ ${block.name ?: "Werkzeug"}"
            "thinking" -> "· denkt nach ·"
            "tool_result" -> null
            else -> null
        }
    } ?: return

    Surface(
        shape = RoundedCornerShape(
            topStart = 14.dp,
            topEnd = 14.dp,
            bottomStart = if (isUser) 14.dp else 4.dp,
            bottomEnd = if (isUser) 4.dp else 14.dp,
        ),
        color = if (isUser) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    if (isUser) "Du" else "Claude",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    time,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                text.take(1500),
                style = MaterialTheme.typography.bodyMedium,
                color = if (isUser) {
                    MaterialTheme.colorScheme.onPrimaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
        }
    }
}

@Composable
private fun EmptyTranscript() {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Filled.Visibility,
            null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(32.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "Keine Sitzung ausgewählt",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            "Über „Sitzung mitlesen“ eine laufende Claude-Sitzung verfolgen.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---------------------------------------------------------------- Dialoge

@Composable
private fun SessionPickerDialog(
    sessions: List<ClaudeSession>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sitzung wählen") },
        text = {
            if (sessions.isEmpty()) {
                Text("Keine Sitzungen gefunden.")
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(sessions, key = { it.id }) { session ->
                        Surface(
                            onClick = { onPick(session.id) },
                            shape = RoundedCornerShape(10.dp),
                            color = MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(12.dp)) {
                                Text(
                                    session.title ?: session.id.take(8),
                                    style = MaterialTheme.typography.bodyMedium,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    session.project.substringAfterLast('/'),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("Schließen") } },
    )
}

@Composable
private fun EditorInputDialog(onSend: (String, Boolean) -> Unit, onDismiss: () -> Unit) {
    var text by remember { mutableStateOf("") }
    var submit by remember { mutableStateOf(true) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("In den Editor tippen") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                // Der Hinweis ist wichtig: Die Funktion kann fehlschlagen und
                // tut das absichtlich, wenn das falsche Fenster im Vordergrund ist.
                Text(
                    "Der Text wird in das Editorfenster getippt. Liegt der Fokus " +
                        "woanders, bricht der Vorgang ab, ohne etwas zu tippen.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("Text") },
                    minLines = 3,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = submit, onCheckedChange = { submit = it })
                    Text("Mit Eingabetaste abschicken", style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSend(text, submit) }, enabled = text.isNotBlank()) { Text("Tippen") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Abbrechen") } },
    )
}

/** Farbe für den Aufgabenstatus – auch im Widget verwendet. */
fun statusColor(status: String) = when (status) {
    "running" -> StatusWarn
    "done" -> StatusOk
    else -> StatusCritical
}
