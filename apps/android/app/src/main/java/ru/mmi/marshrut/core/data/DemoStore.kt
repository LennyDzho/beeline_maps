package ru.mmi.marshrut.core.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import ru.mmi.marshrut.core.model.*

/** Local prototype adapter; replace with Room + outbox when mobile API is available. */
class DemoStore(context: Context) {
    private val prefs = context.getSharedPreferences("marshrut_demo_v1", Context.MODE_PRIVATE)
    fun load(): DemoState {
        val raw = prefs.getString("state", null) ?: return DemoState()
        val root = JSONObject(raw)
        val saved = root.getJSONArray("visits")
        val visits = demoVisits().map { seed ->
            val item = (0 until saved.length()).map { saved.getJSONObject(it) }.firstOrNull { it.getString("id") == seed.id }
                ?: return@map seed
            val events = item.getJSONArray("events")
            val problems = item.getJSONArray("problems")
            seed.copy(status = VisitStatus.valueOf(item.getString("status")), report = item.getString("report"),
                draftReport = item.optString("draftReport"), media = item.optJSONArray("media")?.objects()?.map(::parseEvidence).orEmpty(),
                events = (0 until events.length()).map { events.getJSONObject(it).let { e -> VisitEvent(e.getString("title"), e.getString("detail")) } },
                problems = (0 until problems.length()).map { problems.getString(it) })
        }
        val notices = root.getJSONArray("notices")
        return DemoState(root.getBoolean("signedIn"), root.getBoolean("onShift"), visits,
            (0 until notices.length()).map { notices.getJSONObject(it).let { n ->
                Notice(n.getString("id"), n.getString("title"), n.getString("text"), n.getString("time"),
                    if (n.isNull("visitId")) null else n.getString("visitId"), n.getBoolean("read"))
            } })
    }
    fun save(state: DemoState) {
        val root = JSONObject().put("signedIn", state.signedIn).put("onShift", state.onShift)
            .put("visits", JSONArray().apply { state.visits.forEach { visit -> put(JSONObject()
                .put("id", visit.id).put("status", visit.status.name).put("report", visit.report)
                .put("draftReport", visit.draftReport).put("media", JSONArray().apply { visit.media.forEach { put(evidenceJson(it)) } })
                .put("events", JSONArray().apply { visit.events.forEach { put(JSONObject().put("title", it.title).put("detail", it.detail)) } })
                .put("problems", JSONArray(visit.problems))) } })
            .put("notices", JSONArray().apply { state.notices.forEach { n -> put(JSONObject()
                .put("id", n.id).put("title", n.title).put("text", n.text).put("time", n.time)
                .put("visitId", n.visitId ?: JSONObject.NULL).put("read", n.read)) } })
        check(prefs.edit().putString("state", root.toString()).commit()) { "Не удалось сохранить изменения на устройстве" }
    }
}
