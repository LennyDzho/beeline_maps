package ru.mmi.marshrut.core.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import ru.mmi.marshrut.core.model.*

data class ConnectionSettings(val server: String = ServerAddress.DEFAULT, val email: String = "", val token: String = "",
    val accountId: String = "", val mustChangePassword: Boolean = false)

class ConnectionStore(context: Context) {
    private val prefs = context.getSharedPreferences("marsh_connection_v1", Context.MODE_PRIVATE)
    fun settings(): ConnectionSettings {
        val encrypted = prefs.getString("token", "").orEmpty()
        return ConnectionSettings(prefs.getString("server", ServerAddress.DEFAULT)!!, prefs.getString("email", "")!!,
            if (encrypted.isEmpty()) "" else decrypt(encrypted), prefs.getString("account", "")!!, prefs.getBoolean("change_password", false))
    }
    fun saveSettings(settings: ConnectionSettings) { check(prefs.edit().putString("server", settings.server).putString("email", settings.email)
        .putString("token", if (settings.token.isEmpty()) "" else encrypt(settings.token)).putString("account", settings.accountId)
        .putBoolean("change_password", settings.mustChangePassword).commit()) }
    // Account and server are part of the namespace; one login can never inherit another worker's drafts.
    private fun key(settings: ConnectionSettings, name: String) = "$name:${settings.server}:${settings.accountId}"
    fun snapshot(settings: ConnectionSettings) = prefs.getString(key(settings, "snapshot"), null)?.let(::JSONObject)
    fun saveSnapshot(settings: ConnectionSettings, value: JSONObject) { check(prefs.edit().putString(key(settings, "snapshot"), value.toString()).commit()) }
    fun replaceDataset(settings: ConnectionSettings, value: JSONObject) {
        // Snapshot and pending writes change together, including after a process restart.
        check(prefs.edit().putString(key(settings, "snapshot"), value.toString())
            .putString(key(settings, "drafts"), "{}").putString(key(settings, "queue"), "[]").commit())
    }
    fun drafts(settings: ConnectionSettings) = JSONObject(prefs.getString(key(settings, "drafts"), "{}")!!)
    fun saveDrafts(settings: ConnectionSettings, value: JSONObject) { check(prefs.edit().putString(key(settings, "drafts"), value.toString()).commit()) }
    fun queue(settings: ConnectionSettings) = JSONArray(prefs.getString(key(settings, "queue"), "[]")!!)
    fun saveQueue(settings: ConnectionSettings, value: JSONArray) { check(prefs.edit().putString(key(settings, "queue"), value.toString()).commit()) }
    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("marsh_session_v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("marsh_session_v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun encrypt(value: String): String { val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, secret())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP) }
    private fun decrypt(value: String): String { val bytes = Base64.decode(value, Base64.NO_WRAP); val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8) }
}

fun evidenceJson(e: Evidence) = JSONObject().put("id", e.id).put("name", e.name).put("mimeType", e.mimeType).put("size", e.size)
    .put("localPath", e.localPath).put("uploaded", e.uploaded).put("capturedAt", e.capturedAt)
fun parseEvidence(e: JSONObject) = Evidence(e.getString("id"), e.getString("name"), e.getString("mimeType"), e.getLong("size"),
    e.optString("localPath"), e.optBoolean("uploaded", true), e.optString("capturedAt").takeUnless { it == "null" }.orEmpty())
fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

fun parseRemoteState(root: JSONObject, drafts: JSONObject, queue: JSONArray, syncMessage: String): DemoState {
    val profile = root.getJSONObject("profile")
    return DemoState(signedIn = true, remote = true, onShift = root.getBoolean("onShift"),
        profile = WorkerProfile(profile.getString("name"), profile.getString("email"), profile.getString("organization"), profile.getJSONArray("skills").let { (0 until it.length()).joinToString(" · ") { i -> it.getString(i) } }, profile.optString("timezone"), profile.optString("timezoneLabel")),
        serviceDate = root.getString("serviceDate"), availableDates = root.getJSONArray("availableDates").let { (0 until it.length()).map { i -> it.getString(i) } },
        syncMessage = syncMessage, pendingCount = queue.length(),
        notices = root.getJSONArray("notices").objects().map { n -> Notice(n.getString("id"), n.getString("title"), n.getString("text"), n.getString("time"), if (n.isNull("visitId")) null else n.getString("visitId"), n.getBoolean("read")) },
        visits = root.getJSONArray("visits").objects().map { v ->
            val id = v.getString("id"); val draft = drafts.optJSONObject(id)
            val status = when (v.getString("status")) { "en_route" -> VisitStatus.EN_ROUTE; "in_progress" -> VisitStatus.IN_PROGRESS; "paused" -> VisitStatus.PAUSED; "completed", "confirmed" -> VisitStatus.COMPLETED; else -> VisitStatus.CONFIRMED }
            val reportValues = if (status == VisitStatus.COMPLETED) v.optJSONObject("reportValues") else draft?.optJSONObject("reportValues") ?: v.optJSONObject("reportValues")
            val start = v.getString("scheduledStart"); val end = v.optString("scheduledEnd")
            val minutes = v.getInt("durationMinutes")
            val serverMedia = v.getJSONArray("media").objects().map(::parseEvidence)
            val localMedia = draft?.optJSONArray("media")?.objects()?.map(::parseEvidence).orEmpty()
            val mergedMedia = if (status == VisitStatus.COMPLETED) serverMedia.map { e -> e.copy(localPath = localMedia.firstOrNull { it.id == e.id }?.localPath.orEmpty()) }
                else if (draft?.has("media") == true) localMedia.map { e -> e.copy(uploaded = e.uploaded || serverMedia.any { it.id == e.id }) } else serverMedia
            Visit(id, v.getString("title"), v.getString("address"), v.getString("entrance"),
                regionalInterval(start, end), "$minutes мин.", v.optJSONArray("workTypes")?.objects()?.joinToString(" + ") { it.getString("name") }?.takeIf { it.isNotBlank() } ?: v.getString("title"),
                v.getBoolean("highPriority"), status,
                v.getJSONArray("events").objects().map { VisitEvent(it.getString("title"), it.getString("detail")) }, v.getString("report"),
                v.getJSONArray("problems").let { (0 until it.length()).map { i -> it.getString(i) } }, mergedMedia, draft?.optString("text") ?: v.getString("report"),
                v.getInt("revision"), v.getString("description"), start.take(10), v.getString("number"), v.optString("reportStatus"),
                queue.objects().any { it.optString("visitId") == id }, if (v.isNull("latitude")) null else v.getDouble("latitude"), if (v.isNull("longitude")) null else v.getDouble("longitude"),
                categoryName = v.optString("categoryName").takeUnless { it == "null" }.orEmpty(),
                clientWindow = if (v.optString("clientWindowStart").length >= 16) regionalInterval(v.getString("clientWindowStart"), v.optString("clientWindowEnd")) else "",
                equipment = v.optJSONArray("equipment")?.objects()?.map { e -> RequiredEquipment(e.getString("id"), e.getString("name"), if (e.isNull("quantity")) null else e.getDouble("quantity"), e.optString("unit"), e.optString("usage")) }.orEmpty(),
                reportSections = v.optJSONArray("reportRequirements")?.objects()?.map { section ->
                    val versionId = section.getString("versionId")
                    ReportSection(versionId, section.getString("name"), section.getJSONArray("fields").objects().map { field ->
                        ReportField(field.getString("id"), field.getString("label"), field.getBoolean("required"), reportValues?.optJSONObject(versionId)?.optString(field.getString("id")).orEmpty())
                    }, section.optInt("minPhotos"), section.optInt("minVideos"), section.optString("configurationError"))
                }.orEmpty())
        })
}

fun reportValuesJson(visit: Visit) = JSONObject().apply {
    visit.reportSections.forEach { section -> put(section.versionId, JSONObject().apply { section.fields.forEach { field -> put(field.id, field.value) } }) }
}
