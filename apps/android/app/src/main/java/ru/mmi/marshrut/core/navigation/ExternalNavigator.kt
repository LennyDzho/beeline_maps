package ru.mmi.marshrut.core.navigation

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import ru.mmi.marshrut.core.model.Visit

fun openNavigator(context: Context, visit: Visit): Boolean {
    val query = Uri.encode(visit.address)
    val location = if (visit.latitude != null && visit.longitude != null) "${visit.latitude},${visit.longitude}" else "0,0"
    return try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("geo:$location?q=${if (location == "0,0") query else "$location($query)"}")))
        true
    } catch (_: ActivityNotFoundException) { false }
}
