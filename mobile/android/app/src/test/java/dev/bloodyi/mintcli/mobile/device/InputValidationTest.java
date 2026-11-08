package dev.bloodyi.mintcli.mobile.device;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class InputValidationTest {
    private static void rejects(Runnable operation) {
        try {
            operation.run();
            fail("Expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            // Invalid input must be rejected before opening a process or file.
        }
    }

    @Test public void addressesAcceptPrefixCaseAndLargestSupportedValue() {
        assertEquals(0L, InputValidation.address("0"));
        assertEquals(0xabcDEF12L, InputValidation.address("  0xAbCdEf12  "));
        assertEquals(0xabcDEF12L, InputValidation.address("0XABCDEF12"));
        assertEquals(Long.MAX_VALUE, InputValidation.address("7fffffffffffffff"));
    }

    @Test public void addressesRejectOverflowSignsAndNonHexadecimalInput() {
        for (String value : new String[] {
                "8000000000000000", "FFFFFFFFFFFFFFFF", "10000000000000000",
                "-1", "+10", "0x", "", "0x12 34", "0x12G4", "1.0", "1;reboot"
        }) {
            rejects(() -> InputValidation.address(value));
        }
        rejects(() -> InputValidation.address(null));
    }

    @Test public void pidMustIdentifyAnOrdinaryPositiveProcess() {
        assertEquals(2, InputValidation.pid(2));
        assertEquals(Integer.MAX_VALUE, InputValidation.pid(Integer.MAX_VALUE));
        rejects(() -> InputValidation.pid(1));
        rejects(() -> InputValidation.pid(0));
        rejects(() -> InputValidation.pid(-1));
        rejects(() -> InputValidation.pid(Integer.MIN_VALUE));
    }

    @Test public void memoryRangesAllowBothLengthBoundaries() {
        InputValidation.memoryRange(0, 1);
        InputValidation.memoryRange(4096, 4096);
        InputValidation.memoryRange(Long.MAX_VALUE, 1);
        InputValidation.memoryRange(Long.MAX_VALUE - 4095L, 4096);
    }

    @Test public void memoryRangesRejectOverflowAndUnsupportedLengths() {
        rejects(() -> InputValidation.memoryRange(Long.MAX_VALUE, 2));
        rejects(() -> InputValidation.memoryRange(Long.MAX_VALUE - 4094L, 4096));
        rejects(() -> InputValidation.memoryRange(-1, 1));
        rejects(() -> InputValidation.memoryRange(0, 0));
        rejects(() -> InputValidation.memoryRange(0, -1));
        rejects(() -> InputValidation.memoryRange(0, 4097));
        rejects(() -> InputValidation.memoryRange(0, Integer.MAX_VALUE));
    }

    @Test public void integerValidationPreservesLimitsWithoutTruncatingDecimals() {
        assertEquals(1, InputValidation.integer(1, 1, 4096, "size"));
        assertEquals(4096, InputValidation.integer("4096", 1, 4096, "size"));
        assertEquals(Integer.MAX_VALUE,
                InputValidation.integer(Integer.MAX_VALUE, 2, Integer.MAX_VALUE, "pid"));
        for (Object value : new Object[] {
                null, "", " 1", "1.0", 1.5, 1.0, "+1", "-1", "1e3", "4097",
                "2147483648", "9999999999", "10000000000"
        }) {
            rejects(() -> InputValidation.integer(value, 1, 4096, "size"));
        }
        rejects(() -> InputValidation.integer(0, 1, 4096, "size"));
    }

    @Test public void hexAcceptsFormattedBytesAndProducesCanonicalUppercase() {
        byte[] expected = new byte[] {0, (byte) 0xff, (byte) 0xa1, 0x7c};
        byte[] actual = InputValidation.hex("00 ff \nA1\t7c\r", 4, false);
        assertArrayEquals(expected, actual);
        assertEquals("00FFA17C", InputValidation.hex(actual));
    }

    @Test public void hexRejectsHalfBytesInvalidCharactersAndExcessData() {
        for (String value : new String[] {"0", "001", "GG", "0x00", "-1", "00;11", "001122"}) {
            rejects(() -> InputValidation.hex(value, 2, false));
        }
        rejects(() -> InputValidation.hex(null, 2, false));
        rejects(() -> InputValidation.hex(" ", 2, false));
        rejects(() -> InputValidation.hex("", 2, false));
    }

    @Test public void emptyFileAndMaximumMemoryPayloadHaveDifferentValidBoundaries() {
        assertArrayEquals(new byte[0], InputValidation.hex(" \n\t", 64 * 1024, true));
        byte[] maximum = new byte[InputValidation.MAX_MEMORY_BYTES];
        maximum[maximum.length - 1] = (byte) 0xff;
        String formatted = InputValidation.hex(maximum);
        assertArrayEquals(maximum,
                InputValidation.hex(formatted, InputValidation.MAX_MEMORY_BYTES, false));
        rejects(() -> InputValidation.hex(formatted + "00", InputValidation.MAX_MEMORY_BYTES, false));
    }

    @Test public void settingNamespacesAreAnExactAllowlist() {
        assertEquals("global", InputValidation.namespace("global"));
        assertEquals("system", InputValidation.namespace("system"));
        assertEquals("secure", InputValidation.namespace("secure"));
        for (String value : new String[] {"GLOBAL", "", "global;reboot", "../secure", " secure"}) {
            rejects(() -> InputValidation.namespace(value));
        }
        rejects(() -> InputValidation.namespace(null));
    }

    @Test public void settingKeysRejectCommandSyntaxAndUnboundedNames() {
        assertEquals("user.setting-1:enabled", InputValidation.settingKey("user.setting-1:enabled"));
        String maximum = "a".repeat(128);
        assertEquals(maximum, InputValidation.settingKey(maximum));
        for (String value : new String[] {
                "", "a b", "a\nb", "a;reboot", "$(reboot)", "`reboot`", "a/b", maximum + "a",
                "--user", "-name", ".name", ":name"
        }) {
            rejects(() -> InputValidation.settingKey(value));
        }
        rejects(() -> InputValidation.settingKey(null));
    }

    @Test public void settingValuesAllowLiteralPunctuationButRejectNulAndOversize() {
        assertEquals("", InputValidation.settingValue(""));
        assertEquals("text; $(literal)", InputValidation.settingValue("text; $(literal)"));
        String maximum = "x".repeat(4096);
        assertEquals(maximum, InputValidation.settingValue(maximum));
        rejects(() -> InputValidation.settingValue(maximum + "x"));
        rejects(() -> InputValidation.settingValue("a\0b"));
        rejects(() -> InputValidation.settingValue(null));
    }

    @Test public void sha256RequiresExactlyThirtyTwoHexadecimalBytes() {
        String digest = "ABCDEF0123456789".repeat(4);
        assertEquals("abcdef0123456789".repeat(4), InputValidation.sha256(digest));
        rejects(() -> InputValidation.sha256(digest.substring(1)));
        rejects(() -> InputValidation.sha256(digest + "0"));
        rejects(() -> InputValidation.sha256("z".repeat(64)));
        rejects(() -> InputValidation.sha256(" " + digest));
        rejects(() -> InputValidation.sha256(null));
    }
}
