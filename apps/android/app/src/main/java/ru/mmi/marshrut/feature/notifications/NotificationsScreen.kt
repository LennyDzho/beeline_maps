package ru.mmi.marshrut.feature.notifications

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.core.model.Notice
import ru.mmi.marshrut.ui.components.*
import ru.mmi.marshrut.ui.theme.*

@Composable fun NotificationsScreen(notices: List<Notice>, open: (Notice) -> Unit, readAll: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        ScreenTitle("Уведомления", "Непрочитанных: ${notices.count { !it.read }}")
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically) {
            SectionLabel("Сегодня")
            TextButton(readAll, enabled = notices.any { !it.read }) { Text("Прочитать все") }
        }
        LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(notices, key = { it.id }) { notice ->
                Surface(onClick = { open(notice) }, color = if (notice.read) Canvas else Color.White,
                    shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, if (notice.read) Line.copy(alpha = .4f) else Lilac)) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(40.dp).clip(CircleShape).background(if (notice.read) NavSurface else Lilac), contentAlignment = Alignment.Center) {
                            Icon(if (notice.title.contains("Проблема")) Icons.Outlined.ReportProblem else Icons.Outlined.Notifications, null, Modifier.size(22.dp), tint = Purple)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                            Text(notice.title, style = MaterialTheme.typography.titleSmall)
                            Text(notice.text, style = MaterialTheme.typography.bodyMedium, color = Muted)
                            Text("${notice.time} · ${if (notice.read) "Прочитано" else "Новое"}", style = MaterialTheme.typography.labelMedium, color = Purple)
                            if (notice.visitId != null) Text("Открыть заявку →", style = MaterialTheme.typography.labelLarge, color = Purple)
                        }
                    }
                }
            }
            item { Text("Уведомления демо хранятся на устройстве. Push будет подключён на следующем этапе.", style = MaterialTheme.typography.labelMedium, color = Muted) }
        }
    }
}
