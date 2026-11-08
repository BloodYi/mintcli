package dev.bloodyi.mintcli.mobile.device;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/** Linux start-time token prevents a reused PID from being mistaken for a prior target. */
final class ProcessIdentity {
    private ProcessIdentity() {}

    static String read(int pid) throws IOException {
        InputValidation.pid(pid);
        try (FileInputStream input = new FileInputStream("/proc/" + pid + "/stat");
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] chunk = new byte[1024];
            int count;
            while ((count = input.read(chunk)) != -1) {
                output.write(chunk, 0, count);
                if (output.size() > 8192) throw new IOException("进程状态过长");
            }
            return parseStart(new String(output.toByteArray(), StandardCharsets.UTF_8));
        } catch (IllegalArgumentException malformed) {
            throw new IOException("无法确认目标进程身份", malformed);
        }
    }

    static String parseStart(String stat) {
        if (stat == null) throw new IllegalArgumentException("缺少进程状态");
        int open = stat.indexOf('(');
        int close = stat.lastIndexOf(')');
        if (open < 1 || close <= open) throw new IllegalArgumentException("进程状态格式无效");
        // The comm field may contain whitespace, newlines, and parentheses. Fields after its
        // final ')' start with field 3 (state), making starttime (field 22) element 19.
        String[] fields = stat.substring(close + 1).trim().split("\\s+");
        if (fields.length < 20 || !fields[19].matches("[0-9]{1,20}"))
            throw new IllegalArgumentException("进程启动标识无效");
        return fields[19];
    }

    static String expected(String token) {
        if (token == null || !token.matches("[0-9]{1,20}"))
            throw new IllegalArgumentException("缺少进程身份快照，请先读取内存");
        return token;
    }

    static void require(int pid, String expected) throws IOException {
        if (!read(pid).equals(expected))
            throw new IOException("目标进程已经退出或 PID 被重新使用；本次未继续操作，请重新选择进程");
    }
}
