package ru.mmi.marshrut.core.model

import org.junit.Assert.*
import org.junit.Test

class ProblemRetryTest {
    private val visit = Visit("ORD-9020", "Плановое ТО", "Москва, адрес", "", "08:30 – 09:30", "60 мин.", "", false,
        status = VisitStatus.IN_PROGRESS, revision = 6, pending = true)
    private fun offer(action: String = "problem", target: Visit? = visit) =
        ProblemRetryRules.offer("original-operation", action, "Нет доступа", "Дверь закрыта", target)

    @Test fun preservesProblemAndUsesTheCurrentRevision() {
        val retry = offer()!!
        assertEquals(6, retry.revision)
        assertEquals("Дверь закрыта", retry.details)
        assertEquals("original-operation", retry.operationId)
        ProblemRetryRules.confirm(retry, offer())
    }
    @Test fun closedPausedAndMissingVisitsCannotBeRetried() {
        assertNull(offer(target = null))
        assertNull(offer(target = visit.copy(status = VisitStatus.COMPLETED)))
        assertNull(offer(target = visit.copy(status = VisitStatus.PAUSED)))
        assertNull(offer(action = "status"))
        assertNull(offer(action = "shift"))
    }
    @Test fun newRevisionRequiresAnotherConfirmation() {
        assertThrows(IllegalArgumentException::class.java) { ProblemRetryRules.confirm(offer()!!, offer(target = visit.copy(revision = 7))) }
    }
    @Test fun addressStatusAndMissingAssignmentMustNotBeSilentlyOverwritten() {
        val expected = offer()!!
        for (current in listOf(null, offer(target = visit.copy(address = "Другой адрес")), offer(target = visit.copy(status = VisitStatus.EN_ROUTE)))) {
            assertThrows(IllegalArgumentException::class.java) { ProblemRetryRules.confirm(expected, current) }
        }
    }
    @Test fun changedQueueOrProblemNeedsNewConfirmation() {
        val expected = offer()!!
        assertThrows(IllegalArgumentException::class.java) { ProblemRetryRules.confirm(expected, expected.copy(operationId = "other")) }
        assertThrows(IllegalArgumentException::class.java) { ProblemRetryRules.confirm(expected, expected.copy(details = "Другой текст")) }
    }
}
