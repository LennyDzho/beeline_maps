package ru.mmi.marshrut.feature.profile

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.core.model.DemoState
import ru.mmi.marshrut.ui.components.*
import ru.mmi.marshrut.ui.theme.*

@Composable fun ProfileScreen(state: DemoState, toggleShift: () -> Unit, reset: () -> Unit, signOut: () -> Unit, openConnection: () -> Unit) {
    var dialog by rememberSaveable { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        ScreenTitle("Профиль", "Рабочее пространство инженера")
        Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Surface(color = Color.White, shape = RoundedCornerShape(24.dp)) {
                Column(Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(72.dp).clip(CircleShape).background(Lilac), contentAlignment = Alignment.Center) {
                        Text(state.profile.name.split(" ").take(2).mapNotNull { it.firstOrNull() }.joinToString(""), style = MaterialTheme.typography.headlineSmall, color = Purple)
                    }
                    Text(state.profile.name, style = MaterialTheme.typography.titleLarge)
                    Text("Выездной инженер", color = Muted)
                    Pill(state.profile.organization)
                    if (state.profile.timezoneLabel.isNotBlank()) Text(state.profile.timezoneLabel, style = MaterialTheme.typography.bodySmall, color = Muted)
                    if (state.remote) Text(state.profile.email, color = Muted)
                    Spacer(Modifier.height(8.dp))
                    Text(state.profile.skills, style = MaterialTheme.typography.bodyMedium, color = Muted)
                }
            }
            Surface(color = SoftSurface, shape = RoundedCornerShape(18.dp)) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(if (state.onShift) "Вы в смене" else "Вы вне смены", style = MaterialTheme.typography.titleMedium)
                            Text(if (state.remote) state.serviceDate else "20 августа · 08:00–18:00", style = MaterialTheme.typography.bodyMedium, color = Muted)
                        }
                        Switch(state.onShift, { toggleShift() })
                    }
                    Spacer(Modifier.height(10.dp))
                    Text("Выполнено ${state.completedCount} из ${state.visits.size} визитов", style = MaterialTheme.typography.bodyMedium)
                }
            }
            Column(Modifier.clip(RoundedCornerShape(18.dp)).background(Color.White)) {
                ProfileAction("Связь", if (state.remote) state.syncMessage else "Адрес сервера и синхронизация", Icons.Outlined.SettingsEthernet, openConnection)
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = Line.copy(alpha = .4f))
                ProfileAction("О приложении", "Версия и возможности", Icons.Outlined.Info) { dialog = "about" }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = Line.copy(alpha = .4f))
                if (!state.remote) ProfileAction("Сбросить демо", "Вернуть исходное расписание и статусы", Icons.Outlined.RestartAlt) { dialog = "reset" }
                HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = Line.copy(alpha = .4f))
                ProfileAction("Выйти", "Изменения останутся на устройстве", Icons.Outlined.Logout) { dialog = "logout" }
            }
            Text("Марш! · 0.2.1\nНативное приложение для Android", style = MaterialTheme.typography.labelMedium, color = Muted,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 12.dp))
        }
    }
    if (dialog != null) AlertDialog(onDismissRequest = { dialog = null },
        title = { Text(when (dialog) { "reset" -> "Сбросить демо?"; "logout" -> "Выйти из приложения?"; else -> "Марш! для Android" }) },
        text = { Text(when (dialog) {
            "reset" -> "Локальные отчёты, проблемы и изменённые статусы будут удалены. Вернётся исходное расписание из четырёх визитов."
            "logout" -> "Расписание и результаты работы сохранятся. Вы сможете продолжить после повторного входа."
            else -> "Расписание и заявки исполнителя, статусы, отчёты с фото и видео, проблемы и уведомления.\n\nВ рабочем режиме данные поступают с сервера. При потере связи черновики и очередь отправки хранятся на устройстве. Для навигации используется приложение карт. Push-уведомления пока не подключены."
        }) },
        confirmButton = { TextButton({ when (dialog) { "reset" -> reset(); "logout" -> signOut() }; dialog = null }) {
            Text(when (dialog) { "reset" -> "Сбросить"; "logout" -> "Выйти"; else -> "Понятно" })
        } }, dismissButton = { if (dialog != "about") TextButton({ dialog = null }) { Text("Отмена") } })
}

@Composable private fun ProfileAction(title: String, subtitle: String, icon: ImageVector, action: () -> Unit) {
    Surface(onClick = action, color = Color.Transparent) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, null, tint = Purple)
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                Text(subtitle, style = MaterialTheme.typography.labelMedium, color = Muted)
            }
            Icon(Icons.Outlined.ChevronRight, null, tint = Muted)
        }
    }
}
