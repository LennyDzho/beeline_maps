package ru.mmi.marshrut.core.data

import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.security.MessageDigest
import ru.mmi.marshrut.core.model.Evidence

class ApiException(val status: Int, message: String, val code: String = "") : Exception(message)

object ServerAddress {
    const val DEFAULT = "http://10.0.2.2:3000"
    fun normalize(input: String): String {
        val uri = try { URI(input.trim()) } catch (_: Exception) { error("Проверьте адрес сервера") }
        require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) { "Укажите адрес сервера без пути, логина и параметров" }
        require(uri.scheme == "https" || (uri.scheme == "http" && uri.host in listOf("10.0.2.2", "localhost", "127.0.0.1"))) { "Для интернет-сервера нужен HTTPS. HTTP разрешён только для локального тестирования" }
        require(uri.port == -1 || uri.port in 1..65535) { "Некорректный порт сервера" }
        return uri.toString().trimEnd('/')
    }
}

class MobileApi(private val server: String, private val token: String = "", private val datasetVersion: String = "legacy") {
    private fun connection(path: String, method: String): HttpURLConnection {
        val url = URI(ServerAddress.normalize(server) + "/api/mobile/v1/" + path).toURL()
        return (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method; connectTimeout = 12000; readTimeout = 60000
            instanceFollowRedirects = false; useCaches = false
            setRequestProperty("Accept", "application/json")
            if (token.isNotEmpty()) setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("X-Dataset-Version", datasetVersion)
        }
    }
    fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject {
        val connection = connection(path, method)
        try {
            if (body != null) {
                val bytes = body.toString().toByteArray(Charsets.UTF_8)
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { it.write(bytes) }
            }
            return response(connection)
        } finally { connection.disconnect() }
    }
    fun upload(visitId: String, evidence: Evidence) {
        val file = File(evidence.localPath)
        require(file.isFile && file.length() == evidence.size) { "Локальный файл ${evidence.name} недоступен" }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
        val checksum = digest.digest().joinToString("") { "%02x".format(it) }
        val connection = connection("media/${encode(visitId)}/${encode(evidence.id)}", "PUT")
        try {
            connection.doOutput = true; connection.setFixedLengthStreamingMode(file.length())
            connection.setRequestProperty("Content-Type", evidence.mimeType)
            connection.setRequestProperty("X-File-Name", encode(evidence.name))
            connection.setRequestProperty("X-Content-SHA256", checksum)
            if (evidence.capturedAt.isNotEmpty()) connection.setRequestProperty("X-Captured-At", evidence.capturedAt)
            connection.outputStream.use { output -> file.inputStream().use { it.copyTo(output, 65536) } }
            response(connection)
        } finally { connection.disconnect() }
    }
    fun download(evidence: Evidence, destination: File) {
        val connection = connection("media/${encode(evidence.id)}", "GET")
        val partial = File(destination.parentFile, destination.name + ".part")
        try {
            if (connection.responseCode != 200) { response(connection); error("Файл недоступен") }
            val limit = if (evidence.isVideo) 32L * 1024 * 1024 else 12L * 1024 * 1024
            connection.inputStream.use { input -> partial.outputStream().use { output ->
                val buffer = ByteArray(65536); var size = 0L
                while (true) { val count = input.read(buffer); if (count < 0) break; size += count; require(size <= limit) { "Файл слишком большой" }; output.write(buffer, 0, count) }
                require(size == evidence.size) { "Файл получен не полностью" }
            } }
            check(partial.renameTo(destination)) { "Не удалось сохранить материал" }
        } finally { partial.delete(); connection.disconnect() }
    }
    private fun response(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val source = stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
            val text = StringBuilder(); val buffer = CharArray(4096)
            while (true) { val count = reader.read(buffer); if (count < 0) break; require(text.length + count <= 2_000_000) { "Ответ сервера слишком большой" }; text.append(buffer, 0, count) }; text.toString()
        }.orEmpty()
        val body = try { JSONObject(source) } catch (_: Exception) { null }
        if (status !in 200..299) throw ApiException(status, body?.optString("message")?.takeIf { it.isNotBlank() } ?: "Сервер вернул HTTP $status. Проверьте адрес и доступность API", body?.optString("code").orEmpty())
        return body ?: throw ApiException(502, "По этому адресу нет API приложения «Марш!»")
    }
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
