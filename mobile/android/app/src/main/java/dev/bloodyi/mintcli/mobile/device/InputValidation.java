package dev.bloodyi.mintcli.mobile.device;

import java.util.Locale;
import java.util.regex.Pattern;

/** Validation independent of Android, shared by all permission backends. */
public final class InputValidation {
    public static final int MAX_MEMORY_BYTES = 4096;
    public static final int MAX_FILE_BYTES = 64 * 1024;
    private static final Pattern SETTING_KEY = Pattern.compile("[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}");

    private InputValidation() {}

    public static int pid(int value) {
        if (value <= 1) throw new IllegalArgumentException("PID 必须大于 1");
        return value;
    }

    public static int integer(Object value, int min, int max, String name) {
        String text = value == null ? "" : value.toString();
        if (!text.matches("[0-9]{1,10}"))
            throw new IllegalArgumentException(name + " 必须是整数");
        long parsed;
        try { parsed = Long.parseLong(text); }
        catch (NumberFormatException error) { throw new IllegalArgumentException(name + " 超出范围"); }
        if (parsed < min || parsed > max) throw new IllegalArgumentException(name + " 超出范围");
        return (int) parsed;
    }

    public static long address(String input) {
        if (input == null) throw new IllegalArgumentException("请输入十六进制地址");
        String text = input.trim();
        if (text.startsWith("0x") || text.startsWith("0X")) text = text.substring(2);
        if (!text.matches("[0-9a-fA-F]{1,16}"))
            throw new IllegalArgumentException("地址必须是最多 16 位的十六进制数字");
        try {
            long value = Long.parseUnsignedLong(text, 16);
            if (value < 0) throw new IllegalArgumentException("地址超出可访问的用户空间范围");
            return value;
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("地址超出范围");
        }
    }

    public static void memoryRange(long address, int count) {
        if (address < 0 || count < 1 || count > MAX_MEMORY_BYTES)
            throw new IllegalArgumentException("内存长度必须为 1–4096 字节");
        if (address > Long.MAX_VALUE - (count - 1L))
            throw new IllegalArgumentException("地址范围溢出");
    }

    public static byte[] hex(String input, int maxBytes, boolean allowEmpty) {
        if (input == null) throw new IllegalArgumentException("缺少十六进制数据");
        // Bound before allocation; human formatting is allowed, arbitrary huge input is not.
        if (input.length() > maxBytes * 8L + 1024L)
            throw new IllegalArgumentException("十六进制数据过长");
        String compact = input.replaceAll("\\s", "");
        if ((!allowEmpty && compact.isEmpty()) || (compact.length() & 1) != 0
                || compact.length() / 2 > maxBytes || !compact.matches("[0-9a-fA-F]*"))
            throw new IllegalArgumentException("请输入成对的十六进制字节，且不要超过长度上限");
        byte[] bytes = new byte[compact.length() / 2];
        for (int i = 0; i < bytes.length; i++)
            bytes[i] = (byte) Integer.parseInt(compact.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }

    public static String hex(byte[] bytes) {
        char[] chars = new char[bytes.length * 2];
        char[] digits = "0123456789ABCDEF".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            chars[i * 2] = digits[(bytes[i] >>> 4) & 15];
            chars[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(chars);
    }

    public static String namespace(String value) {
        if (!"global".equals(value) && !"system".equals(value) && !"secure".equals(value))
            throw new IllegalArgumentException("设置分类必须为 global、system 或 secure");
        return value;
    }

    public static String settingKey(String value) {
        if (value == null || !SETTING_KEY.matcher(value).matches())
            throw new IllegalArgumentException("设置名称须以字母、数字或下划线开头，后续可包含点、冒号和连字符");
        return value;
    }

    public static String settingValue(String value) {
        if (value == null || value.length() > 4096 || value.indexOf('\0') >= 0)
            throw new IllegalArgumentException("设置值不能包含空字符，且最多 4096 字符");
        return value;
    }

    public static String sha256(String value) {
        if (value == null || !value.matches("[0-9a-fA-F]{64}"))
            throw new IllegalArgumentException("缺少有效的文件读取校验值，请先读取文件");
        return value.toLowerCase(Locale.ROOT);
    }
}
