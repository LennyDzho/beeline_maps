package ru.mmi.marshrut.feature.visit

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.ui.theme.*

@Composable fun CompletionDialog(id: String, dismiss: () -> Unit, submit: (String) -> Unit) {
    var report by rememberSaveable(id) { mutableStateOf("") }
    var checked by rememberSaveable(id) { mutableStateOf(false) }
    AlertDialog(onDismissRequest = dismiss, icon = { Icon(Icons.Outlined.TaskAlt, null) }, title = { Text("Завершить визит?") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Добавьте результат работы по $id. Он останется в карточке заявки.")
                OutlinedTextField(report, { report = it.take(2000) }, label = { Text("Результат работы") },
                    placeholder = { Text("Что сделано и проверено") }, minLines = 3, maxLines = 5, modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("Минимум 10 символов · ${report.length}/2000") })
                Row(Modifier.fillMaxWidth().clickable { checked = !checked }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked, { checked = it }); Text("Работа выполнена, результат проверен", style = MaterialTheme.typography.bodyMedium)
                }
                Text("Демо: отчёт сохранится на устройстве.", style = MaterialTheme.typography.labelMedium, color = Muted)
            }
        }, confirmButton = { TextButton({ submit(report) }, enabled = checked && report.trim().length >= 10) { Text("Завершить") } },
        dismissButton = { TextButton(dismiss) { Text("Отмена") } })
}

@Composable fun ProblemDialog(id: String, dismiss: () -> Unit, submit: (String, String) -> Unit, remote: Boolean = false) {
    val reasons = listOf("Нет доступа на объект", "Нет нужных материалов", "Неисправность сложнее", "Другая проблема")
    var reason by rememberSaveable(id) { mutableStateOf(reasons.first()) }
    var details by rememberSaveable(id) { mutableStateOf("") }
    AlertDialog(onDismissRequest = dismiss, icon = { Icon(Icons.Outlined.ReportProblem, null, tint = Gold) },
        title = { Text("Сообщить о проблеме") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("Что мешает выполнить $id?", style = MaterialTheme.typography.bodyMedium)
                reasons.forEach { item ->
                    Row(Modifier.fillMaxWidth().clickable { reason = item }, verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(reason == item, { reason = item }); Text(item, style = MaterialTheme.typography.bodyMedium)
                    }
                }
                OutlinedTextField(details, { details = it.take(1000) }, label = { Text("Описание проблемы") },
                    minLines = 2, maxLines = 4, modifier = Modifier.fillMaxWidth(), supportingText = { Text("Минимум 5 символов") })
                Text(if (remote) "После синхронизации заявка станет приостановленной, а сообщение с временем появится в журнале диспетчера. Можно будет перейти к другой задаче. Чтобы вернуться — нажмите «Продолжить»." else "Заявка будет приостановлена. Можно перейти к другой задаче и вернуться через «Продолжить». В демо сообщение сохраняется только на устройстве.", style = MaterialTheme.typography.labelMedium, color = Muted)
            }
        }, confirmButton = { TextButton({ submit(reason, details) }, enabled = details.trim().length in 5..1000) { Text("Сообщить и приостановить") } },
        dismissButton = { TextButton(dismiss) { Text("Отмена") } })
}
