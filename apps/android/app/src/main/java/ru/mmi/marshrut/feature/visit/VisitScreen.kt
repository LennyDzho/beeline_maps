package ru.mmi.marshrut.feature.visit

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.core.model.*
import ru.mmi.marshrut.ui.components.*
import ru.mmi.marshrut.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun VisitScreen(visit: Visit, state: DemoState, snackbar: SnackbarHostState, back: () -> Unit, navigate: () -> Unit,
    transition: (VisitStatus, String) -> Unit, problem: (String, String) -> Unit, openReport: () -> Unit) {
    var dialog by rememberSaveable(visit.id) { mutableStateOf<String?>(null) }
    val complete = visit.status == VisitStatus.COMPLETED
    val anotherActive = state.activeVisit != null && state.activeVisit?.id != visit.id
    val available = state.onShift && !anotherActive && !visit.pending
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            Column {
                TopAppBar(title = { Text("Заявка ${visit.number}", style = MaterialTheme.typography.titleLarge) },
                    navigationIcon = { IconButton(back) { Icon(Icons.Outlined.ArrowBack, "Назад") } })
                HorizontalDivider(color = Line.copy(alpha = .5f))
            }
        },
        bottomBar = {
            Surface(shadowElevation = 6.dp, color = Canvas) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    if (complete) {
                        PrimaryButton("Вернуться к расписанию", Modifier.fillMaxWidth(), Icons.Outlined.Check, onClick = back)
                    } else {
                        if (!available) Text(if (visit.pending) "Действие ожидает синхронизации" else if (anotherActive) "Сначала завершите или приостановите ${state.activeVisit?.id}" else "Начните смену в профиле",
                            Modifier.padding(bottom = 8.dp), color = Gold, style = MaterialTheme.typography.labelMedium)
                        PrimaryButton(when (visit.status) { VisitStatus.IN_PROGRESS -> "Оформить отчёт"; VisitStatus.PAUSED -> "Продолжить"; else -> "Начать работу" },
                            Modifier.fillMaxWidth(), if (visit.status == VisitStatus.IN_PROGRESS) Icons.Outlined.CheckCircle else Icons.Outlined.PlayCircle,
                            enabled = available) {
                            if (visit.status == VisitStatus.IN_PROGRESS) openReport() else transition(VisitStatus.IN_PROGRESS, "")
                        }
                        if (visit.status == VisitStatus.PAUSED) TextButton(back, Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                            Text("К другим задачам")
                        } else TextButton({ dialog = "problem" }, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !visit.pending) {
                            Text("Сообщить о проблеме", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState())) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                if (visit.highPriority) Pill("Высокий приоритет", Gold, GoldLight, Icons.Outlined.PriorityHigh)
                StatusPill(visit.status)
                Text(visit.title, style = MaterialTheme.typography.headlineSmall)
                if (!state.remote) AreaSketch()
                if (visit.description.isNotBlank()) Text(visit.description, style = MaterialTheme.typography.bodyLarge)
                if (visit.pending) Pill("Действие в очереди отправки", Gold, GoldLight)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Outlined.LocationOn, null, Modifier.size(26.dp), tint = Purple)
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(visit.address, style = MaterialTheme.typography.bodyLarge)
                        Text(visit.entrance, color = Muted, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedButton(navigate, Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Icon(Icons.Outlined.Navigation, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp)); Text("Открыть в навигаторе")
                }
            }
            HorizontalDivider(color = Line.copy(alpha = .45f))
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Детали визита", style = MaterialTheme.typography.titleLarge)
                if (visit.categoryName.isNotBlank()) Text("Тип ВК: ${visit.categoryName}", style = MaterialTheme.typography.bodyLarge)
                if (state.profile.timezoneLabel.isNotBlank()) Text("Время региона: ${state.profile.timezoneLabel}", style = MaterialTheme.typography.bodyMedium, color = Muted)
                if (visit.clientWindow.isNotBlank()) DetailTile("Окно клиента · начало работ", visit.clientWindow, Icons.Outlined.Event, Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    DetailTile(if (state.remote) "План работ" else "Окно прибытия", visit.window, Icons.Outlined.Schedule, Modifier.weight(1f))
                    DetailTile("Норматив работ", visit.duration, Icons.Outlined.HourglassEmpty, Modifier.weight(1f))
                }
                if (state.remote) {
                    Text("Требуемое оборудование", style = MaterialTheme.typography.titleLarge)
                    if (visit.equipment.isEmpty()) Text("Перечень не задан", color = Muted, style = MaterialTheme.typography.bodyMedium)
                    visit.equipment.forEach { equipment ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(equipment.name, style = MaterialTheme.typography.bodyLarge)
                            Text(equipment.description, color = Muted, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(16.dp),
                    border = androidx.compose.foundation.BorderStroke(1.dp, Line.copy(alpha = .5f))) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Box(Modifier.size(48.dp).clip(CircleShape).background(Lilac), contentAlignment = Alignment.Center) {
                            Icon(Icons.Outlined.Engineering, null, tint = Purple)
                        }
                        Column {
                            Text("Требуемая компетенция", style = MaterialTheme.typography.labelMedium, color = Muted)
                            Spacer(Modifier.height(4.dp)); Text(visit.skill, style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
                Spacer(Modifier.height(4.dp))
                Text("Ход выполнения", style = MaterialTheme.typography.titleLarge)
                EventTimeline(visit)
                if (visit.problems.isNotEmpty()) {
                    Surface(color = GoldLight, shape = RoundedCornerShape(16.dp)) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Журнал проблем", style = MaterialTheme.typography.titleMedium, color = Gold)
                            visit.problems.forEach { Text(it, style = MaterialTheme.typography.bodyMedium, color = Gold) }
                            Text(if (state.remote) "Передано диспетчеру" else "Сохранено локально · демо", style = MaterialTheme.typography.labelMedium, color = Gold)
                        }
                    }
                }
                if (complete) Surface(color = Color(0xFFE2EEE6), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Результат работы", style = MaterialTheme.typography.titleMedium, color = Success)
                        Text(visit.report, style = MaterialTheme.typography.bodyMedium)
                        Text(if (state.remote) if (visit.reportStatus == "accepted") "Принято диспетчером" else "Отчёт отправлен на сервер" else "Отчёт сохранён на устройстве", style = MaterialTheme.typography.labelMedium, color = Success)
                        OutlinedButton(openReport) { Text("Фото, видео и отчёт (${visit.media.size})") }
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
        }
    }
    when (dialog) {
        "problem" -> ProblemDialog(visit.id, { dialog = null }, { reason, details -> problem(reason, details); dialog = null }, state.remote)
    }
}

@Composable private fun DetailTile(label: String, value: String, icon: ImageVector, modifier: Modifier) {
    Surface(modifier, color = SoftSurface, shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Line.copy(alpha = .4f))) {
        Column(Modifier.padding(16.dp).heightIn(min = 92.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, tint = MaterialTheme.colorScheme.secondary)
            Text(label, style = MaterialTheme.typography.labelMedium, color = Muted)
            Text(value, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable private fun EventTimeline(visit: Visit) {
    Surface(shape = RoundedCornerShape(16.dp), border = androidx.compose.foundation.BorderStroke(1.dp, Line.copy(alpha = .4f))) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            visit.events.forEachIndexed { index, event ->
                Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Box(Modifier.size(30.dp).clip(CircleShape).background(Purple), contentAlignment = Alignment.Center) {
                            Icon(if (event.title.contains("проблеме")) Icons.Outlined.PriorityHigh else Icons.Outlined.Check, null, Modifier.size(18.dp), tint = Color.White)
                        }
                        if (index < visit.events.lastIndex || visit.status != VisitStatus.COMPLETED) Box(Modifier.width(2.dp).weight(1f).background(Line))
                    }
                    Column(Modifier.weight(1f).padding(top = 3.dp, bottom = 22.dp)) {
                        Text(event.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                        Text(event.detail, style = MaterialTheme.typography.bodyMedium, color = Muted)
                    }
                }
            }
            if (visit.status != VisitStatus.COMPLETED) Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.RadioButtonUnchecked, null, Modifier.size(30.dp), tint = Line)
                Text(if (visit.status == VisitStatus.IN_PROGRESS) "Завершение работы" else "В работе", color = Muted)
            }
        }
    }
}
