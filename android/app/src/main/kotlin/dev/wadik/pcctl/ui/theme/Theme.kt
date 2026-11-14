package dev.wadik.pcctl.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

/**
 * Dunkles Erscheinungsbild als Standard – die App wird meist abends und im
 * Dunkeln benutzt. Ab Android 12 wird auf Wunsch die Systemfarbe übernommen.
 */

private val Cyan = Color(0xFF4DD8E6)
private val CyanDark = Color(0xFF00363D)
private val Amber = Color(0xFFFFB86C)
private val Rose = Color(0xFFFF6B81)

val StatusOk = Color(0xFF4ADE80)
val StatusWarn = Color(0xFFFBBF24)
val StatusCritical = Color(0xFFF87171)
val StatusMuted = Color(0xFF64748B)

private val DarkColors = darkColorScheme(
    primary = Cyan,
    onPrimary = Color(0xFF00363D),
    primaryContainer = Color(0xFF004F58),
    onPrimaryContainer = Color(0xFF9EEFFB),
    secondary = Amber,
    onSecondary = Color(0xFF452B00),
    secondaryContainer = Color(0xFF633F00),
    onSecondaryContainer = Color(0xFFFFDDB3),
    tertiary = Color(0xFFB4A5F5),
    error = Rose,
    onError = Color(0xFF5F1120),
    background = Color(0xFF0E1116),
    onBackground = Color(0xFFE3E6EA),
    surface = Color(0xFF12161C),
    onSurface = Color(0xFFE3E6EA),
    surfaceVariant = Color(0xFF1C222B),
    onSurfaceVariant = Color(0xFFB9C2CD),
    outline = Color(0xFF3A424D),
    outlineVariant = Color(0xFF262D37),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF006874),
    onPrimary = Color.White,
    primaryContainer = Color(0xFF9EEFFB),
    onPrimaryContainer = CyanDark,
    secondary = Color(0xFF7E5700),
    background = Color(0xFFF7F9FB),
    surface = Color.White,
    surfaceVariant = Color(0xFFE8EDF2),
)

@Composable
fun PcctlTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = MaterialTheme.typography,
        content = content,
    )
}

/** Farbliche Einstufung von Temperaturen – dieselbe Logik in App und Widget. */
fun temperatureColor(celsius: Double?): Color = when {
    celsius == null -> StatusMuted
    celsius >= 85 -> StatusCritical
    celsius >= 70 -> StatusWarn
    else -> StatusOk
}

fun usageColor(percent: Double?): Color = when {
    percent == null -> StatusMuted
    percent >= 90 -> StatusCritical
    percent >= 70 -> StatusWarn
    else -> StatusOk
}
