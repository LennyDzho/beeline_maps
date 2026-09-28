package ru.mmi.marshrut.feature.onboarding

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import ru.mmi.marshrut.ui.components.*
import ru.mmi.marshrut.ui.theme.*

@Composable fun DemoLoginScreen(signIn: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.Center) {
        Spacer(Modifier.height(28.dp))
        Box(Modifier.size(76.dp).clip(RoundedCornerShape(24.dp)).background(Purple), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.Route, null, Modifier.size(40.dp), tint = Canvas)
        }
        Spacer(Modifier.height(24.dp))
        Text("Марш!", style = MaterialTheme.typography.headlineLarge)
        Spacer(Modifier.height(8.dp))
        Text("Ваш рабочий день.\nВсе визиты под рукой.", style = MaterialTheme.typography.headlineSmall, color = Muted)
        Spacer(Modifier.height(32.dp))
        Surface(color = SoftSurface, shape = RoundedCornerShape(24.dp)) {
            Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Pill("Демонстрационная версия")
                Text("Алексей Смирнов", style = MaterialTheme.typography.titleLarge)
                Text("Выездной инженер · Демо-команда", style = MaterialTheme.typography.bodyMedium, color = Muted)
                HorizontalDivider(color = Line.copy(alpha = .5f))
                Text("4 визита, расписание и история работы. Попробуйте выезд, завершение заявки и сообщение о проблеме.", style = MaterialTheme.typography.bodyMedium)
                Text("Данные учебные. Все изменения сохраняются только на этом устройстве.", style = MaterialTheme.typography.bodyMedium, color = Muted)
            }
        }
        Spacer(Modifier.height(28.dp))
        PrimaryButton("Войти в демо", Modifier.fillMaxWidth(), Icons.Outlined.ArrowForward, onClick = signIn)
        Spacer(Modifier.height(16.dp))
        Text("Марш! для Android · 0.1.0", style = MaterialTheme.typography.labelMedium, color = Muted,
            modifier = Modifier.align(Alignment.CenterHorizontally))
        Spacer(Modifier.height(24.dp))
    }
}
