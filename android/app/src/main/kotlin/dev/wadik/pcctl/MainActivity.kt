package dev.wadik.pcctl

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.wadik.pcctl.ui.*
import dev.wadik.pcctl.ui.components.ConnectionPill
import dev.wadik.pcctl.ui.theme.PcctlTheme
import dev.wadik.pcctl.ui.theme.StatusCritical
import dev.wadik.pcctl.ui.theme.StatusOk
import dev.wadik.pcctl.ui.theme.StatusWarn

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PcctlTheme {
                PcctlApp()
            }
        }
    }
}

private enum class Tab(val label: String, val icon: ImageVector) {
    Dashboard("Übersicht", Icons.Filled.Dashboard),
    Tasks("Aufgaben", Icons.Filled.CheckCircle),
    Apps("Programme", Icons.Filled.Apps),
    Claude("Claude", Icons.Filled.AutoAwesome),
    Setup("Mehr", Icons.Filled.Settings),
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PcctlApp(viewModel: PcctlViewModel = viewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }

    // Ist noch nichts eingerichtet, führt der Weg direkt in die Einstellungen.
    var selectedTab by remember { mutableStateOf(Tab.Dashboard) }
    LaunchedEffect(state.connectionState) {
        if (state.connectionState == ConnectionState.Unconfigured) selectedTab = Tab.Setup
    }

    state.message?.let { message ->
        LaunchedEffect(message) {
            snackbarHost.showSnackbar(message)
            viewModel.clearMessage()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(selectedTab.label) },
                actions = {
                    val (label, color) = when (state.connectionState) {
                        ConnectionState.Online -> "verbunden" to StatusOk
                        ConnectionState.Connecting -> "verbindet" to StatusWarn
                        ConnectionState.Offline -> "getrennt" to StatusCritical
                        ConnectionState.Unconfigured -> "nicht eingerichtet" to StatusWarn
                    }
                    ConnectionPill(label, color, Modifier.padding(end = 12.dp))
                },
            )
        },
        bottomBar = {
            NavigationBar {
                Tab.entries.forEach { tab ->
                    NavigationBarItem(
                        selected = selectedTab == tab,
                        onClick = { selectedTab = tab },
                        icon = {
                            // Wartende Genehmigungen sollen auffallen, auch wenn
                            // der Claude-Tab gerade nicht offen ist.
                            if (tab == Tab.Claude && state.approvals.isNotEmpty()) {
                                BadgedBox(badge = { Badge { Text("${state.approvals.size}") } }) {
                                    Icon(tab.icon, contentDescription = tab.label)
                                }
                            } else if (tab == Tab.Tasks && state.inboxTasks.any { it.status == "inbox" }) {
                                val count = state.inboxTasks.count { it.status == "inbox" }
                                BadgedBox(badge = { Badge { Text("$count") } }) {
                                    Icon(tab.icon, contentDescription = tab.label)
                                }
                            } else {
                                Icon(tab.icon, contentDescription = tab.label)
                            }
                        },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
        snackbarHost = { SnackbarHost(snackbarHost) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
            verticalArrangement = Arrangement.Top,
        ) {
            when (selectedTab) {
                Tab.Dashboard -> DashboardScreen(state, viewModel)
                Tab.Tasks -> TasksScreen(state, viewModel)
                Tab.Apps -> AppsScreen(state, viewModel)
                Tab.Claude -> ClaudeScreen(state, viewModel)
                Tab.Setup -> SetupScreen(state, viewModel)
            }
        }
    }
}
