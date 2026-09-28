package ru.mmi.marshrut

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import ru.mmi.marshrut.core.data.*
import ru.mmi.marshrut.core.model.VisitStatus
import java.io.File
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class ConnectedFlowTest {
    private val compose = createAndroidComposeRule<MainActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val clean = object : ExternalResource() { override fun before() {
        context.getSharedPreferences("marshrut_demo_v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("marsh_connection_v1", Context.MODE_PRIVATE).edit().clear().commit()
    } }
    @get:Rule val rules: RuleChain = RuleChain.outerRule(clean).around(compose)
    private lateinit var model: MarshrutViewModel
    private fun capture(name: String) {
        val file = File(context.getExternalFilesDir(null), "screenshots/$name.png"); file.parentFile!!.mkdirs()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }
    @Test fun nativeLoginPhotoVideoReportAndSessionPersistence() {
        compose.waitUntil(20_000) { compose.onAllNodesWithText("Связь с сервером").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Связь с сервером").performScrollTo().performClick()
        compose.onNodeWithText("Проверить связь").performClick()
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Связь установлена", substring = true).fetchSemanticsNodes().isNotEmpty() }
        capture("06-connection")
        compose.onNodeWithContentDescription("Назад").performClick()
        compose.onNodeWithText("Email", substring = false).performTextInput("mobile.demo@marsh.test")
        compose.onNodeWithText("Пароль", substring = false).performTextInput("MarshDemo2026!")
        compose.onNodeWithText("Войти", substring = false).performScrollTo().performClick()
        compose.activityRule.scenario.onActivity { model = ViewModelProvider(it)[MarshrutViewModel::class.java] }
        compose.waitUntil(40_000) { model.state.value?.remote == true && model.state.value?.visits?.isNotEmpty() == true }
        capture("07-connected-today")
        val visit = model.state.value!!.nextVisit!!
        // The demo fixture has three assignments; the earliest uncompleted one is the next visit.
        compose.onNodeWithContentDescription("Открыть заявку ${visit.id}").performClick()
        if (visit.status != VisitStatus.IN_PROGRESS) compose.onNodeWithText("Начать работу").performClick()
        compose.waitUntil(30_000) { model.state.value?.visits?.first { it.id == visit.id }?.status == VisitStatus.IN_PROGRESS }
        compose.onNodeWithText("Оформить отчёт").performClick()
        compose.onNodeWithText("Отправить отчёт и завершить").assertIsNotEnabled()
        val report = "Проверка Android: фото и видео результата переданы в основное приложение."
        compose.onNodeWithText("Результат работы").assertIsEnabled().performTextInput(report)
        compose.onNodeWithText(report).assertExists()
        val photo = model.files.newCapture(false)
        val bitmap = Bitmap.createBitmap(640,480,Bitmap.Config.ARGB_8888); bitmap.eraseColor(android.graphics.Color.rgb(78,55,138))
        photo.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG,90,it) }; bitmap.recycle()
        val video = model.files.newCapture(true); writeTestVideo(video)
        model.addCaptured(visit.id,photo.absolutePath,false); model.addCaptured(visit.id,video.absolutePath,true)
        compose.waitUntil(20_000) { model.state.value!!.visits.first { it.id == visit.id }.media.size == 2 && !model.connection.value.busy }
        val materials = model.state.value!!.visits.first { it.id == visit.id }.media
        for (file in materials) {
            compose.onNodeWithContentDescription("Открыть ${file.name}").performScrollTo().performClick()
            compose.onNodeWithText("Закрыть", substring = false).assertIsDisplayed().performClick()
        }
        compose.onNodeWithTag("report-confirmation").performScrollTo().assertIsOff().performClick().assertIsOn()
        capture("08-report-with-media")
        compose.onNodeWithText("Отправить отчёт и завершить").performClick()
        compose.waitUntil(90_000) { model.state.value!!.visits.first { it.id == visit.id }.status == VisitStatus.COMPLETED }
        capture("09-report-sent")
        val session = ConnectionStore(context).settings()
        val api = MobileApi(session.server,session.token)
        val state = api.request("state?date=${model.state.value!!.serviceDate}")
        val serverVisit = state.getJSONArray("visits").objects().first { it.getString("id") == visit.id }
        assertEquals(report,serverVisit.getString("report")); assertEquals(2,serverVisit.getJSONArray("media").length())
        for (e in materials) {
            val downloaded = File(context.cacheDir, "${e.id}.verification")
            api.download(e,downloaded)
            assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(File(e.localPath).readBytes()),MessageDigest.getInstance("SHA-256").digest(downloaded.readBytes()))
            downloaded.delete()
        }
        compose.activityRule.scenario.recreate()
        compose.waitUntil(30_000) { compose.onAllNodesWithText("Вернуться к заявке").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Отчёт отправлен на сервер").assertIsDisplayed()
        assertTrue(ConnectionStore(context).settings().token.isNotEmpty())
        File(context.getExternalFilesDir(null),"connected-result.txt").writeText(visit.id)
    }
}
