package ru.mmi.marshrut.core.model

/** What the user saw and confirmed. Any further change requires a new confirmation. */
data class ProblemRetry(
    val operationId: String, val visitId: String, val revision: Int, val status: VisitStatus,
    val address: String, val window: String, val reason: String, val details: String
)

object ProblemRetryRules {
    fun offer(operationId: String, action: String, reason: String, details: String, visit: Visit?): ProblemRetry? {
        if (action != "problem" || visit == null || operationId.isBlank() ||
            visit.status !in listOf(VisitStatus.CONFIRMED, VisitStatus.EN_ROUTE, VisitStatus.IN_PROGRESS)) return null
        if (reason.isBlank() || reason.length > 100 || details.trim().length !in 5..1000) return null
        return ProblemRetry(operationId, visit.id, visit.revision, visit.status, visit.address, visit.window, reason, details)
    }

    fun confirm(expected: ProblemRetry, current: ProblemRetry?) {
        require(current == expected) { "Заявка снова изменилась. Проверьте актуальные данные и подтвердите отправку ещё раз." }
    }
}
