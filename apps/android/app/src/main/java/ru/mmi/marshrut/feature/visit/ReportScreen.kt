package ru.mmi.marshrut.feature.visit

import android.graphics.BitmapFactory
import android.widget.MediaController
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ru.mmi.marshrut.MarshrutViewModel
import ru.mmi.marshrut.core.model.*
import ru.mmi.marshrut.ui.theme.*
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun ReportScreen(visit: Visit, remote: Boolean, model: MarshrutViewModel, back: () -> Unit, snackbar: SnackbarHostState) {
    val connection by model.connection.collectAsStateWithLifecycle()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    var capturePath by rememberSaveable(visit.id) { mutableStateOf("") }
    var text by rememberSaveable(visit.id) { mutableStateOf(visit.draftReport) }
    var checked by rememberSaveable(visit.id) { mutableStateOf(false) }
    var preview by remember { mutableStateOf<Evidence?>(null) }
    val complete = visit.status == VisitStatus.COMPLETED
    val requirementsError = reportRequirementsError(visit)
    val editable = !complete && !visit.pending && !connection.busy
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success && capturePath.isNotEmpty()) model.addCaptured(visit.id, capturePath, false) else model.files.remove(capturePath)
        capturePath = ""
    }
    val video = rememberLauncherForActivityResult(ShortVideoContract()) { result ->
        when (result) {
            is VideoCaptureResult.Recorded -> model.addRecordedVideo(visit.id, result.uri)
            VideoCaptureResult.Canceled -> model.reportError("Видео не добавлено: запись отменена или камера не сохранила файл")
            VideoCaptureResult.MissingVideo -> model.reportError("Камера не вернула видео. Повторите запись или выберите ролик из файлов")
        }
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> if (uris.isNotEmpty()) model.importMedia(visit.id, uris) }
    fun capture(isVideo: Boolean) {
        focus.clearFocus(); keyboard?.hide()
        try {
            if (isVideo) video.launch(Unit)
            else {
                val file = model.files.newCapture(false)
                capturePath = file.absolutePath
                photo.launch(model.files.uri(file))
            }
        }
        catch (_: Exception) { model.files.remove(capturePath); capturePath = ""; model.reportError("Камера недоступна. Можно выбрать материалы из файлов") }
    }
    Scaffold(modifier = Modifier.imePadding(), contentWindowInsets = WindowInsets(0,0,0,0), snackbarHost = { SnackbarHost(snackbar) },
        topBar = { TopAppBar(title = { Text(if (complete) "Результат работы" else "Отчёт по ${visit.number}") }, navigationIcon = { IconButton(back) { Icon(Icons.Outlined.ArrowBack, "Назад") } }) },
        bottomBar = { Surface(shadowElevation = 4.dp) { Column(Modifier.fillMaxWidth().padding(16.dp)) {
            if (complete) Button(back, Modifier.fillMaxWidth()) { Text("Вернуться к заявке") }
            else if (visit.pending) { Text("Отчёт в очереди отправки", color = Purple); Text(connection.message, style = MaterialTheme.typography.bodyMedium); TextButton({ model.refresh() }, enabled = !connection.busy) { Text("Повторить отправку") } }
            else Button({ model.transition(visit.id, VisitStatus.COMPLETED, text) }, Modifier.fillMaxWidth().heightIn(min = 52.dp),
                enabled = editable && checked && text.trim().length >= 10 && visit.media.isNotEmpty() && requirementsError == null) { Text(if (remote) "Отправить отчёт и завершить" else "Завершить") }
        } } }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(visit.title, style = MaterialTheme.typography.titleLarge)
            Text(visit.address, color = Muted)
            ReportFields(visit, !visit.pending, complete) { versionId, fieldId, value -> model.saveReportField(visit.id, versionId, fieldId, value) }
            if (!complete && requirementsError != null) Text(requirementsError, color = MaterialTheme.colorScheme.error)
            if (complete) { Text(visit.report); Text(if (remote) "Отчёт отправлен на сервер" else "Сохранено на устройстве · демо", color = Success) }
            else {
                OutlinedTextField(text, { text = it.take(2000); model.saveReportText(visit.id, text) }, label = { Text("Результат работы") },
                    placeholder = { Text("Что сделано и проверено") }, minLines = 3, maxLines = 7, modifier = Modifier.fillMaxWidth(), enabled = !complete && !visit.pending,
                    supportingText = { Text("Минимум 10 символов · ${text.length}/2000") })
                Text("Фото и видео (${visit.media.size}/8)", style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton({ capture(false) }, Modifier.weight(1f), enabled = editable && visit.media.size < 8) { Icon(Icons.Outlined.AddAPhoto, null); Spacer(Modifier.width(6.dp)); Text("Фото") }
                    OutlinedButton({ capture(true) }, Modifier.weight(1f), enabled = editable && visit.media.size < 8) { Icon(Icons.Outlined.Videocam, null); Spacer(Modifier.width(6.dp)); Text("Видео") }
                }
                OutlinedButton({ focus.clearFocus(); keyboard?.hide(); try { picker.launch(arrayOf("image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm")) } catch (_: Exception) { model.reportError("Выбор файлов недоступен") } }, Modifier.fillMaxWidth(), enabled = editable && visit.media.size < 8) { Text("Выбрать из файлов") }
                Text("Добавьте хотя бы один материал. Фото — до 12 МБ, видео — до 32 МБ и 60 секунд. После записи подтвердите ролик в камере.", style = MaterialTheme.typography.bodyMedium, color = Muted)
            }
            visit.media.forEach { evidence ->
                OutlinedCard { Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton({ focus.clearFocus(); keyboard?.hide(); preview = evidence }) { Icon(if (evidence.isVideo) Icons.Outlined.PlayCircle else Icons.Outlined.Image, "Открыть ${evidence.name}", tint = Purple) }
                    Column(Modifier.weight(1f).clickable { focus.clearFocus(); keyboard?.hide(); preview = evidence }) {
                        Text(evidence.name, style = MaterialTheme.typography.bodyMedium)
                        Text("${if (evidence.isVideo) "Видео" else "Фото"} · ${"%.1f".format(evidence.size / 1048576.0)} МБ", color = Muted, style = MaterialTheme.typography.labelMedium)
                        Text(if (evidence.uploaded && remote) "Загружено на сервер" else "На устройстве", color = Muted, style = MaterialTheme.typography.labelMedium)
                    }
                    if (!complete) IconButton({ model.removeEvidence(visit.id, evidence) }, enabled = editable) { Icon(Icons.Outlined.DeleteOutline, "Убрать ${evidence.name}") }
                } }
            }
            if (!complete) {
                Row(Modifier.fillMaxWidth().testTag("report-confirmation").toggleable(value = checked, enabled = editable, role = Role.Checkbox,
                    onValueChange = { focus.clearFocus(); keyboard?.hide(); checked = it }), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked, onCheckedChange = null, enabled = editable); Text("Работа выполнена, результат проверен")
                }
                Text(if (remote) "Черновик сохраняется на устройстве. После отправки текст, фото и видео появятся в карточке диспетчера." else "Демо: отчёт и материалы сохранятся на устройстве.", style = MaterialTheme.typography.bodyMedium, color = Muted)
            }
            if (connection.busy) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(connection.message) }
        }
    }
    preview?.let { EvidencePreview(it, model) { preview = null } }
}

@Composable fun ReportFields(visit: Visit, enabled: Boolean, readOnly: Boolean, onChange: (String, String, String) -> Unit) {
    visit.reportSections.forEach { section ->
        Text(section.name, style = MaterialTheme.typography.titleMedium)
        if (section.minPhotos > 0 || section.minVideos > 0) Text("Для этой работы: фото — ${section.minPhotos}, видео — ${section.minVideos}. Материалы общие для выезда.", color = Muted)
        section.fields.forEach { field -> key(section.versionId, field.id) {
            var value by rememberSaveable(visit.id, section.versionId, field.id) { mutableStateOf(field.value) }
            OutlinedTextField(if (readOnly) field.value else value, { value = it.take(2000); onChange(section.versionId, field.id, value) },
                label = { Text(field.label + if (field.required) " *" else "") }, modifier = Modifier.fillMaxWidth(),
                readOnly = readOnly, enabled = enabled, minLines = 1, maxLines = 5)
        } }
    }
}

@Composable private fun EvidencePreview(evidence: Evidence, model: MarshrutViewModel, close: () -> Unit) {
    var file by remember(evidence.id) { mutableStateOf<File?>(null) }
    var bitmap by remember(evidence.id) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(evidence.id) { mutableStateOf<String?>(null) }
    var videoView by remember { mutableStateOf<VideoView?>(null) }
    LaunchedEffect(evidence.id) {
        try {
            file = model.previewEvidence(evidence)
            if (!evidence.isVideo) bitmap = withContext(Dispatchers.IO) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }; BitmapFactory.decodeFile(file!!.absolutePath, bounds)
                val options = BitmapFactory.Options().apply { inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 1400).coerceAtLeast(1) }
                BitmapFactory.decodeFile(file!!.absolutePath, options)?.asImageBitmap() ?: error("Фото не удалось открыть")
            }
        } catch (e: Exception) { error = e.message ?: "Материал недоступен" }
    }
    DisposableEffect(Unit) { onDispose { videoView?.stopPlayback() } }
    Dialog(close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().fillMaxHeight(.9f)) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(evidence.name, style = MaterialTheme.typography.titleMedium)
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                when {
                    error != null -> Text(error!!)
                    file == null -> CircularProgressIndicator()
                    evidence.isVideo -> AndroidView(factory = { context -> VideoView(context).apply {
                        videoView = this; setMediaController(MediaController(context).also { it.setAnchorView(this) })
                        setVideoURI(model.files.uri(file!!)); setOnPreparedListener { start() }; setOnErrorListener { _, _, _ -> error = "Не удалось воспроизвести видео"; true }
                    } }, modifier = Modifier.fillMaxSize())
                    bitmap != null -> Image(bitmap!!, evidence.name, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                    else -> CircularProgressIndicator()
                }
            }
            Button(close, Modifier.fillMaxWidth()) { Text("Закрыть") }
        } }
    }
}
