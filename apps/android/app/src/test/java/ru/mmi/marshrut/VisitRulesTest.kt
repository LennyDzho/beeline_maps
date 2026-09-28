package ru.mmi.marshrut

import org.junit.Assert.*
import org.junit.Test
import ru.mmi.marshrut.core.model.*

class VisitRulesTest {
    private val seed = DemoState(signedIn = true)
    private fun move(state: DemoState, id: String = "A-1428", target: VisitStatus, report: String = "") =
        VisitRules.transition(state, id, target, report, "Сегодня, 10:00")

    @Test fun fullVisitLifecycleAdvancesScheduleAndKeepsReport() {
        val departed = move(seed, target = VisitStatus.EN_ROUTE)
        assertEquals("A-1428", departed.activeVisit?.id)
        val started = move(departed, target = VisitStatus.IN_PROGRESS)
        val completed = move(started, target = VisitStatus.COMPLETED, report = "  Диагностика выполнена, ошибок нет.  ")
        assertEquals("A-1430", completed.nextVisit?.id)
        assertEquals(2, completed.completedCount)
        assertNull(completed.activeVisit)
        assertEquals("Диагностика выполнена, ошибок нет.", completed.visits[1].report)
        assertEquals(listOf("Назначено", "Подтверждено", "В пути", "В работе", "Завершено"), completed.visits[1].events.map { it.title })
    }
    @Test fun canStartAtSiteWithoutDeparture() {
        assertEquals(VisitStatus.IN_PROGRESS, move(seed, target = VisitStatus.IN_PROGRESS).visits[1].status)
    }
    @Test fun repeatedTapCannotDuplicateEvent() {
        val departed = move(seed, target = VisitStatus.EN_ROUTE)
        assertThrows(IllegalArgumentException::class.java) { move(departed, target = VisitStatus.EN_ROUTE) }
        assertEquals(3, departed.visits[1].events.size)
    }
    @Test fun cannotRunTwoVisitsAtOnce() {
        val started = move(seed, target = VisitStatus.IN_PROGRESS)
        assertThrows(IllegalArgumentException::class.java) { move(started, "A-1430", VisitStatus.IN_PROGRESS) }
    }
    @Test fun cannotCompleteWithoutReportOrSkipWork() {
        assertThrows(IllegalArgumentException::class.java) { move(seed, target = VisitStatus.COMPLETED, report = "Полный отчёт о работе") }
        val started = move(seed, target = VisitStatus.IN_PROGRESS)
        assertThrows(IllegalArgumentException::class.java) { move(started, target = VisitStatus.COMPLETED, report = "   Ок  ") }
    }
    @Test fun completedVisitCannotBeReopened() {
        assertThrows(IllegalArgumentException::class.java) { move(seed, "A-1425", VisitStatus.IN_PROGRESS) }
    }
    @Test fun signedOutAndOffShiftCannotChangeVisits() {
        assertThrows(IllegalArgumentException::class.java) { move(seed.copy(signedIn = false), target = VisitStatus.EN_ROUTE) }
        assertThrows(IllegalArgumentException::class.java) { move(seed.copy(onShift = false), target = VisitStatus.EN_ROUTE) }
    }
    @Test fun allVisitsCompleteLeavesNoNextVisit() {
        var state = seed
        for (visit in seed.visits.filter { it.status != VisitStatus.COMPLETED }) {
            state = move(state, visit.id, VisitStatus.IN_PROGRESS)
            state = move(state, visit.id, VisitStatus.COMPLETED, "Проверка выполнена успешно")
        }
        assertNull(state.nextVisit)
        assertEquals(state.visits.size, state.completedCount)
    }
    @Test fun problemPausesVisitAndReleasesNextWork() {
        val started = move(seed, target = VisitStatus.IN_PROGRESS)
        val paused = VisitRules.problem(started, "A-1428", "Нет доступа", "Дверь закрыта", "08.09.2026, 10:10")
        assertNull(paused.activeVisit)
        assertEquals("A-1430", paused.nextVisit?.id)
        assertEquals("A-1428", paused.orderedVisits.last().id)
        assertEquals(VisitStatus.PAUSED, paused.visits[1].status)
        assertTrue(paused.visits[1].problems.single().contains("08.09.2026, 10:10"))
        val other = move(paused, "A-1430", VisitStatus.IN_PROGRESS)
        assertThrows(IllegalArgumentException::class.java) { move(other, target = VisitStatus.IN_PROGRESS) }
        val finished = move(other, "A-1430", VisitStatus.COMPLETED, "Работа выполнена полностью")
        val resumed = move(finished, target = VisitStatus.IN_PROGRESS)
        assertEquals("A-1428", resumed.activeVisit?.id)
        assertEquals(paused.visits[1].problems, resumed.visits[1].problems)
    }
    @Test fun repeatedProblemsKeepHistoryAndCannotCompletePausedWork() {
        val paused = VisitRules.problem(seed, "A-1428", "Нет доступа", "Дверь закрыта", "10:10")
        assertThrows(IllegalArgumentException::class.java) { VisitRules.problem(paused, "A-1428", "Нет доступа", "Дверь закрыта", "10:11") }
        assertThrows(IllegalArgumentException::class.java) { move(paused, target = VisitStatus.COMPLETED, report = "Работа выполнена полностью") }
        val resumed = move(paused, target = VisitStatus.IN_PROGRESS)
        val pausedAgain = VisitRules.problem(resumed, "A-1428", "Нет материалов", "Нужен новый кабель", "11:10")
        assertEquals(2, pausedAgain.visits[1].problems.size)
        assertThrows(IllegalArgumentException::class.java) { VisitRules.problem(seed, "A-1425", "Нет доступа", "Дверь закрыта", "10:10") }
    }
}
