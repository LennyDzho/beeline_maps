package ru.mmi.marshrut

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import ru.mmi.marshrut.core.data.*
import ru.mmi.marshrut.core.model.*
import java.io.File
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.UUID

data class ConnectionUi(val server: String = ServerAddress.DEFAULT, val email: String = "", val busy: Boolean = false,
    val message: String = "Проверьте подключение перед входом", val mustChangePassword: Boolean = false, val pending: List<String> = emptyList(),
    val problemRetry: ProblemRetry? = null)

class MarshrutViewModel(application: Application) : AndroidViewModel(application) {
    private val demo = DemoStore(application)
    private val store = ConnectionStore(application)
    val files = EvidenceFiles(application)
    private val mutex = Mutex()
    private var settings = ConnectionSettings()
    private var snapshot: JSONObject? = null
    private var drafts = JSONObject()
    private var queue = JSONArray()
    private val mutableState = MutableStateFlow<DemoState?>(null)
    val state = mutableState.asStateFlow()
    private val mutableConnection = MutableStateFlow(ConnectionUi())
    val connection = mutableConnection.asStateFlow()
    private val messages = Channel<String>(Channel.BUFFERED)
    val feedback = messages.receiveAsFlow()
    private var storageFailed = false
    private var selectedDate: String? = null
    private var revisionConflictId: String? = null
    private var conflictSnapshotFresh = false

    init {
        work {
            try { settings = store.settings() } catch (_: Exception) { messages.send("Сохранённая сессия недоступна. Войдите заново.") }
            mutableConnection.value = ConnectionUi(settings.server, settings.email, mustChangePassword = settings.mustChangePassword, busy = true)
            if (settings.token.isNotEmpty()) { loadAccount(); showRemote("Сохранённые данные"); syncLocked(false) }
            else try { mutableState.value = demo.load() } catch (_: Exception) { storageFailed = true; mutableState.value = DemoState(); messages.send("Не удалось прочитать демо. Используйте сброс в профиле.") }
        }
        viewModelScope.launch { while (isActive) { delay(30_000); if (state.value?.remote == true && state.value?.signedIn == true && !connection.value.busy) refresh(false) } }
    }
    private fun work(showBusy: Boolean = true, block: suspend () -> Unit) {
        viewModelScope.launch(Dispatchers.IO) { mutex.withLock {
            if (showBusy) mutableConnection.update { it.copy(busy = true) }
            try { block() } catch (error: Exception) {
                if (error is CancellationException) throw error
                mutableConnection.update { it.copy(message = error.message ?: "Не удалось выполнить действие") }
                messages.send(error.message ?: "Не удалось выполнить действие")
            } finally { if (showBusy) mutableConnection.update { it.copy(busy = false) } }
        } }
    }
    fun testConnection(server: String) = work {
        val health = MobileApi(ServerAddress.normalize(server)).request("health")
        require(health.optInt("protocol") == 1) { "Сервер использует другую версию API" }
        mutableConnection.update { it.copy(message = if (health.optBoolean("mediaAvailable")) "Связь установлена · загрузка фото и видео доступна" else "Сервер доступен, но хранилище материалов не подключено") }
    }
    fun saveConnection(server: String) = work {
        val normalized = ServerAddress.normalize(server)
        if (normalized != settings.server) {
            settings = ConnectionSettings(server = normalized, email = settings.email)
            store.saveSettings(settings); snapshot = null; drafts = JSONObject(); queue = JSONArray(); selectedDate = null
            revisionConflictId = null; conflictSnapshotFresh = false
            mutableState.value = DemoState(signedIn = false, visits = emptyList(), notices = emptyList())
        }
        mutableConnection.update { it.copy(server = normalized, message = "Адрес сохранён", mustChangePassword = false, pending = emptyList(), problemRetry = null) }
    }
    fun login(email: String, password: String) = work {
        val result = MobileApi(settings.server).request("auth/login", "POST", JSONObject().put("email", email.trim()).put("password", password))
        val user = result.getJSONObject("user")
        settings = settings.copy(email = email.trim().lowercase(), token = result.getString("token"), accountId = user.getString("id"), mustChangePassword = result.getBoolean("mustChangePassword"))
        store.saveSettings(settings); demo.save(demo.load().copy(signedIn = false))
        mutableConnection.update { it.copy(email = settings.email, mustChangePassword = settings.mustChangePassword) }
        loadAccount(); showRemote("Загрузка заданий…"); if (!settings.mustChangePassword) syncLocked(true)
    }
    fun changePassword(current: String, next: String) = work {
        api().request("auth/password", "POST", JSONObject().put("currentPassword", current).put("newPassword", next))
        clearSession(); messages.send("Пароль изменён. Войдите с новым паролем.")
    }
    fun signIn() = work {
        if (storageFailed) mutableState.value = DemoState(signedIn = true)
        else { val next = demo.load().copy(signedIn = true); demo.save(next); mutableState.value = next }
    }
    fun signOut() = work {
        if (state.value?.remote == true) {
            require(queue.length() == 0) { "Сначала отправьте действия или уберите их из очереди в разделе «Связь»" }
            api().request("auth/logout", "POST", JSONObject()); clearSession()
        } else saveDemo { it.copy(signedIn = false) }
    }
    private fun clearSession() {
        revisionConflictId = null; conflictSnapshotFresh = false
        settings = settings.copy(token = "", mustChangePassword = false); store.saveSettings(settings)
        mutableConnection.update { it.copy(mustChangePassword = false, problemRetry = null) }
        mutableState.value = DemoState(signedIn = false, visits = emptyList(), notices = emptyList())
    }
    fun reset() = work { require(state.value?.remote != true) { "Сброс доступен только в демо" }; demo.save(DemoState(signedIn = true)); storageFailed = false; mutableState.value = DemoState(signedIn = true) }
    fun refresh(notify: Boolean = true, date: String? = null) = work {
        if (date != null) selectedDate = date
        if (state.value?.remote == true && settings.token.isNotEmpty()) syncLocked(notify)
    }
    private fun loadAccount() {
        revisionConflictId = null; conflictSnapshotFresh = false
        snapshot = store.snapshot(settings); drafts = store.drafts(settings); queue = store.queue(settings); selectedDate = snapshot?.optString("serviceDate")
    }
    private fun showRemote(message: String) {
        mutableState.value = snapshot?.let { parseRemoteState(it, drafts, queue, message) }
            ?: DemoState(signedIn = true, remote = true, visits = emptyList(), notices = emptyList(), syncMessage = message, pendingCount = queue.length())
        mutableConnection.update { it.copy(message = message, problemRetry = currentProblemRetry(), pending = queue.objects().map { q -> "${q.optString("visitId", "Профиль")} · ${when(q.optString("action")) { "status" -> "Изменение статуса"; "problem" -> "Проблема"; "shift" -> "Смена"; else -> "Уведомления" }}" }) }
    }
    private fun currentProblemRetry(): ProblemRetry? {
        val head = queue.optJSONObject(0) ?: return null
        if (!conflictSnapshotFresh || head.optString("operationId") != revisionConflictId) return null
        return ProblemRetryRules.offer(head.optString("operationId"), head.optString("action"), head.optString("reason"), head.optString("details"),
            state.value?.visits?.firstOrNull { it.id == head.optString("visitId") })
    }
    private suspend fun fetchSnapshot() {
        val fresh = api().request("state" + (selectedDate?.let { "?date=$it" } ?: ""))
        if (DatasetRules.changed(snapshot?.optString("datasetVersion"), fresh.optString("datasetVersion"))) {
            val obsoleteMedia = drafts.keys().asSequence().flatMap { id -> drafts.optJSONObject(id)?.optJSONArray("media")?.objects().orEmpty().asSequence() }
                .map { it.optString("localPath") }.filter { it.isNotBlank() }.toList() +
                snapshot?.optJSONArray("visits")?.objects().orEmpty().flatMap { it.optJSONArray("media")?.objects().orEmpty() }
                    .map { files.destination(parseEvidence(it)).absolutePath }
            store.replaceDataset(settings, fresh)
            snapshot = fresh; drafts = JSONObject(); queue = JSONArray()
            revisionConflictId = null; conflictSnapshotFresh = false
            obsoleteMedia.forEach { files.remove(it) }
            messages.send("Набор заявок обновлён. Прежние задания, черновики и очередь удалены с устройства.")
        } else { store.saveSnapshot(settings, fresh); snapshot = fresh }
    }
    private fun acceptQueueHead() {
        // Persist before swapping memory: a storage failure must not lose a command.
        val remaining = JSONArray(queue.toString()).apply { remove(0) }
        store.saveQueue(settings, remaining); queue = remaining
        revisionConflictId = null; conflictSnapshotFresh = false
    }
    private suspend fun syncLocked(notify: Boolean) {
        if (settings.mustChangePassword) return
        try {
            // Read the server namespace before sending offline commands or uploading files.
            fetchSnapshot()
            while (queue.length() > 0) {
                val command = queue.getJSONObject(0)
                if (command.optString("operationId") == revisionConflictId) {
                    throw ApiException(409, "Проблема не отправлена. Откройте «Связь» и подтвердите повторную отправку.", "revision_conflict")
                }
                if (command.optString("status") == "completed") {
                    val visitId = command.getString("visitId"); val draft = drafts.getJSONObject(visitId)
                    val media = draft.getJSONArray("media").objects().map(::parseEvidence)
                    for ((index, file) in media.withIndex()) {
                        mutableConnection.update { it.copy(message = "Загрузка материала ${index + 1} из ${media.size}…") }
                        if (!file.uploaded) {
                            api().upload(visitId, file)
                            draft.getJSONArray("media").put(index, evidenceJson(file.copy(uploaded = true))); store.saveDrafts(settings, drafts)
                        }
                    }
                }
                api().request("commands", "POST", command)
                acceptQueueHead()
            }
            fetchSnapshot(); showRemote("Синхронизировано · ${now()}")
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error is ApiException && error.status == 401) { clearSession(); if (notify) messages.send(error.message.orEmpty()); return }
            if (error is ApiException && error.status == 428) { settings = settings.copy(mustChangePassword = true); store.saveSettings(settings); mutableConnection.update { it.copy(mustChangePassword = true) }; return }
            if (error is ApiException && error.status == 409) {
                // Only explicit revision conflicts offer a new command. Never blindly
                // rebase permission, active-visit, shift, status or idempotency errors.
                if (error.code == "revision_conflict" && queue.optJSONObject(0)?.optString("action") == "problem") {
                    revisionConflictId = queue.getJSONObject(0).getString("operationId")
                }
                conflictSnapshotFresh = false
                try { fetchSnapshot(); conflictSnapshotFresh = true } catch (refreshError: Exception) {
                    if (refreshError is CancellationException) throw refreshError
                }
            }
            val message = if (error is ApiException && error.code == "dataset_changed" && queue.length() == 0 && conflictSnapshotFresh) "Набор заявок обновлён. Расписание синхронизировано."
                else if (revisionConflictId != null && conflictSnapshotFresh) "Проблема не отправлена: заявка изменилась. Откройте «Связь», чтобы проверить и повторить отправку."
                else if (error is ApiException) error.message.orEmpty() else "Нет связи с сервером. Черновики и очередь сохранены"
            showRemote(message); if (notify) messages.send(message)
        }
    }
    fun retryProblem(confirmed: ProblemRetry) = work {
        val command = queue.optJSONObject(0) ?: error("Очередь уже изменилась. Обновите данные.")
        require(command.optString("operationId") == confirmed.operationId && revisionConflictId == confirmed.operationId) { "Очередь уже изменилась. Обновите данные." }
        // First replay the EXACT old command. If an earlier acknowledgement was lost,
        // remove it only after success; never create a duplicate issue with a new id.
        try {
            api().request("commands", "POST", command)
            acceptQueueHead(); syncLocked(true); return@work
        } catch (error: ApiException) {
            if (error.status != 409 || error.code != "revision_conflict") throw error
        }
        conflictSnapshotFresh = false
        fetchSnapshot(); conflictSnapshotFresh = true
        showRemote("Проверка актуальной заявки перед отправкой")
        ProblemRetryRules.confirm(confirmed, currentProblemRetry())
        val revised = JSONObject(command.toString()).put("revision", confirmed.revision).put("operationId", UUID.randomUUID().toString())
        val updatedQueue = JSONArray(queue.toString()).put(0, revised)
        store.saveQueue(settings, updatedQueue); queue = updatedQueue
        revisionConflictId = null; conflictSnapshotFresh = false
        syncLocked(true)
    }
    fun discardQueue() = work {
        val empty = JSONArray(); store.saveQueue(settings, empty); queue = empty
        revisionConflictId = null; conflictSnapshotFresh = false
        showRemote("Очередь очищена. Черновики отчётов сохранены"); syncLocked(false)
    }
    private suspend fun sendCommand(body: JSONObject) {
        val visitId = body.optString("visitId")
        require(visitId.isEmpty() || queue.objects().none { it.optString("visitId") == visitId }) { "По заявке уже есть действие в очереди. Откройте раздел «Связь»" }
        body.put("operationId", UUID.randomUUID().toString()).put("datasetVersion", DatasetRules.version(snapshot?.optString("datasetVersion"))); queue.put(body); store.saveQueue(settings, queue)
        showRemote("Ожидает отправки: ${queue.length()}"); syncLocked(true)
    }
    fun toggleShift() = work {
        val current = state.value ?: return@work
        require(!current.onShift || current.activeVisit == null) { "Сначала завершите активный визит" }
        if (current.remote) sendCommand(JSONObject().put("action", "shift").put("onShift", !current.onShift)) else saveDemo { it.copy(onShift = !it.onShift) }
    }
    fun transition(id: String, target: VisitStatus, report: String = "") = work {
        val current = state.value ?: return@work; val visit = current.visits.first { it.id == id }
        VisitRules.transition(current, id, target, report, "Сегодня, ${now()}")
        if (target == VisitStatus.COMPLETED) {
            require(report.trim().length >= 10) { "Опишите результат работы: минимум 10 символов" }
            require(visit.media.isNotEmpty()) { "Добавьте хотя бы одно фото или видео" }
            reportRequirementsError(visit)?.let { error(it) }
            require(reportValuesJson(visit).toString().length <= 12000) { "Сократите поля отчёта: общий объём — не более 12000 символов" }
        }
        if (current.remote) sendCommand(JSONObject().put("action", "status").put("visitId", id).put("revision", visit.revision)
            .put("status", when (target) { VisitStatus.EN_ROUTE -> "en_route"; VisitStatus.IN_PROGRESS -> "in_progress"; VisitStatus.COMPLETED -> "completed"; else -> "assigned" })
            .put("report", report.trim()).put("reportValues", reportValuesJson(visit)).put("mediaIds", JSONArray(visit.media.map { it.id })))
        else { saveDemo { VisitRules.transition(it, id, target, report, "Сегодня, ${now()}") }; messages.send("${target.label} · сохранено на устройстве") }
    }
    fun problem(id: String, reason: String, details: String) = work {
        require(details.trim().length >= 5) { "Добавьте описание: минимум 5 символов" }
        val current = state.value ?: return@work; val visit = current.visits.first { it.id == id }
        VisitRules.problem(current, id, reason, details, "Сегодня, ${now()}")
        if (current.remote) sendCommand(JSONObject().put("action", "problem").put("visitId", id).put("revision", visit.revision).put("reason", reason).put("details", details.trim()))
        else saveDemo { s -> VisitRules.problem(s, id, reason, details, "Сегодня, ${now()}").copy(
            notices = listOf(Notice(UUID.randomUUID().toString(), "Приостановлена · $id", "$reason: ${details.trim()}\nСохранено на устройстве · демо", now(), id)) + s.notices) }
    }
    fun readNotice(id: String) = markRead(listOf(id))
    fun readAll() = markRead(state.value?.notices?.map { it.id }.orEmpty())
    private fun markRead(ids: List<String>) = work {
        if (state.value?.remote == true) sendCommand(JSONObject().put("action", "read").put("ids", JSONArray(ids)))
        else saveDemo { it.copy(notices = it.notices.map { n -> if (n.id in ids) n.copy(read = true) else n }) }
    }
    fun saveReportText(id: String, text: String) = work(false) { editDraft(id) { it.copy(draftReport = text.take(2000)) } }
    fun saveReportField(id: String, versionId: String, fieldId: String, value: String) = work(false) {
        editDraft(id) { visit -> visit.copy(reportSections = visit.reportSections.map { section ->
            if (section.versionId == versionId) section.copy(fields = section.fields.map { field -> if (field.id == fieldId) field.copy(value = value.take(2000)) else field }) else section
        }) }
    }
    fun addCaptured(id: String, path: String, video: Boolean) = work { addEvidence(id, files.captured(File(path), video)) }
    fun addRecordedVideo(id: String, uri: Uri) = work {
        val evidence = files.importRecordedVideo(uri)
        try {
            check(state.value != null) { "Заявка недоступна. Откройте её заново" }
            addEvidence(id, evidence)
        } catch (error: Exception) { files.remove(evidence.localPath); throw error }
        messages.send("Видео добавлено в отчёт")
    }
    fun importMedia(id: String, uris: List<Uri>) = work {
        val visit = state.value?.visits?.first { it.id == id } ?: return@work
        require(uris.size + visit.media.size <= 8) { "В отчёте может быть не больше 8 материалов" }
        for (uri in uris) addEvidence(id, files.import(uri))
    }
    private fun addEvidence(id: String, evidence: Evidence) { editDraft(id) { require(it.media.size < 8) { "Не больше 8 материалов" }; it.copy(media = it.media + evidence) } }
    fun removeEvidence(id: String, evidence: Evidence) = work {
        if (state.value?.remote == true && evidence.uploaded) api().request("media/$id/${evidence.id}", "DELETE")
        editDraft(id) { it.copy(media = it.media.filterNot { e -> e.id == evidence.id }) }; files.remove(evidence.localPath)
    }
    suspend fun previewEvidence(evidence: Evidence): File = withContext(Dispatchers.IO) {
        File(evidence.localPath).takeIf { evidence.localPath.isNotEmpty() && it.isFile } ?: files.destination(evidence).also { if (!it.isFile) api().download(evidence, it) }
    }
    fun reportError(message: String) { viewModelScope.launch { messages.send(message) } }
    private fun editDraft(id: String, block: (Visit) -> Visit) {
        val current = state.value ?: return; val visit = current.visits.first { it.id == id }
        require(!visit.pending && visit.status != VisitStatus.COMPLETED) { "Отчёт уже отправляется или визит закрыт" }
        val edited = block(visit)
        if (current.remote) {
            drafts.put(id, JSONObject().put("text", edited.draftReport).put("reportValues", reportValuesJson(edited)).put("media", JSONArray().apply { edited.media.forEach { put(evidenceJson(it)) } }))
            store.saveDrafts(settings, drafts); showRemote(current.syncMessage)
        } else saveDemo { it.copy(visits = it.visits.map { v -> if (v.id == id) edited else v }) }
    }
    private fun saveDemo(block: (DemoState) -> DemoState) {
        check(!storageFailed) { "Локальные данные недоступны. Используйте сброс демо в профиле" }
        val next = block(state.value ?: return); demo.save(next); mutableState.value = next
    }
    private fun api() = MobileApi(settings.server, settings.token, DatasetRules.version(snapshot?.optString("datasetVersion")))
    private fun now() = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))
}
