package ru.mmi.marshrut.feature.profile

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.ConnectionUi
import ru.mmi.marshrut.core.data.ServerAddress
import ru.mmi.marshrut.core.model.ProblemRetry
import ru.mmi.marshrut.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun ConnectionScreen(connection: ConnectionUi, remote: Boolean, back: () -> Unit, save: (String) -> Unit,
    test: (String) -> Unit, sync: () -> Unit, discard: () -> Unit, retryProblem: (ProblemRetry) -> Unit = {}) {
    var server by rememberSaveable(connection.server) { mutableStateOf(connection.server) }
    var confirm by remember { mutableStateOf(false) }
    var retryConfirmation by remember { mutableStateOf<ProblemRetry?>(null) }
    Scaffold(contentWindowInsets = WindowInsets(0,0,0,0), topBar = { TopAppBar(title = { Text("Связь") }, navigationIcon = { IconButton(back) { Icon(Icons.Outlined.ArrowBack, "Назад") } }) }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Сервер приложения", style = MaterialTheme.typography.titleLarge)
            OutlinedTextField(server, { server = it }, label = { Text("Адрес сервера") }, placeholder = { Text("https://example.ru") },
                modifier = Modifier.fillMaxWidth(), singleLine = true, enabled = !connection.busy, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            Text("В эмуляторе 10.0.2.2 — это ваш компьютер. Для интернет-сервера укажите адрес с HTTPS.", color = Muted)
            TextButton({ server = ServerAddress.DEFAULT }, enabled = !connection.busy) { Text("Локальный сервер для эмулятора") }
            OutlinedButton({ test(server) }, Modifier.fillMaxWidth(), enabled = !connection.busy) { Text("Проверить связь") }
            Button({ save(server) }, Modifier.fillMaxWidth(), enabled = !connection.busy && server.isNotBlank()) { Text("Сохранить адрес") }
            if (server != connection.server) Text("После смены сервера потребуется вход. Черновики останутся привязаны к прежнему серверу и аккаунту.", style = MaterialTheme.typography.bodyMedium, color = Muted)
            if (connection.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            Text(connection.message, style = MaterialTheme.typography.bodyLarge)
            if (remote) {
                HorizontalDivider(color = Line)
                Text("Синхронизация", style = MaterialTheme.typography.titleLarge)
                Text("Данные обновляются при работе приложения и по кнопке. При потере сети отчёт и действия сохраняются на устройстве.", color = Muted)
                Button(sync, Modifier.fillMaxWidth(), enabled = !connection.busy) { Text("Синхронизировать сейчас") }
                Text("Действий в очереди: ${connection.pending.size}")
                connection.pending.forEach { Text(it, style = MaterialTheme.typography.bodyMedium) }
                connection.problemRetry?.let { retry ->
                    Surface(color = GoldLight, shape = MaterialTheme.shapes.medium) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Не отправлена проблема по ${retry.visitId}", style = MaterialTheme.typography.titleMedium)
                            Text("${retry.reason}: ${retry.details}")
                            Text("Сообщение сохранено на устройстве. Проверьте актуальную заявку перед повторной отправкой.")
                            Button({ retryConfirmation = retry }, Modifier.fillMaxWidth(), enabled = !connection.busy) { Text("Повторить отправку проблемы") }
                        }
                    }
                }
                if (connection.pending.isNotEmpty()) TextButton({ confirm = true }, enabled = !connection.busy) { Text("Убрать действия из очереди") }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("Очистить очередь?") },
        text = { Text("Неотправленные действия будут убраны из очереди. Уже принятые сервером изменения сохранятся. Черновики с фото и видео останутся на устройстве.") },
        confirmButton = { TextButton({ confirm = false; discard() }) { Text("Очистить очередь") } }, dismissButton = { TextButton({ confirm = false }) { Text("Отмена") } })
    retryConfirmation?.let { retry ->
        AlertDialog(onDismissRequest = { retryConfirmation = null }, title = { Text("Отправить проблему повторно?") },
            text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${retry.visitId} · ${retry.status.label}")
                Text(retry.address)
                Text(retry.window)
                Text("${retry.reason}: ${retry.details}")
                Text("После принятия сервером заявка будет приостановлена, а сообщение появится у диспетчера. Если заявка снова изменилась, потребуется повторная проверка.")
            } },
            confirmButton = { TextButton({ retryConfirmation = null; retryProblem(retry) }, enabled = !connection.busy) { Text("Отправить и приостановить") } },
            dismissButton = { TextButton({ retryConfirmation = null }) { Text("Отмена") } })
    }
}
