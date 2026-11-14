package dev.wadik.pcctl.data

import android.content.Context
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

/**
 * Verbindungsdaten zum Agent.
 *
 * Liegt im DataStore, damit auch die Widgets darauf zugreifen können – die
 * laufen in einem eigenen Prozesskontext ohne Zugriff auf den ViewModel-Zustand.
 */

private val Context.dataStore by preferencesDataStore(name = "pcctl_settings")

data class Connection(val host: String, val port: Int, val token: String) {
    val baseUrl: String get() = "http://$host:$port"
    val webSocketUrl: String get() = "ws://$host:$port/ws?token=$token"
    val isConfigured: Boolean get() = host.isNotBlank() && token.isNotBlank()
}

object Settings {
    private val KEY_HOST = stringPreferencesKey("host")
    private val KEY_PORT = stringPreferencesKey("port")
    private val KEY_TOKEN = stringPreferencesKey("token")

    private fun Preferences.toConnection() = Connection(
        host = this[KEY_HOST].orEmpty(),
        port = this[KEY_PORT]?.toIntOrNull() ?: 8765,
        token = this[KEY_TOKEN].orEmpty(),
    )

    fun connectionFlow(context: Context): Flow<Connection> =
        context.dataStore.data.map { it.toConnection() }

    /** Für Widgets und Hintergrundarbeiten, die keinen Flow beobachten können. */
    suspend fun connection(context: Context): Connection =
        context.dataStore.data.first().toConnection()

    suspend fun save(context: Context, host: String, port: Int, token: String) {
        context.dataStore.edit { prefs ->
            prefs[KEY_HOST] = host.trim()
            prefs[KEY_PORT] = port.toString()
            prefs[KEY_TOKEN] = token.trim()
        }
    }

    suspend fun clear(context: Context) {
        context.dataStore.edit { it.clear() }
    }
}
