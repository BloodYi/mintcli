package dev.bloodyi.mintcli.mobile;

import org.junit.Test;
import static org.junit.Assert.*;

public class ConnectionPolicyTest {
    @Test public void acceptsSelfHostedWorkspaceAndNormalizesOnlyPath() {
        assertEquals("https://workspace.example/", ConnectionPolicy.normalize(" workspace.example "));
        assertEquals("http://192.168.1.4:3001/", ConnectionPolicy.normalize("http://192.168.1.4:3001"));
        assertEquals("https://workspace.example/a%2Fb", ConnectionPolicy.normalize("https://workspace.example/a%2Fb"));
    }

    @Test public void rejectsExecutableSchemesCredentialsAndInvalidPorts() {
        for (String bad : new String[] {"javascript:alert(1)", "file:///sdcard/test", "content://private/test",
                "intent://example", "https://user:password@example.com", "https://example.com:65536",
                "https://example.com:0", "https://example.com/#token", "https://example.com/?token=secret", ""}) {
            assertThrows(bad, IllegalArgumentException.class, () -> ConnectionPolicy.normalize(bad));
        }
    }

    @Test public void confidesBrowserToExactSchemeHostAndPort() {
        assertTrue(ConnectionPolicy.sameOrigin("https://example.com", "https://EXAMPLE.com:443/auth?state=1"));
        assertFalse(ConnectionPolicy.sameOrigin("https://example.com", "http://example.com/"));
        assertFalse(ConnectionPolicy.sameOrigin("https://example.com", "https://example.com.evil.test/"));
        assertFalse(ConnectionPolicy.sameOrigin("https://example.com", "https://example.com:8443/"));
        assertFalse(ConnectionPolicy.sameOrigin("https://example.com", "https://example.com@evil.test/"));
        assertFalse(ConnectionPolicy.sameOrigin("https://example.com", "javascript:alert(1)"));
    }
}
