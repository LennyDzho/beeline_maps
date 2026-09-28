package ru.mmi.marshrut.core.model

enum class VisitStatus(val label: String) {
    CONFIRMED("Подтверждено"), EN_ROUTE("В пути"), IN_PROGRESS("В работе"), PAUSED("Приостановлена"), COMPLETED("Завершено")
}

data class VisitEvent(val title: String, val detail: String)
data class ReportField(val id: String, val label: String, val required: Boolean, val value: String = "")
data class ReportSection(val versionId: String, val name: String, val fields: List<ReportField>, val minPhotos: Int = 0, val minVideos: Int = 0, val configurationError: String = "")
data class RequiredEquipment(val id: String, val name: String, val quantity: Double?, val unit: String, val usage: String) {
    val description: String get() {
        val count = quantity?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }
        val amount = if (count == null) "Количество не задано" else listOf(count, unit).filter { it.isNotBlank() }.joinToString(" ")
        val purpose = when (usage) { "consumable" -> "расходуемое"; "reusable" -> "многоразовое"; else -> "способ использования не задан" }
        return "$amount · $purpose"
    }
}

/** Values already use the worker's region. Include dates when the interval crosses midnight. */
fun regionalInterval(start: String, end: String): String {
    if (start.length < 16) return "Не задано"
    fun endpoint(value: String, withDate: Boolean) =
        (if (withDate) "${value.substring(8, 10)}.${value.substring(5, 7)} " else "") + value.substring(11, 16)
    val hasEnd = end.length >= 16
    val differentDays = hasEnd && start.take(10) != end.take(10)
    return endpoint(start, differentDays) + if (hasEnd) " – ${endpoint(end, differentDays)}" else ""
}
data class Evidence(val id: String, val name: String, val mimeType: String, val size: Long,
    val localPath: String = "", val uploaded: Boolean = false, val capturedAt: String = "") {
    val isVideo get() = mimeType.startsWith("video/")
}
data class WorkerProfile(val name: String = "Алексей Смирнов", val email: String = "", val organization: String = "Демо-команда", val skills: String = "Электрика · Климатическое оборудование", val timezone: String = "", val timezoneLabel: String = "")
data class Visit(
    val id: String, val title: String, val address: String, val entrance: String,
    val window: String, val duration: String, val skill: String,
    val highPriority: Boolean = false,
    val status: VisitStatus = VisitStatus.CONFIRMED,
    val events: List<VisitEvent> = listOf(
        VisitEvent("Назначено", "Вчера, 18:45 · Диспетчер"),
        VisitEvent("Подтверждено", "Сегодня, 08:15 · Вами")
    ),
    val report: String = "", val problems: List<String> = emptyList(),
    val media: List<Evidence> = emptyList(), val draftReport: String = "", val revision: Int = 0,
    val description: String = "", val serviceDate: String = "", val number: String = id,
    val reportStatus: String = "", val pending: Boolean = false,
    val latitude: Double? = null, val longitude: Double? = null,
    val categoryName: String = "", val clientWindow: String = "",
    val equipment: List<RequiredEquipment> = emptyList(),
    val reportSections: List<ReportSection> = emptyList()
)

fun reportRequirementsError(visit: Visit): String? {
    for (section in visit.reportSections) {
        if (section.configurationError.isNotBlank()) return "${section.name}: ${section.configurationError}"
        for (field in section.fields) {
            if (field.required && field.value.isBlank()) return "${section.name}: заполните «${field.label}»"
            if (field.value.length > 2000) return "${section.name}: в поле «${field.label}» не более 2000 символов"
        }
        if (visit.media.count { !it.isVideo } < section.minPhotos || visit.media.count { it.isVideo } < section.minVideos)
            return "${section.name}: требуется фото — ${section.minPhotos}, видео — ${section.minVideos}"
    }
    return null
}
data class Notice(val id: String, val title: String, val text: String, val time: String, val visitId: String?, val read: Boolean = false)
data class DemoState(
    val signedIn: Boolean = false,
    val onShift: Boolean = true,
    val visits: List<Visit> = demoVisits(),
    val notices: List<Notice> = listOf(
        Notice("route", "Маршрут на сегодня готов", "В вашем расписании 4 визита. Все адреса и детали доступны на устройстве.", "08:00", null),
        Notice("priority", "Заявка с высоким приоритетом", "Диагностика оборудования · A-1428. Окно прибытия 10:00–12:00.", "07:55", "A-1428")
    ),
    val remote: Boolean = false, val profile: WorkerProfile = WorkerProfile(),
    val serviceDate: String = "2026-08-20", val availableDates: List<String> = emptyList(),
    val syncMessage: String = "На устройстве", val pendingCount: Int = 0
) {
    val activeVisit get() = visits.firstOrNull { it.status == VisitStatus.EN_ROUTE || it.status == VisitStatus.IN_PROGRESS }
    val nextVisit get() = activeVisit ?: visits.firstOrNull { it.status == VisitStatus.CONFIRMED }
        ?: visits.firstOrNull { it.status == VisitStatus.PAUSED }
    val orderedVisits get() = visits.sortedBy { it.status == VisitStatus.PAUSED }
    val completedCount get() = visits.count { it.status == VisitStatus.COMPLETED }
}

fun demoVisits() = listOf(
    Visit("A-1425", "Замена счетчика", "ул. Ленина, 45", "Подъезд 2, этаж 1", "08:00 – 09:30", "1 ч. 30 мин.", "Электрика",
        status = VisitStatus.COMPLETED,
        events = listOf(VisitEvent("Назначено", "Вчера, 18:30 · Диспетчер"), VisitEvent("Подтверждено", "Сегодня, 07:45 · Вами"), VisitEvent("В работе", "Сегодня, 08:00 · Вами"), VisitEvent("Завершено", "Сегодня, 09:20 · Вами")),
        report = "Счетчик заменён, показания проверены. Оборудование работает штатно."),
    Visit("A-1428", "Диагностика оборудования", "ул. Академика Королёва, 12", "Вход со двора, подъезд 3", "10:00 – 12:00", "2 ч.", "Электрика", true),
    Visit("A-1430", "Ремонт кондиционера", "пр. Мира, 102", "Центральный вход, этаж 2", "13:00 – 14:30", "1 ч. 30 мин.", "Климатическое оборудование"),
    Visit("A-1435", "Плановое ТО", "ул. Гагарина, 8", "Вход через проходную", "15:00 – 17:00", "2 ч.", "Техническое обслуживание")
)

/** Shared rules for every entry point, including rapid repeated taps. */
object VisitRules {
    fun problem(state: DemoState, id: String, reason: String, details: String, at: String): DemoState {
        require(state.signedIn) { "Сначала войдите в приложение" }
        val visit = state.visits.firstOrNull { it.id == id } ?: error("Заявка не найдена")
        require(visit.status in listOf(VisitStatus.CONFIRMED, VisitStatus.EN_ROUTE, VisitStatus.IN_PROGRESS)) { "Заявка уже приостановлена или завершена" }
        require(!visit.pending) { "Действие ожидает синхронизации" }
        require(reason.isNotBlank() && reason.length <= 100 && details.trim().length in 5..1000) { "Добавьте описание проблемы: от 5 до 1000 символов" }
        val updated = visit.copy(status = VisitStatus.PAUSED, problems = visit.problems + "$at · $reason: ${details.trim()}",
            events = visit.events + VisitEvent(VisitStatus.PAUSED.label, "$at · $reason: ${details.trim()}"))
        return state.copy(visits = state.visits.map { if (it.id == id) updated else it })
    }
    fun transition(state: DemoState, id: String, target: VisitStatus, report: String, at: String): DemoState {
        require(state.signedIn) { "Сначала войдите в демо" }
        require(state.onShift) { "Начните смену в профиле" }
        val visit = state.visits.firstOrNull { it.id == id } ?: error("Заявка не найдена")
        require(state.activeVisit == null || state.activeVisit?.id == id) { "Сначала завершите или приостановите текущий визит ${state.activeVisit?.id}" }
        require(!visit.pending) { "Действие ожидает синхронизации" }
        val allowed = when (visit.status) {
            VisitStatus.CONFIRMED -> target == VisitStatus.EN_ROUTE || target == VisitStatus.IN_PROGRESS
            VisitStatus.EN_ROUTE -> target == VisitStatus.IN_PROGRESS
            VisitStatus.IN_PROGRESS -> target == VisitStatus.COMPLETED
            VisitStatus.PAUSED -> target == VisitStatus.IN_PROGRESS
            VisitStatus.COMPLETED -> false
        }
        require(allowed) { "Статус заявки уже изменился" }
        require(target != VisitStatus.COMPLETED || report.trim().length >= 10) { "Опишите результат работы: минимум 10 символов" }
        val updated = visit.copy(status = target, report = if (target == VisitStatus.COMPLETED) report.trim() else visit.report,
            events = visit.events + VisitEvent(target.label, "$at · Вами"))
        return state.copy(visits = state.visits.map { if (it.id == id) updated else it })
    }
}
