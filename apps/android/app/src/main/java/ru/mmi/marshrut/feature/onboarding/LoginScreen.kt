package ru.mmi.marshrut.feature.onboarding

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.ConnectionUi
import ru.mmi.marshrut.ui.theme.*

@Composable fun LoginScreen(connection: ConnectionUi, login: (String, String) -> Unit, openConnection: () -> Unit, demo: () -> Unit) {
    var email by rememberSaveable(connection.email) { mutableStateOf(connection.email) }
    var password by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Spacer(Modifier.height(20.dp))
        Icon(Icons.Outlined.Route, null, Modifier.size(56.dp), tint = Purple)
        Text("Марш!", style = MaterialTheme.typography.headlineLarge)
        Text("Вход исполнителя", style = MaterialTheme.typography.titleLarge)
        Text("Используйте учётную запись, которую администратор связал с вашей карточкой исполнителя.", color = Muted)
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, enabled = !connection.busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(password, { password = it }, label = { Text("Пароль") }, singleLine = true, enabled = !connection.busy,
            visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), modifier = Modifier.fillMaxWidth(),
            trailingIcon = { IconButton({ visible = !visible }) { Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, "Показать или скрыть пароль") } })
        Button({ login(email, password) }, Modifier.fillMaxWidth().heightIn(min = 52.dp), enabled = !connection.busy && email.contains('@') && password.length >= 8) {
            if (connection.busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Войти")
        }
        OutlinedButton(openConnection, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !connection.busy) { Icon(Icons.Outlined.SettingsEthernet, null); Spacer(Modifier.width(8.dp)); Text("Связь с сервером") }
        Text(connection.server, style = MaterialTheme.typography.labelMedium, color = Muted)
        Text(connection.message, color = Muted, style = MaterialTheme.typography.bodyMedium)
        HorizontalDivider(color = Line)
        TextButton(demo, Modifier.align(Alignment.CenterHorizontally), enabled = !connection.busy) { Text("Войти в демо") }
        Text("Демо работает с учебными данными на устройстве.", style = MaterialTheme.typography.labelMedium, color = Muted)
    }
}

@Composable fun PasswordChangeScreen(connection: ConnectionUi, submit: (String, String) -> Unit, logout: () -> Unit) {
    var current by remember { mutableStateOf("") }; var next by remember { mutableStateOf("") }; var repeat by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("Марш!", style = MaterialTheme.typography.headlineLarge)
        Text("Смените временный пароль", style = MaterialTheme.typography.titleLarge)
        Text("После смены пароля войдите снова. Старые сессии будут закрыты.", color = Muted)
        OutlinedTextField(current, { current = it }, label = { Text("Текущий пароль") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(next, { next = it }, label = { Text("Новый пароль") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(repeat, { repeat = it }, label = { Text("Повторите новый пароль") }, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        Text("От 8 до 128 символов", color = Muted)
        Button({ submit(current, next) }, enabled = !connection.busy && next.length in 8..128 && next == repeat && next != current) { Text("Сохранить пароль") }
        Text(connection.message, color = Muted)
        TextButton(logout, enabled = !connection.busy) { Text("Выйти") }
    }
}
