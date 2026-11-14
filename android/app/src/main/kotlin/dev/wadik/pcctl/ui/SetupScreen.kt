package dev.wadik.pcctl.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.wadik.pcctl.ui.components.SectionHeader

/**
 * Verbindungseinrichtung.
 *
 * Adresse und Token stehen am Ende von scripts/install.sh auf dem Rechner.
 */
@Composable
fun SetupScreen(state: UiState, viewModel: PcctlViewModel) {
    var host by remember(state.connection.host) { mutableStateOf(state.connection.host) }
    var port by remember(state.connection.port) { mutableStateOf(state.connection.port.toString()) }
    var token by remember(state.connection.token) { mutableStateOf(state.connection.token) }
    var tokenVisible by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SectionHeader("Verbindung")

        OutlinedTextField(
            value = host,
            onValueChange = { host = it },
            label = { Text("Adresse des Rechners") },
            placeholder = { Text("192.168.0.10") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = port,
            onValueChange = { port = it.filter(Char::isDigit) },
            label = { Text("Port") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            label = { Text("Token") },
            singleLine = true,
            visualTransformation = if (tokenVisible) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = {
                IconButton(onClick = { tokenVisible = !tokenVisible }) {
                    Icon(
                        if (tokenVisible) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        contentDescription = if (tokenVisible) "Verbergen" else "Anzeigen",
                    )
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        Button(
            onClick = { viewModel.saveConnection(host, port.toIntOrNull() ?: 8765, token) },
            enabled = host.isNotBlank() && token.isNotBlank(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Speichern und verbinden")
        }

        Surface(
            shape = RoundedCornerShape(14.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("Woher kommen diese Angaben?", style = MaterialTheme.typography.titleSmall)
                Text(
                    "Auf dem Rechner scripts/install.sh ausführen – Adresse und Token " +
                        "stehen am Ende der Ausgabe. Beide Geräte müssen im selben WLAN sein.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        if (state.connection.isConfigured) {
            SectionHeader("Status")
            val statusText = when (state.connectionState) {
                ConnectionState.Online -> "Verbunden mit ${state.connection.host}"
                ConnectionState.Connecting -> "Verbindung wird aufgebaut …"
                ConnectionState.Offline -> "Nicht erreichbar – läuft der Dienst? Gleiches WLAN?"
                ConnectionState.Unconfigured -> "Noch nicht eingerichtet"
            }
            Text(statusText, style = MaterialTheme.typography.bodyMedium)

            state.status?.let { status ->
                Spacer(Modifier.height(4.dp))
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    FeatureLine("Monitorsteuerung (ddcutil)", status.display.available)
                    FeatureLine("Beleuchtung (OpenRGB)", status.rgb.available)
                    FeatureLine("GNOME-Erweiterung", status.gnomeBridge.available)
                    FeatureLine("Wake-on-LAN", status.wol.ready)
                }
            }
        }
    }
}

@Composable
private fun FeatureLine(label: String, available: Boolean) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (available) "✓" else "–", color = if (available) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant
        })
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
