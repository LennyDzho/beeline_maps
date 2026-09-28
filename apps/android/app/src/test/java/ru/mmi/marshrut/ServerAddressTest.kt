package ru.mmi.marshrut
import org.junit.Assert.*
import org.junit.Test
import ru.mmi.marshrut.core.data.ServerAddress

class ServerAddressTest {
    @Test fun internetServerCanBeChangedWithoutRebuilding() { assertEquals("https://service.example.org:8443", ServerAddress.normalize(" https://service.example.org:8443/ ")) }
    @Test fun emulatorUsesHostComputerAddress() { assertEquals("http://10.0.2.2:3000", ServerAddress.normalize(ServerAddress.DEFAULT)) }
    @Test fun credentialsMustNotGoToInsecureRemoteServer() { assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize("http://service.example.org") } }
    @Test fun rejectCredentialsQueryFragmentAndUnexpectedPath() {
        for (url in listOf("https://name:secret@example.org", "https://example.org/?token=secret", "https://example.org/#token", "https://example.org/path")) assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize(url) }
    }
    @Test fun rejectUnsupportedSchemeAndInvalidPort() {
        for (url in listOf("file:///etc/password", "https://example.org:99999", "ftp://example.org")) assertThrows(IllegalArgumentException::class.java) { ServerAddress.normalize(url) }
    }
}
