package ru.mmi.marshrut

import org.junit.Assert.*
import org.junit.Test
import ru.mmi.marshrut.core.model.*

class CompositeReportTest {
    private val photo = Evidence("P", "p.png", "image/png", 16)
    private val video = Evidence("V", "v.mp4", "video/mp4", 16)
    private fun visit(secondValue: String = "", media: List<Evidence> = listOf(photo, video)) = Visit("J", "Линия + Роутер", "Дом", "", "09:00", "60 мин", "",
        media = media, reportSections = listOf(
            ReportSection("V1", "Линия", listOf(ReportField("result", "Уровень сигнала", true, "-18")), minPhotos = 1),
            ReportSection("V2", "Роутер", listOf(ReportField("result", "Серийный номер", true, secondValue)), minVideos = 1)))
    @Test fun sameNamedFieldsInDifferentWorksAreIndependent() {
        assertTrue(reportRequirementsError(visit())!!.contains("Серийный номер"))
        assertNull(reportRequirementsError(visit("SN-123")))
    }
    @Test fun everyWorkEvidencePolicyAppliesToTheSharedVisitMedia() {
        assertTrue(reportRequirementsError(visit("SN-123", listOf(photo)))!!.contains("видео — 1"))
        assertTrue(reportRequirementsError(visit("SN-123", listOf(video)))!!.contains("фото — 1"))
    }
    @Test fun unsupportedRequirementsCannotBeSilentlyIgnored() {
        val v = visit("SN-123")
        assertNotNull(reportRequirementsError(v.copy(reportSections = v.reportSections + ReportSection("V3", "Проверка", emptyList(), configurationError = "Обновите приложение"))))
    }
}
