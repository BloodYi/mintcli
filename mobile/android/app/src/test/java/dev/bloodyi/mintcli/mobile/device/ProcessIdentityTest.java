package dev.bloodyi.mintcli.mobile.device;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class ProcessIdentityTest {
    private static String stat(String comm, String start) {
        StringBuilder line = new StringBuilder("123 (").append(comm).append(") R");
        for (int field = 4; field < 22; field++) line.append(' ').append(field);
        return line.append(' ').append(start).append(" 0 0 0\n").toString();
    }

    @Test public void startTimeIsField22AfterCommandContainingParenthesesAndWhitespace() {
        assertEquals("923456789", ProcessIdentity.parseStart(stat("app (worker)) with\nspace", "923456789")));
        assertEquals("0", ProcessIdentity.parseStart(stat("simple", "0")));
        assertEquals("18446744073709551615", ProcessIdentity.parseStart(stat("large", "18446744073709551615")));
    }

    @Test public void malformedOrMissingStartTimeCannotBecomeAnIdentity() {
        for (String value : new String[] {null, "", "123 no-command R 1", "123 (x) R 1",
                stat("x", "-1"), stat("x", "1.2"), stat("x", "not-a-time")}) {
            try {
                ProcessIdentity.parseStart(value);
                fail("Expected malformed stat to be rejected");
            } catch (IllegalArgumentException expected) { }
        }
    }

    @Test public void expectedIdentityMustBeAnExactNonnegativeDecimalToken() {
        assertEquals("123456", ProcessIdentity.expected("123456"));
        for (String value : new String[] {null, "", "-1", "+1", "1.0", " 1", "1 2", "x"}) {
            try {
                ProcessIdentity.expected(value);
                fail("Expected invalid identity to be rejected");
            } catch (IllegalArgumentException expected) { }
        }
    }
}
