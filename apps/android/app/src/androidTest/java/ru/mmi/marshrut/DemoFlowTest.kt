package ru.mmi.marshrut

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import java.io.File
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.lifecycle.ViewModelProvider
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import ru.mmi.marshrut.core.data.DemoStore
import ru.mmi.marshrut.core.model.VisitStatus

@RunWith(AndroidJUnit4::class)
class DemoFlowTest {
    private val compose = createAndroidComposeRule<MainActivity>()
    private val cleanDemo = object : ExternalResource() {
        override fun before() {
            InstrumentationRegistry.getInstrumentation().targetContext
                .getSharedPreferences("marshrut_demo_v1", Context.MODE_PRIVATE).edit().clear().commit()
            InstrumentationRegistry.getInstrumentation().targetContext
                .getSharedPreferences("marsh_connection_v1", Context.MODE_PRIVATE).edit().clear().commit()
        }
    }
    @get:Rule val rules: RuleChain = RuleChain.outerRule(cleanDemo).around(compose)
    private fun login() {
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Войти в демо").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Войти в демо").performScrollTo().performClick()
        compose.waitUntil(10_000) { compose.onAllNodesWithContentDescription("Открыть заявку A-1428").fetchSemanticsNodes().isNotEmpty() }
    }
    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "screenshots/$name.png")
        file.parentFile!!.mkdirs()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    @Test fun captureReferenceScreens() {
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Войти в демо").fetchSemanticsNodes().isNotEmpty() }
        capture("01-login")
        login()
        capture("02-today")
        compose.onNodeWithContentDescription("Открыть заявку A-1428").performClick()
        capture("03-visit")
        compose.onNodeWithContentDescription("Назад").performClick()
        compose.onNodeWithText("Уведомления").performClick()
        capture("04-notifications")
        compose.onNodeWithText("Профиль").performClick()
        capture("05-profile")
    }
    @Test fun completeVisitPersistsAfterActivityRecreation() {
        login()
        compose.onNodeWithText("Выехать").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("В пути").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithContentDescription("Открыть заявку A-1428").performClick()
        compose.onNodeWithText("Начать работу").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Оформить отчёт").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Оформить отчёт").performClick()
        compose.onNodeWithText("Завершить", substring = false).assertIsNotEnabled()
        compose.onNodeWithText("Результат работы").assertIsEnabled().performTextInput("Диагностика выполнена, оборудование исправно.")
        compose.onNodeWithText("Диагностика выполнена, оборудование исправно.").assertExists()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val files = ru.mmi.marshrut.core.data.EvidenceFiles(context)
        val photo = files.newCapture(false)
        val bitmap = Bitmap.createBitmap(320, 240, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(android.graphics.Color.rgb(60, 130, 90))
        photo.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }; bitmap.recycle()
        lateinit var model: MarshrutViewModel
        compose.activityRule.scenario.onActivity { model = ViewModelProvider(it)[MarshrutViewModel::class.java]; model.addCaptured("A-1428", photo.absolutePath, false) }
        compose.waitUntil(10_000) { model.state.value?.visits?.get(1)?.media?.size == 1 && !model.connection.value.busy }
        compose.activityRule.scenario.onActivity {
            (it.getSystemService(Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
                .hideSoftInputFromWindow(it.window.decorView.windowToken, 0)
        }
        // Transient status snackbars can cover the scrollable confirmation row.
        compose.waitUntil(10_000) { compose.onAllNodesWithText("· сохранено на устройстве", substring = true).fetchSemanticsNodes().isEmpty() }
        compose.onNodeWithTag("report-confirmation").performScrollTo().assertIsOff().performClick().assertIsOn()
        compose.onNodeWithText("Завершить", substring = false).assertIsEnabled().performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithText("Вернуться к заявке").fetchSemanticsNodes().isNotEmpty() }
        compose.activityRule.scenario.recreate()
        compose.waitUntil(10_000) { compose.onAllNodesWithText("Вернуться к заявке").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Вернуться к заявке").performClick()
        compose.onNodeWithText("Вернуться к расписанию").performClick()
        compose.waitUntil(5_000) { compose.onAllNodesWithTag("schedule").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("schedule").performScrollToNode(hasText("Выполнено 2 из 4"))
        compose.onNodeWithText("Выполнено 2 из 4").assertIsDisplayed()
        val saved = DemoStore(InstrumentationRegistry.getInstrumentation().targetContext).load()
        assertEquals(VisitStatus.COMPLETED, saved.visits[1].status)
        assertEquals("Диагностика выполнена, оборудование исправно.", saved.visits[1].report)
    }
    @Test fun problemNotificationAndAllNavigationWork() {
        login()
        compose.onNodeWithContentDescription("Открыть заявку A-1428").performClick()
        compose.onNodeWithText("Сообщить о проблеме").performClick()
        compose.onNodeWithText("Описание проблемы").performTextInput("Дверь закрыта, жду ответственного.")
        compose.onNodeWithText("Сообщить и приостановить").performClick()
        compose.waitUntil(10_000) {
            DemoStore(InstrumentationRegistry.getInstrumentation().targetContext).load().visits[1].problems.isNotEmpty()
        }
        compose.onNodeWithContentDescription("Назад").performClick()
        compose.onNodeWithText("Уведомления").performClick()
        try {
            compose.waitUntil(5_000) { compose.onAllNodesWithText("Приостановлена · A-1428").fetchSemanticsNodes().isNotEmpty() }
        } catch (error: Exception) {
            throw AssertionError("Notification navigation failed:\n" + compose.onRoot().printToString(), error)
        }
        compose.onNodeWithText("Приостановлена · A-1428").performClick()
        compose.onNodeWithText("Заявка A-1428").assertIsDisplayed()
        compose.onNodeWithContentDescription("Назад").performClick()
        compose.onNodeWithText("Прочитать все").performClick()
        compose.onNodeWithText("Профиль").performClick()
        compose.onNodeWithText("Алексей Смирнов").assertIsDisplayed()
        compose.onNodeWithText("Сбросить демо").performScrollTo().performClick()
        compose.onNodeWithText("Сбросить", substring = false).performClick()
        compose.onNodeWithText("Сегодня", substring = false).performClick()
        compose.onNodeWithContentDescription("Открыть заявку A-1428").assertIsDisplayed()
    }
    @Test fun everyScheduleCardOpensItsOwnVisitAndBackReturns() {
        login()
        for (id in listOf("A-1425", "A-1430", "A-1435")) {
            compose.onNodeWithContentDescription("Открыть заявку $id").performScrollTo().performClick()
            compose.onNodeWithText("Заявка $id").assertIsDisplayed()
            compose.onNodeWithContentDescription("Назад").performClick()
        }
    }
}
