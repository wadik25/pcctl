package dev.wadik.pcctl.widget

import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import dev.wadik.pcctl.data.ApiResult
import dev.wadik.pcctl.data.CompactStats
import dev.wadik.pcctl.data.PcctlApi
import dev.wadik.pcctl.data.Settings
import dev.wadik.pcctl.data.SystemStatus

/**
 * Gemeinsame Grundlage der Widgets.
 *
 * Widgets laufen außerhalb der App und haben keinen Zugriff auf deren Zustand.
 * Sie holen die Verbindungsdaten deshalb selbst aus dem DataStore und legen
 * das zuletzt bekannte Ergebnis im Glance-Zustand ab, damit auch bei
 * unerreichbarem Rechner etwas Sinnvolles angezeigt wird.
 */
object WidgetKeys {
    val cpuTemp = stringPreferencesKey("cpuTemp")
    val gpuTemp = stringPreferencesKey("gpuTemp")
    val cpuUsage = stringPreferencesKey("cpuUsage")
    val gpuUsage = stringPreferencesKey("gpuUsage")
    val memoryUsage = stringPreferencesKey("memoryUsage")
    val uptime = stringPreferencesKey("uptime")

    val micMuted = booleanPreferencesKey("micMuted")
    val displayBlanked = booleanPreferencesKey("displayBlanked")
    val rgbOn = booleanPreferencesKey("rgbOn")

    // Ob die Funktion auf dem Rechner überhaupt bereitsteht. Ohne das würde
    // etwa die Beleuchtung als eingeschaltet leuchten, obwohl OpenRGB fehlt.
    val displayAvailable = booleanPreferencesKey("displayAvailable")
    val rgbAvailable = booleanPreferencesKey("rgbAvailable")

    val online = booleanPreferencesKey("online")
    val lastError = stringPreferencesKey("lastError")
    val scenesJson = stringPreferencesKey("scenesJson")
    val lastUpdate = stringPreferencesKey("lastUpdate")
    val inboxTasks = stringPreferencesKey("inboxTasks")
    val workModeOn = booleanPreferencesKey("workModeOn")
}

/** Holt den aktuellen Status und schreibt ihn in den Zustand aller Widgets. */
suspend fun refreshWidgetState(context: Context) {
    val connection = Settings.connection(context)

    // Nur MutablePreferences erlaubt Schreibzugriff über den Index-Operator.
    val update: suspend (MutablePreferences.() -> Unit) -> Unit = { block ->
        for (widgetClass in widgetClasses) {
            val manager = GlanceAppWidgetManager(context)
            manager.getGlanceIds(widgetClass).forEach { id ->
                updateAppWidgetState(context, PreferencesGlanceStateDefinition, id) { prefs ->
                    prefs.toMutablePreferences().apply { block() }
                }
            }
        }
    }

    if (!connection.isConfigured) {
        update {
            this[WidgetKeys.online] = false
            this[WidgetKeys.lastError] = "Nicht eingerichtet"
        }
        return
    }

    when (val result = PcctlApi.status(connection)) {
        is ApiResult.Success -> {
            val status: SystemStatus = result.value
            val stats: CompactStats = status.stats
            update {
                this[WidgetKeys.online] = true
                this[WidgetKeys.lastError] = ""
                this[WidgetKeys.cpuTemp] = stats.cpuTempC?.toInt()?.toString() ?: "–"
                this[WidgetKeys.gpuTemp] = stats.gpuTempC?.toInt()?.toString() ?: "–"
                this[WidgetKeys.cpuUsage] = stats.cpuUsagePercent?.toInt()?.toString() ?: "–"
                this[WidgetKeys.gpuUsage] = stats.gpuUsagePercent?.toInt()?.toString() ?: "–"
                this[WidgetKeys.memoryUsage] = stats.memoryUsagePercent?.toInt()?.toString() ?: "–"
                this[WidgetKeys.uptime] = stats.uptimeSeconds?.toString() ?: ""
                this[WidgetKeys.micMuted] = status.audio.microphone.muted == true
                this[WidgetKeys.displayBlanked] = status.display.blanked
                this[WidgetKeys.rgbOn] = status.rgb.on
                this[WidgetKeys.displayAvailable] = status.display.available
                this[WidgetKeys.rgbAvailable] = status.rgb.available
                // Szenen als "id|name" je Zeile – ein eigenes Schema wäre hier Überbau.
                this[WidgetKeys.scenesJson] = status.scenes.joinToString("\n") { "${it.id}|${it.name}" }
                this[WidgetKeys.lastUpdate] = System.currentTimeMillis().toString()
                this[WidgetKeys.workModeOn] = status.workMode.enabled
            }
            when (val inbox = PcctlApi.inboxTasks(connection, "inbox")) {
                is ApiResult.Success -> update {
                    this[WidgetKeys.inboxTasks] = inbox.value.take(6).joinToString("\n") {
                        "${it.id}|${it.title}"
                    }
                }
                is ApiResult.Failure -> Unit
            }
        }

        is ApiResult.Failure -> update {
            this[WidgetKeys.online] = false
            this[WidgetKeys.lastError] = result.message
        }
    }
}
