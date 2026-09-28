package ru.mmi.marshrut

import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHostState
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import ru.mmi.marshrut.core.data.*
import ru.mmi.marshrut.feature.visit.VisitScreen
import ru.mmi.marshrut.feature.visit.ReportFields
import ru.mmi.marshrut.core.model.reportRequirementsError
import java.io.File
import java.util.UUID

/** Isolated UI/JSON/storage fixtures: no login, network or application-data reset. */
@RunWith(AndroidJUnit4::class)
class MobileDetailsTest {
    @get:Rule val compose = createComposeRule()
    private fun fixture() = JSONObject("""{
      "datasetVersion":"beeline-app-v1","serviceDate":"2026-08-17","availableDates":["2026-08-17"],"onShift":true,
      "profile":{"name":"Бригада 2","email":"","organization":"Восток","skills":["Аварийные работы → Линия","Аварийные работы → Роутер"],"timezone":"Europe/Moscow","timezoneLabel":"GMT+3"},
      "notices":[],"visits":[{"id":"internal-stable-id","number":"11872","title":"Линия + Роутер","categoryName":"Аварийные работы",
      "workTypes":[{"versionId":"V1","name":"Линия"},{"versionId":"V2","name":"Роутер"}],
      "address":"Москва, тестовый адрес, кв. 12","entrance":"Подъезд: 2 · Домофон: 12","description":"Восстановить подключение",
      "scheduledStart":"2026-08-17T09:00","scheduledEnd":"2026-08-17T09:30","clientWindowStart":"2026-08-17T00:00","clientWindowEnd":"2026-08-18T00:00",
      "durationMinutes":30,"highPriority":true,"status":"assigned","revision":1,"latitude":null,"longitude":null,
      "equipment":[{"id":"E1","name":"Кабель","quantity":20,"unit":"м","usage":"consumable"},{"id":"E2","name":"Тестер","quantity":null,"unit":"шт.","usage":"reusable"}],
      "report":"","reportStatus":"","media":[],"problems":[],"events":[{"title":"План изменён","detail":"Прежний исполнитель недоступен. Бригада 1 → Бригада 2"}]}]
    }""")

    @Test fun regionalWindowCompositionEquipmentAndReasonAreVisible() {
        val state = parseRemoteState(fixture(), JSONObject(), JSONArray(), "Синхронизировано")
        val visit = state.visits.single()
        assertEquals("Линия + Роутер", visit.skill)
        assertEquals("09:00 – 09:30", visit.window)
        assertEquals("17.08 00:00 – 18.08 00:00", visit.clientWindow)
        assertNull(visit.equipment[1].quantity)
        compose.setContent { MaterialTheme { VisitScreen(visit, state, SnackbarHostState(), {}, {}, { _, _ -> }, { _, _ -> }, {}) } }
        compose.onNodeWithText("Заявка 11872").assertIsDisplayed()
        compose.onNodeWithText("Окно клиента · начало работ").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("17.08 00:00 – 18.08 00:00").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("План работ").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Количество не задано · многоразовое").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Прежний исполнитель недоступен. Бригада 1 → Бригада 2").performScrollTo().assertIsDisplayed()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.getExternalFilesDir(null), "screenshots/mobile-details.png"); file.parentFile!!.mkdirs()
        val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
    }

    @Test fun replacingDatasetPersistsAnEmptyQueueAndDraftsTogetherWithNewSnapshot() {
        // Instrumentation runs as the app UID. Use only fresh account-scoped keys;
        // never reset the user's settings or existing account data.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = ConnectionSettings(accountId = "dataset-test-${UUID.randomUUID()}")
        val store = ConnectionStore(context)
        try {
            store.saveSnapshot(settings, fixture().put("datasetVersion", "legacy"))
            store.saveDrafts(settings, JSONObject().put("OLD", JSONObject().put("text", "Старый отчёт")))
            store.saveQueue(settings, JSONArray().put(JSONObject().put("action", "shift").put("onShift", false)))
            store.replaceDataset(settings, fixture())
            val reloaded = ConnectionStore(context)
            assertEquals("beeline-app-v1", reloaded.snapshot(settings)!!.getString("datasetVersion"))
            assertEquals(0, reloaded.queue(settings).length())
            assertEquals(0, reloaded.drafts(settings).length())
            // An ordinary refresh of the same namespace must retain unsent work.
            reloaded.saveQueue(settings, JSONArray().put(JSONObject().put("action", "read")))
            reloaded.saveSnapshot(settings, fixture())
            assertEquals(1, ConnectionStore(context).queue(settings).length())
        } finally {
            val cleanup = context.getSharedPreferences("marsh_connection_v1", android.content.Context.MODE_PRIVATE).edit()
            listOf("snapshot", "queue", "drafts").forEach { cleanup.remove("$it:${settings.server}:${settings.accountId}") }
            cleanup.commit()
        }
    }

    @Test fun compositeFieldsKeepVersionedDraftsAndRenderEveryHd() {
        val source = fixture()
        val serverVisit = source.getJSONArray("visits").getJSONObject(0)
        serverVisit.put("reportRequirements", JSONArray("""[
          {"versionId":"V1","name":"Линия","fields":[{"id":"result","label":"Уровень сигнала","required":true}],"minPhotos":0,"minVideos":0},
          {"versionId":"V2","name":"Роутер","fields":[{"id":"result","label":"Серийный номер","required":true}],"minPhotos":0,"minVideos":0}
        ]"""))
        serverVisit.put("reportValues", JSONObject("""{"V1":{"result":"Сервер 1"},"V2":{"result":"Сервер 2"}}"""))
        val drafts = JSONObject().put("internal-stable-id", JSONObject().put("text", "Черновик").put("reportValues", JSONObject("""{"V1":{"result":"-18 dBm"},"V2":{"result":"SN-123"}}""")))
        val visit = parseRemoteState(source, drafts, JSONArray(), "Локальный черновик").visits.single()
        assertEquals(listOf("-18 dBm", "SN-123"), visit.reportSections.map { it.fields.single().value })
        assertNull(reportRequirementsError(visit))
        assertEquals("SN-123", reportValuesJson(visit).getJSONObject("V2").getString("result"))
        val edits = mutableListOf<Triple<String, String, String>>()
        compose.setContent { MaterialTheme { Column { ReportFields(visit, true, false) { version, field, value -> edits.add(Triple(version, field, value)) } } } }
        compose.onNodeWithText("Уровень сигнала *").assertIsDisplayed()
        compose.onNodeWithText("Серийный номер *").performTextReplacement("SN-456")
        assertEquals(Triple("V2", "result", "SN-456"), edits.last())
        serverVisit.put("status", "completed")
        val completed = parseRemoteState(source, drafts, JSONArray(), "Отправлено").visits.single()
        assertEquals(listOf("Сервер 1", "Сервер 2"), completed.reportSections.map { it.fields.single().value })
    }
}
