package ru.mmi.marshrut

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.*
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import ru.mmi.marshrut.core.data.*
import ru.mmi.marshrut.core.model.VisitStatus

/** Only runs with an explicit disposable local host; never the default server. */
@RunWith(AndroidJUnit4::class)
class CompositeConnectedTest {
    private val compose = createAndroidComposeRule<MainActivity>()
    private val args get() = InstrumentationRegistry.getArguments()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val setup = object : ExternalResource() { override fun before() {
        Assume.assumeTrue(args.getString("isolatedHost") == "true")
        val server = args.getString("testServer") ?: error("Disposable server required")
        require(server.startsWith("http://10.0.2.2:") && !server.endsWith(":3000"))
        context.getSharedPreferences("marshrut_demo_v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("marsh_connection_v1", Context.MODE_PRIVATE).edit().clear().commit()
        ConnectionStore(context).saveSettings(ConnectionSettings(server = server))
    } }
    @get:Rule val rules: RuleChain = RuleChain.outerRule(setup).around(compose)

    @Test fun publishedPlanProblemCompositeReportAndAcceptance() {
        compose.waitUntil(20_000) { compose.onAllNodesWithText("Email", substring = false).fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Email", substring = false).performTextInput(args.getString("testEmail")!!)
        compose.onNodeWithText("Пароль", substring = false).performTextInput(args.getString("testPassword")!!)
        compose.onNodeWithText("Войти", substring = false).performScrollTo().performClick()
        lateinit var model: MarshrutViewModel
        compose.activityRule.scenario.onActivity { model = ViewModelProvider(it)[MarshrutViewModel::class.java] }
        compose.waitUntil(30_000) { model.state.value?.remote == true && !model.connection.value.busy }
        model.refresh(date = "2026-08-20")
        val id = args.getString("testVisitId")!!
        compose.waitUntil(30_000) { model.state.value?.visits?.any { it.id == id } == true && !model.connection.value.busy }
        assertEquals(2, model.state.value!!.visits.single().reportSections.size)
        model.transition(id, VisitStatus.EN_ROUTE)
        compose.waitUntil(30_000) { model.state.value!!.visits.single().status == VisitStatus.EN_ROUTE && !model.connection.value.busy }
        model.problem(id, "Нет доступа", "Тест: абонент временно не открыл дверь")
        compose.waitUntil(30_000) { model.state.value!!.visits.single().status == VisitStatus.PAUSED && !model.connection.value.busy }
        model.transition(id, VisitStatus.IN_PROGRESS)
        compose.waitUntil(30_000) { model.state.value!!.visits.single().status == VisitStatus.IN_PROGRESS && !model.connection.value.busy }
        compose.onNodeWithContentDescription("Открыть заявку $id").performClick()
        compose.onNodeWithText("Оформить отчёт").performClick()
        compose.onNodeWithText("Уровень сигнала *").performScrollTo().performTextInput("-18 dBm")
        compose.onNodeWithText("Серийный номер *").performScrollTo().performTextInput("SN-DEVICE-123")
        compose.onNodeWithText("Результат работы").performScrollTo().performTextInput("Линия и роутер проверены, обе работы выполнены.")
        val photo = model.files.newCapture(false)
        val bitmap = Bitmap.createBitmap(100,100,Bitmap.Config.ARGB_8888)
        photo.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG,90,it) }; bitmap.recycle()
        val video = model.files.newCapture(true); writeTestVideo(video)
        model.addCaptured(id, photo.absolutePath, false); model.addCaptured(id, video.absolutePath, true)
        compose.waitUntil(30_000) { model.state.value!!.visits.single().media.size == 2 && !model.connection.value.busy }
        compose.onNodeWithTag("report-confirmation").performScrollTo().performClick()
        compose.onNodeWithText("Отправить отчёт и завершить").assertIsEnabled().performClick()
        compose.waitUntil(90_000) { model.state.value!!.visits.single().status == VisitStatus.COMPLETED && !model.connection.value.busy }
        model.refresh()
        compose.waitUntil(30_000) { model.state.value!!.visits.single().reportStatus == "accepted" && !model.connection.value.busy }
        val visit = model.state.value!!.visits.single()
        assertEquals(listOf("-18 dBm", "SN-DEVICE-123"), visit.reportSections.map { it.fields.single().value })
        val settings = ConnectionStore(context).settings()
        assertEquals(0, ConnectionStore(context).queue(settings).length())
        compose.activityRule.scenario.recreate()
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Вернуться к заявке").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("SN-DEVICE-123").assertExists()
    }
}
