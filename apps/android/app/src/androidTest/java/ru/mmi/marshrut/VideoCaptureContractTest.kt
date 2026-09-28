package ru.mmi.marshrut

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import ru.mmi.marshrut.core.data.EvidenceFiles
import ru.mmi.marshrut.feature.visit.ShortVideoContract
import ru.mmi.marshrut.feature.visit.VideoCaptureResult
import java.io.File

/** Does not launch/reset the app or touch user sessions, reports or server data. */
@RunWith(AndroidJUnit4::class)
class VideoCaptureContractTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val files = EvidenceFiles(context)
    private val contract = ShortVideoContract()
    private val uri = Uri.parse("content://media/external/video/media/42")

    @Test fun cameraOwnsOutputAndAvoidsLegacyCameraExtras() {
        val intent = contract.createIntent(context, Unit)
        assertEquals(MediaStore.ACTION_VIDEO_CAPTURE, intent.action)
        assertFalse(intent.hasExtra(MediaStore.EXTRA_OUTPUT))
        if (intent.resolveActivity(context.packageManager)?.packageName == "com.android.camera2") {
            assertNull("Legacy Camera2 crashes even with duration/quality extras", intent.extras)
        } else {
            assertEquals(60, intent.getIntExtra(MediaStore.EXTRA_DURATION_LIMIT, -1))
            assertEquals(32L * 1024 * 1024, intent.getLongExtra(MediaStore.EXTRA_SIZE_LIMIT, -1))
            assertEquals(1, intent.getIntExtra(MediaStore.EXTRA_VIDEO_QUALITY, -1))
        }
    }

    @Test fun successfulRecordingUsesReturnedUriOrClipData() {
        assertEquals(VideoCaptureResult.Recorded(uri), contract.parseResult(Activity.RESULT_OK, Intent().setData(uri)))
        val clipIntent = Intent().apply { clipData = ClipData.newRawUri("video", uri) }
        assertEquals(VideoCaptureResult.Recorded(uri), contract.parseResult(Activity.RESULT_OK, clipIntent))
    }

    @Test fun cancelAndMissingFileNeverAttachVideo() {
        assertEquals(VideoCaptureResult.Canceled, contract.parseResult(Activity.RESULT_CANCELED, Intent().setData(uri)))
        assertEquals(VideoCaptureResult.Canceled, contract.parseResult(Activity.RESULT_CANCELED, null))
        assertEquals(VideoCaptureResult.MissingVideo, contract.parseResult(Activity.RESULT_OK, Intent()))
        assertEquals(VideoCaptureResult.MissingVideo, contract.parseResult(Activity.RESULT_OK, null))
    }

    @Test fun returnedVideoIsCopiedAndRemainsPlayableWithoutCameraSource() {
        val source = files.newCapture(true)
        var copy: File? = null
        try {
            writeTestVideo(source)
            val bytes = source.readBytes()
            val evidence = files.importRecordedVideo(files.uri(source))
            copy = File(evidence.localPath)
            assertNotEquals(source.absolutePath, copy.absolutePath)
            assertArrayEquals(bytes, copy.readBytes())
            assertEquals("video/mp4", evidence.mimeType)
            assertTrue(evidence.name.startsWith("Видео_"))
            assertTrue(evidence.capturedAt.isNotBlank())
            assertTrue(source.delete())
            val metadata = MediaMetadataRetriever()
            try {
                metadata.setDataSource(copy.absolutePath)
                assertTrue(metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)!!.toLong() > 0)
                assertNotNull(metadata.getFrameAtTime(0))
            } finally { metadata.release() }
        } finally { source.delete(); copy?.delete() }
    }

    @Test fun truncatedRecordingIsRejectedAndPartialCopyIsRemoved() {
        val source = files.newCapture(true)
        try {
            source.writeBytes(ByteArray(256))
            val before = source.parentFile!!.list()!!.toSet()
            try {
                files.importRecordedVideo(files.uri(source))
                fail("An incomplete recording must not be attached")
            } catch (expected: IllegalArgumentException) {
                assertTrue(expected.message!!.startsWith("Видео не добавлено"))
            }
            assertEquals(before, source.parentFile!!.list()!!.toSet())
            assertTrue(source.exists())
        } finally { source.delete() }
    }

    @Test fun recordingOverOneMinuteIsRejectedEvenWhenCameraIgnoresLimit() {
        val source = files.newCapture(true)
        try {
            writeTestVideo(source, frameIntervalUs = 4_000_000L)
            val before = source.parentFile!!.list()!!.toSet()
            try {
                files.importRecordedVideo(files.uri(source))
                fail("An overlong camera recording must not be attached")
            } catch (expected: IllegalArgumentException) {
                assertTrue(expected.message!!.contains("60 секунд"))
            }
            assertEquals(before, source.parentFile!!.list()!!.toSet())
        } finally { source.delete() }
    }
}
