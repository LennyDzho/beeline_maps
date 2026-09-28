package ru.mmi.marshrut.ui.theme

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ru.mmi.marshrut.R

val Purple = Color(0xFF4F378A)
val Canvas = Color(0xFFFDF7FF)
val SoftSurface = Color(0xFFF8F2FA)
val NavSurface = Color(0xFFF2ECF4)
val Lilac = Color(0xFFE1D4FD)
val Ink = Color(0xFF1D1B20)
val Muted = Color(0xFF494551)
val Line = Color(0xFFCBC4D2)
val Gold = Color(0xFF765B00)
val GoldLight = Color(0xFFF2E9D8)
val Success = Color(0xFF37654B)

private val colors = lightColorScheme(
    primary = Purple, onPrimary = Color.White, primaryContainer = Lilac, onPrimaryContainer = Purple,
    secondary = Color(0xFF63597C), secondaryContainer = Lilac, onSecondaryContainer = Purple,
    background = Canvas, onBackground = Ink, surface = Canvas, onSurface = Ink,
    surfaceVariant = Color(0xFFE6E0E9), onSurfaceVariant = Muted,
    outline = Color(0xFF7A7582), outlineVariant = Line, error = Color(0xFFBA1A1A)
)
private val inter = FontFamily(Font(R.font.inter))
private val type = Typography(
    headlineLarge = TextStyle(fontFamily = inter, fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold),
    headlineSmall = TextStyle(fontFamily = inter, fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontFamily = inter, fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontFamily = inter, fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontFamily = inter, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontFamily = inter, fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontFamily = inter, fontSize = 14.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = inter, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontFamily = inter, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontFamily = inter, fontSize = 11.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium)
)
@Composable fun MarshrutTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, typography = type, content = content)
}
