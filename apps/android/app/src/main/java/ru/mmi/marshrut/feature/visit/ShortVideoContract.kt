package ru.mmi.marshrut.feature.visit

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.result.contract.ActivityResultContract

sealed interface VideoCaptureResult {
    data class Recorded(val uri: Uri) : VideoCaptureResult
    data object Canceled : VideoCaptureResult
    data object MissingVideo : VideoCaptureResult
}

/** Let the camera finish its own file, then copy the returned URI into the report. */
class ShortVideoContract : ActivityResultContract<Unit, VideoCaptureResult>() {
    override fun createIntent(context: Context, input: Unit): Intent {
        val intent = Intent(MediaStore.ACTION_VIDEO_CAPTURE)
        // Legacy AOSP Camera2 skips creating its output whenever getExtras() is non-null.
        // Even duration/quality extras trigger that bug. Validate its result on import.
        if (intent.resolveActivity(context.packageManager)?.packageName == "com.android.camera2") return intent
        return intent
            .putExtra(MediaStore.EXTRA_DURATION_LIMIT, 60)
            .putExtra(MediaStore.EXTRA_SIZE_LIMIT, 32L * 1024 * 1024)
            .putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 1)
    }

    override fun parseResult(resultCode: Int, intent: Intent?): VideoCaptureResult {
        if (resultCode != Activity.RESULT_OK) return VideoCaptureResult.Canceled
        val uri = intent?.data ?: intent?.clipData?.let {
            if (it.itemCount > 0) it.getItemAt(0).uri else null
        }
        return uri?.let(VideoCaptureResult::Recorded) ?: VideoCaptureResult.MissingVideo
    }
}
