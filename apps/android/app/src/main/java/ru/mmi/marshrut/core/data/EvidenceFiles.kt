package ru.mmi.marshrut.core.data

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import ru.mmi.marshrut.core.model.Evidence
import java.io.File
import java.time.Instant
import java.util.UUID

class EvidenceFiles(private val context: Context) {
    private val directory = File(context.filesDir, "evidence").apply { mkdirs() }
    fun newCapture(video: Boolean): File = File(directory, "${UUID.randomUUID()}.${if (video) "mp4" else "jpg"}").apply { createNewFile() }
    fun uri(file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    fun captured(file: File, video: Boolean): Evidence {
        require(file.canonicalFile.parentFile == directory.canonicalFile) { "Недопустимый файл" }
        validateSize(file.length(), video)
        return Evidence(file.nameWithoutExtension, "${if (video) "Видео" else "Фото"}_${Instant.now().toString().take(19).replace(':', '-')}.${file.extension}", if (video) "video/mp4" else "image/jpeg", file.length(), file.absolutePath, capturedAt = Instant.now().toString())
    }
    fun import(uri: Uri): Evidence {
        val resolver = context.contentResolver
        val mime = resolver.getType(uri).orEmpty()
        val extension = mapOf("image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "video/mp4" to "mp4", "video/webm" to "webm")[mime]
            ?: error("Поддерживаются JPEG, PNG, WebP, MP4 и WebM")
        val file = File(directory, "${UUID.randomUUID()}.$extension")
        var name = file.name
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) name = it.getString(0).take(200) }
        try {
            resolver.openInputStream(uri)?.use { input -> file.outputStream().use { output ->
                val bytes = ByteArray(65536); var size = 0L
                while (true) { val count = input.read(bytes); if (count < 0) break; size += count; validateSize(size, mime.startsWith("video/"), false); output.write(bytes, 0, count) }
            } } ?: error("Не удалось открыть файл")
            validateSize(file.length(), mime.startsWith("video/"))
            return Evidence(file.nameWithoutExtension, name, mime, file.length(), file.absolutePath)
        } catch (error: Exception) { file.delete(); throw error }
    }
    fun importRecordedVideo(uri: Uri): Evidence {
        val evidence = import(uri)
        val duration = try {
            require(evidence.isVideo) { "Камера вернула файл, который не является видео" }
            val metadata = MediaMetadataRetriever()
            try {
                metadata.setDataSource(evidence.localPath)
                val duration = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
                val width = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val height = metadata.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                require(duration > 0 && width > 0 && height > 0) { "Камера не завершила запись видео. Повторите съёмку" }
                duration
            } finally { metadata.release() }
        } catch (error: Exception) {
            remove(evidence.localPath)
            throw IllegalArgumentException("Видео не добавлено: запись не удалось прочитать. Повторите съёмку", error)
        }
        // Camera apps may ignore recording limits; allow one second for encoder finalization.
        if (duration > 61_000) {
            remove(evidence.localPath)
            throw IllegalArgumentException("Видео не добавлено: запишите ролик длительностью до 60 секунд")
        }
        val capturedAt = Instant.now().toString()
        return evidence.copy(name = "Видео_${capturedAt.take(19).replace(':', '-')}.${File(evidence.localPath).extension}", capturedAt = capturedAt)
    }
    fun destination(evidence: Evidence) = File(directory, "${evidence.id}.${if (evidence.isVideo) "mp4" else "jpg"}")
    fun remove(path: String) { if (path.isNotBlank()) File(path).let { if (it.canonicalFile.parentFile == directory.canonicalFile) it.delete() } }
    private fun validateSize(size: Long, video: Boolean, checkEmpty: Boolean = true) {
        require(!checkEmpty || size >= 12) { "Файл пустой или съёмка отменена" }
        require(size <= (if (video) 32L else 12L) * 1024 * 1024) { "Лимит: 12 МБ для фото, 32 МБ для видео. Выберите более короткое видео" }
    }
}
