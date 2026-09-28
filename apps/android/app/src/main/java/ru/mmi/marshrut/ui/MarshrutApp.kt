package ru.mmi.marshrut.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.*
import kotlinx.coroutines.launch
import ru.mmi.marshrut.MarshrutViewModel
import ru.mmi.marshrut.core.model.*
import ru.mmi.marshrut.core.navigation.openNavigator
import ru.mmi.marshrut.feature.notifications.NotificationsScreen
import ru.mmi.marshrut.feature.onboarding.LoginScreen
import ru.mmi.marshrut.feature.onboarding.PasswordChangeScreen
import ru.mmi.marshrut.feature.profile.ConnectionScreen
import ru.mmi.marshrut.feature.visit.ReportScreen
import ru.mmi.marshrut.feature.profile.ProfileScreen
import ru.mmi.marshrut.feature.today.TodayScreen
import ru.mmi.marshrut.feature.visit.VisitScreen
import ru.mmi.marshrut.ui.theme.*

@Composable fun MarshrutApp(model: MarshrutViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val connection by model.connection.collectAsStateWithLifecycle()
    var connectionOpen by rememberSaveable { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model) { model.feedback.collect { snackbar.showSnackbar(it, duration = SnackbarDuration.Short) } }
    Scaffold(snackbarHost = { if (state?.signedIn != true || connectionOpen || connection.mustChangePassword) SnackbarHost(snackbar) }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            val current = state
            when {
                current == null -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                connectionOpen -> ConnectionScreen(connection, current.remote, { connectionOpen = false }, model::saveConnection,
                    model::testConnection, { model.refresh() }, model::discardQueue, model::retryProblem)
                connection.mustChangePassword && current.remote -> PasswordChangeScreen(connection, model::changePassword, model::signOut)
                !current.signedIn -> LoginScreen(connection, model::login, { connectionOpen = true }, model::signIn)
                else -> Workspace(current, model, snackbar) { connectionOpen = true }
            }
        }
    }
}

@Composable private fun Workspace(state: DemoState, model: MarshrutViewModel, snackbar: SnackbarHostState, openConnection: () -> Unit) {
    val nav = rememberNavController()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route ?: "today"
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val detailRoute = route.startsWith("visit/") || route.startsWith("report/")
    fun openVisit(id: String) { nav.navigate("visit/$id") { launchSingleTop = true } }
    fun openReport(id: String) { nav.navigate("report/$id") { launchSingleTop = true } }
    fun tab(id: String) { nav.navigate(id) {
        popUpTo(nav.graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true; restoreState = true
    } }
    Scaffold(contentWindowInsets = WindowInsets(0, 0, 0, 0),
        snackbarHost = { if (!detailRoute) SnackbarHost(snackbar) }, bottomBar = {
        if (!detailRoute) NavigationBar(containerColor = NavSurface, tonalElevation = 0.dp,
            windowInsets = WindowInsets(0, 0, 0, 0), modifier = Modifier.clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))) {
            val tabs = listOf(Triple("today", "Сегодня", Icons.Outlined.Today), Triple("notifications", "Уведомления", Icons.Outlined.Notifications), Triple("profile", "Профиль", Icons.Outlined.Person))
            tabs.forEach { (id, label, icon) ->
                NavigationBarItem(selected = route == id, onClick = { tab(id) }, label = { Text(label, style = MaterialTheme.typography.labelMedium) },
                    colors = NavigationBarItemDefaults.colors(indicatorColor = Lilac, selectedIconColor = Purple, selectedTextColor = Purple),
                    icon = {
                        if (id == "notifications" && state.notices.any { !it.read }) BadgedBox(badge = { Badge { Text(state.notices.count { !it.read }.toString()) } }) { Icon(icon, null) }
                        else Icon(icon, null)
                    })
            }
        }
    }) { padding ->
        NavHost(nav, startDestination = "today", modifier = Modifier.padding(padding).fillMaxSize()) {
            composable("today") {
                TodayScreen(state, ::openVisit, { model.transition(it, VisitStatus.EN_ROUTE) }, { tab("profile") },
                    { model.refresh(date = it) }, { model.refresh() }, openConnection, { model.transition(it, VisitStatus.IN_PROGRESS) }, ::openReport)
            }
            composable("notifications") {
                NotificationsScreen(state.notices, { notice -> model.readNotice(notice.id); notice.visitId?.let { openVisit(it) } }, model::readAll)
            }
            composable("profile") { ProfileScreen(state, model::toggleShift, model::reset, model::signOut, openConnection) }
            composable("visit/{id}") { visitEntry ->
                val visit = state.visits.firstOrNull { it.id == visitEntry.arguments?.getString("id") }
                if (visit != null) VisitScreen(visit, state, snackbar, { nav.popBackStack() }, {
                    if (!openNavigator(context, visit)) scope.launch { snackbar.showSnackbar("Навигатор не установлен. Установите приложение карт, чтобы открыть адрес.") }
                }, { target, report -> model.transition(visit.id, target, report) }, { reason, details -> model.problem(visit.id, reason, details) },
                    { openReport(visit.id) })
                else Column(Modifier.padding(24.dp)) { Text("Заявка не найдена"); TextButton({ nav.popBackStack() }) { Text("Назад") } }
            }
            composable("report/{id}") { reportEntry ->
                val visit = state.visits.firstOrNull { it.id == reportEntry.arguments?.getString("id") }
                if (visit != null) ReportScreen(visit, state.remote, model, { nav.popBackStack() }, snackbar)
                else Column(Modifier.padding(24.dp)) { Text("Заявка больше не назначена вам"); TextButton({ nav.popBackStack() }) { Text("Назад") } }
            }
        }
    }
}
