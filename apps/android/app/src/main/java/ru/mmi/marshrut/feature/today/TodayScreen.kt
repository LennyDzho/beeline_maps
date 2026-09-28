package ru.mmi.marshrut.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.core.model.*
import ru.mmi.marshrut.ui.components.*
import ru.mmi.marshrut.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun TodayScreen(state: DemoState, openVisit: (String) -> Unit, depart: (String) -> Unit, openProfile: () -> Unit,
    dateChanged: (String) -> Unit, refresh: () -> Unit, openConnection: () -> Unit, resume: (String) -> Unit,
    openReport: (String) -> Unit) {
    var calendar by rememberSaveable { mutableStateOf(false) }
    val next = state.nextVisit
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().background(Color.White).padding(horizontal = 16.dp, vertical = 18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Добрый день, ${state.profile.name.split(" ").first()}", style = MaterialTheme.typography.titleMedium)
                    if (state.remote) TextButton({ calendar = true }, contentPadding = PaddingValues(0.dp)) { Icon(Icons.Outlined.CalendarMonth, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(state.serviceDate) }
                    else Text("20 августа · демо", style = MaterialTheme.typography.bodyMedium, color = Muted)
                }
                Box(Modifier.clip(CircleShape).clickable(onClick = openProfile).padding(vertical = 8.dp)) {
                    Pill(if (state.onShift) "В смене" else "Вне смены", Gold, GoldLight,
                        if (state.onShift) Icons.Outlined.Circle else Icons.Outlined.PauseCircle)
                }
            }
            if (state.remote && state.profile.timezoneLabel.isNotBlank()) Text("Время региона: ${state.profile.timezoneLabel}", style = MaterialTheme.typography.labelSmall, color = Muted)
            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text("Заявок ${if (state.remote) "на день" else "на сегодня"}: ${state.visits.size}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(Icons.Outlined.OfflinePin, null, Modifier.size(14.dp), tint = Muted)
                    if (state.remote) IconButton(refresh) { Icon(Icons.Outlined.Sync, "Обновить расписание") }
                    else Text("На устройстве", style = MaterialTheme.typography.labelMedium, color = Muted)
                }
            }
            if (state.remote) Text(state.syncMessage + if (state.pendingCount > 0) " · В очереди: ${state.pendingCount}" else "", Modifier.fillMaxWidth().clickable(onClick = openConnection), style = MaterialTheme.typography.labelMedium, color = Muted)
            if (state.remote && state.pendingCount > 0) TextButton(openConnection) { Text("Разобрать очередь отправки") }
        }
        LazyColumn(modifier = Modifier.testTag("schedule"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
            if (!state.onShift) item {
                Surface(onClick = openProfile, color = GoldLight, shape = RoundedCornerShape(12.dp), modifier = Modifier.padding(bottom = 16.dp)) {
                    Text("Вы вне смены. Начните смену в профиле, чтобы выполнять визиты.", Modifier.padding(16.dp), color = Gold, style = MaterialTheme.typography.bodyMedium)
                }
            }
            item {
                SectionLabel(if (state.activeVisit != null) "Текущий визит" else "Следующий визит")
                if (state.visits.isEmpty()) {
                    EmptyCard("Нет назначений на этот день", "Обновите данные или выберите другую дату.")
                    if (state.remote && state.availableDates.isNotEmpty()) TextButton({ dateChanged(state.availableDates.first()) }) { Text("Открыть задания за ${state.availableDates.first()}") }
                } else if (next == null) EmptyCard("Все визиты завершены", "Выполнено ${state.completedCount} из ${state.visits.size} заявок.")
                else NextVisitCard(next, state.onShift && !next.pending, { openVisit(next.id) }, { depart(next.id) }, { resume(next.id) }, { openReport(next.id) })
                Spacer(Modifier.height(24.dp))
                SectionLabel("Расписание")
            }
            items(state.orderedVisits.filter { it.id != next?.id }, key = { it.id }) { visit ->
                ScheduleCard(visit, { openVisit(visit.id) })
            }
            item {
                Spacer(Modifier.height(12.dp))
                Text("Выполнено ${state.completedCount} из ${state.visits.size}", style = MaterialTheme.typography.labelMedium, color = Muted)
                Spacer(Modifier.height(8.dp))
                LinearProgressIndicator(progress = state.completedCount.toFloat() / state.visits.size.coerceAtLeast(1),
                    modifier = Modifier.fillMaxWidth().height(4.dp).clip(CircleShape), trackColor = Lilac)
                Spacer(Modifier.height(12.dp))
            }
        }
    }
    if (calendar) {
        val picker = rememberDatePickerState(initialSelectedDateMillis = LocalDate.parse(state.serviceDate).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { calendar = false }, confirmButton = { TextButton({ picker.selectedDateMillis?.let { dateChanged(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString()) }; calendar = false }) { Text("Выбрать") } },
            dismissButton = { TextButton({ calendar = false }) { Text("Отмена") } }) { DatePicker(picker) }
    }
}

@Composable private fun NextVisitCard(visit: Visit, onShift: Boolean, details: () -> Unit, depart: () -> Unit, resume: () -> Unit, report: () -> Unit) {
    Row(Modifier.fillMaxWidth().shadow(4.dp, RoundedCornerShape(16.dp), ambientColor = Purple.copy(alpha = .12f))
        .clip(RoundedCornerShape(16.dp)).background(Color.White).height(IntrinsicSize.Min)
        .clickable(onClickLabel = "Открыть заявку", onClick = details)
        .semantics { contentDescription = "Открыть заявку ${visit.id}" }) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(Gold))
        Column(Modifier.padding(16.dp).weight(1f), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                IdBadge(visit.id)
                Text(visit.window, color = Gold, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold)
            }
            Text(visit.title, style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Outlined.LocationOn, null, Modifier.size(20.dp), tint = Muted)
                Column {
                    Text(visit.address, style = MaterialTheme.typography.bodyMedium, color = Muted)
                    Text(visit.entrance, style = MaterialTheme.typography.labelMedium, color = Muted)
                }
            }
            if (visit.status != VisitStatus.CONFIRMED) StatusPill(visit.status)
            HorizontalDivider(color = Line)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                when (visit.status) {
                    VisitStatus.CONFIRMED -> PrimaryButton("Выехать", icon = Icons.Outlined.DirectionsCar, enabled = onShift, onClick = depart)
                    VisitStatus.EN_ROUTE -> PrimaryButton("На месте", icon = Icons.Outlined.ArrowForward, onClick = details)
                    VisitStatus.PAUSED -> PrimaryButton("Продолжить", icon = Icons.Outlined.PlayArrow, enabled = onShift, onClick = resume)
                    VisitStatus.IN_PROGRESS -> PrimaryButton("Оформить отчёт", icon = Icons.Outlined.EditNote, enabled = onShift, onClick = report)
                    VisitStatus.COMPLETED -> Unit
                }
            }
        }
    }
}

@Composable private fun ScheduleCard(visit: Visit, open: () -> Unit) {
    val done = visit.status == VisitStatus.COMPLETED
    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        Box(Modifier.width(34.dp).fillMaxHeight()) {
            Box(Modifier.align(Alignment.TopCenter).width(2.dp).fillMaxHeight().background(Line))
            Box(Modifier.padding(top = 23.dp).size(16.dp).align(Alignment.TopCenter).clip(CircleShape)
                .background(if (done) Color(0xFFE6E0E9) else Line).border(3.dp, Canvas, CircleShape), contentAlignment = Alignment.Center) {
                if (done) Icon(Icons.Outlined.Check, null, Modifier.size(10.dp), tint = Muted)
            }
        }
        Surface(onClick = open, shape = RoundedCornerShape(12.dp), color = Color.White,
            border = androidx.compose.foundation.BorderStroke(1.dp, Line),
            modifier = Modifier.weight(1f).padding(start = 6.dp, bottom = 16.dp).alpha(if (done) .65f else 1f)
                .semantics { contentDescription = "Открыть заявку ${visit.id}" }) {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(visit.window, style = MaterialTheme.typography.labelMedium, color = Muted)
                    IdBadge(visit.id, done)
                }
                Text(visit.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium,
                    textDecoration = if (done) TextDecoration.LineThrough else null)
                Text(visit.address, style = MaterialTheme.typography.labelMedium, color = Muted)
                if (visit.status == VisitStatus.PAUSED) StatusPill(visit.status)
            }
        }
    }
}
