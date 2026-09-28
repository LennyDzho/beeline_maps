package ru.mmi.marshrut.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ru.mmi.marshrut.core.model.VisitStatus
import ru.mmi.marshrut.ui.theme.*

@Composable fun SectionLabel(text: String) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = Muted, letterSpacing = 1.sp,
        modifier = Modifier.padding(start = 2.dp, bottom = 6.dp))
}
@Composable fun Pill(text: String, color: Color = Purple, background: Color = Lilac, icon: ImageVector? = null) {
    Row(Modifier.clip(RoundedCornerShape(50)).background(background).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (icon != null) Icon(icon, null, Modifier.size(14.dp), tint = color)
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}
@Composable fun StatusPill(status: VisitStatus) {
    if (status == VisitStatus.COMPLETED) Pill(status.label, Success, Color(0xFFE2EEE6), Icons.Outlined.Check)
    else if (status == VisitStatus.PAUSED) Pill(status.label, Gold, GoldLight, Icons.Outlined.PauseCircle)
    else Pill(status.label)
}
@Composable fun IdBadge(id: String, muted: Boolean = false) {
    Text(id, style = MaterialTheme.typography.labelMedium, color = if (muted) Muted else Purple,
        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(if (muted) Line.copy(alpha = .3f) else Lilac)
            .padding(horizontal = 7.dp, vertical = 2.dp))
}
@Composable fun PrimaryButton(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick, modifier.heightIn(min = 52.dp), enabled = enabled, shape = CircleShape,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
        if (icon != null) { Icon(icon, null, Modifier.size(20.dp)); Spacer(Modifier.width(8.dp)) }
        Text(text)
    }
}
@Composable fun EmptyCard(title: String, description: String, icon: ImageVector = Icons.Outlined.TaskAlt) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Color.White).padding(28.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(icon, null, Modifier.size(40.dp), tint = Purple)
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(description, style = MaterialTheme.typography.bodyMedium, color = Muted)
    }
}
@Composable fun ScreenTitle(title: String, subtitle: String, action: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            Spacer(Modifier.height(4.dp))
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = Muted)
        }
        action?.invoke()
    }
}

/** An explicitly labelled illustration: no fabricated map/geolocation data. */
@Composable fun AreaSketch(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(138.dp).clip(RoundedCornerShape(16.dp)).background(Color(0xFFEBE9EF))
        .border(1.dp, Line.copy(alpha = .6f), RoundedCornerShape(16.dp))) {
        Canvas(Modifier.matchParentSize()) {
            val w = size.width; val h = size.height
            for (x in 0..6) for (y in 0..3) {
                drawRoundRect(if ((x + y) % 5 == 0) Color(0xFFD4E3D6) else Color(0xFFDEDCE5),
                    Offset(x * w / 6 + 8, y * h / 3 + 7), Size(w / 6 - 16, h / 3 - 14), CornerRadius(7f))
            }
            val road = Path().apply { moveTo(-20f, h * .83f); cubicTo(w * .3f, h * .87f, w * .45f, h * .05f, w + 20, h * .3f) }
            drawPath(road, Color.White, style = Stroke(width = 21f, cap = StrokeCap.Round))
            val river = Path().apply { moveTo(w * .13f, -5f); cubicTo(w * .35f, h * .4f, w * .48f, h * .3f, w * .85f, h + 10) }
            drawPath(river, Color(0xFFCCDCE8), style = Stroke(width = 17f, cap = StrokeCap.Round))
            drawCircle(Purple.copy(alpha = .14f), 35.dp.toPx(), Offset(w * .56f, h * .43f))
            drawCircle(Color.White, 11.dp.toPx(), Offset(w * .56f, h * .43f))
            drawCircle(Purple, 8.dp.toPx(), Offset(w * .56f, h * .43f))
        }
        Text("Схема района · демо", color = Muted, style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.align(Alignment.BottomStart).padding(10.dp).clip(CircleShape)
                .background(Color.White.copy(alpha = .92f)).padding(horizontal = 8.dp, vertical = 4.dp))
    }
}
