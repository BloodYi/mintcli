package dev.bloodyi.mintcli.mobile.device;

import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.concurrent.TimeUnit;

/** A fixed operation set shared by app, Shizuku, and root processes. */
public final class DeviceExecutor {
    private static final int MAX_REQUEST_CHARS = 300_000;
    private static final int MAX_MAP_BYTES = 128 * 1024;

    public synchronized String execute(String requestJson) {
        try {
            if (requestJson == null || requestJson.length() > MAX_REQUEST_CHARS)
                throw new IllegalArgumentException("操作请求过大");
            JSONObject request = new JSONObject(requestJson);
            JSONObject data;
            switch (request.getString("op")) {
                case "info": data = new JSONObject().put("uid", Process.myUid())
                        .put("pid", Process.myPid()); break;
                case "processes": data = processes(); break;
                case "maps": data = maps(request); break;
                case "memory_read": data = memoryRead(request); break;
                case "memory_write": data = memoryWrite(request); break;
                case "settings_get": data = settingRead(
                        InputValidation.namespace(request.getString("namespace")),
                        InputValidation.settingKey(request.getString("key"))); break;
                case "settings_put": data = settingWrite(request); break;
                case "file_read": data = fileRead(request); break;
                case "file_write": data = fileWrite(request); break;
                default: throw new IllegalArgumentException("不支持的手机操作");
            }
            return new JSONObject().put("ok", true).put("data", data).toString();
        } catch (Exception error) {
            return failure(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(),
                    error instanceof SettingMutationException ? ((SettingMutationException) error).details : null);
        }
    }

    static String failure(String message) {
        return failure(message, null);
    }

    private static String failure(String message, JSONObject details) {
        if (message == null) message = "操作失败";
        if (message.length() > 2048) message = message.substring(0, 2048);
        try {
            JSONObject result = new JSONObject().put("ok", false).put("error", message);
            if (details != null) result.put("data", details);
            return result.toString();
        }
        catch (JSONException impossible) { return "{\"ok\":false,\"error\":\"操作失败\"}"; }
    }

    private static int pid(JSONObject request) throws JSONException {
        return InputValidation.pid(InputValidation.integer(request.get("pid"), 2,
                Integer.MAX_VALUE, "PID"));
    }

    private static JSONObject processes() throws Exception {
        File[] entries = new File("/proc").listFiles();
        if (entries == null) throw new IOException("当前权限无法读取进程列表");
        Arrays.sort(entries, Comparator.comparing(File::getName));
        JSONArray rows = new JSONArray();
        boolean truncated = false;
        int responseCharacters = 64;
        for (File entry : entries) {
            if (!entry.getName().matches("[0-9]{1,10}")) continue;
            try {
                int id = Integer.parseInt(entry.getName());
                if (id <= 1) continue;
                StructStat stat = Os.stat(entry.getPath());
                String name;
                try {
                    byte[] bytes = readBounded(new File(entry, "cmdline"), 512, false).bytes;
                    int end = 0;
                    while (end < bytes.length && bytes[end] != 0) end++;
                    name = new String(bytes, 0, end, StandardCharsets.UTF_8);
                    if (name.isEmpty()) name = "[" + id + "]";
                } catch (IOException inaccessible) { name = "[权限限制]"; }
                if (rows.length() >= 512) { truncated = true; break; }
                JSONObject row = new JSONObject().put("pid", id).put("uid", stat.st_uid)
                        .put("name", name.length() > 200 ? name.substring(0, 200) : name);
                responseCharacters += row.toString().length() + 1;
                if (responseCharacters > 280_000) { truncated = true; break; }
                rows.put(row);
            } catch (Exception exitedOrRestricted) {
                // Processes can exit during listing; inaccessible entries grant no extra rights.
            }
        }
        return new JSONObject().put("processes", rows).put("truncated", truncated);
    }

    private static JSONObject maps(JSONObject request) throws Exception {
        int id = pid(request);
        BoundedRead result = readBounded(new File("/proc/" + id + "/maps"), MAX_MAP_BYTES, false);
        return new JSONObject().put("text", new String(result.bytes, StandardCharsets.UTF_8))
                .put("truncated", result.truncated);
    }

    private static JSONObject memoryRead(JSONObject request) throws Exception {
        int id = pid(request);
        long address = InputValidation.address(request.getString("address"));
        int size = InputValidation.integer(request.get("size"), 1,
                InputValidation.MAX_MEMORY_BYTES, "内存长度");
        InputValidation.memoryRange(address, size);
        String processStart = ProcessIdentity.read(id);
        byte[] bytes = new byte[size];
        try (RandomAccessFile memory = new RandomAccessFile("/proc/" + id + "/mem", "r")) {
            ProcessIdentity.require(id, processStart);
            memory.seek(address);
            memory.readFully(bytes);
            ProcessIdentity.require(id, processStart);
        }
        return memoryResult(id, address, bytes).put("processStart", processStart);
    }

    private static JSONObject memoryWrite(JSONObject request) throws Exception {
        int id = pid(request);
        long address = InputValidation.address(request.getString("address"));
        byte[] replacement = InputValidation.hex(request.getString("hex"),
                InputValidation.MAX_MEMORY_BYTES, false);
        byte[] expected = InputValidation.hex(request.getString("expectedHex"),
                InputValidation.MAX_MEMORY_BYTES, false);
        if (replacement.length != expected.length)
            throw new IllegalArgumentException("写入长度必须与读取快照相同，请重新读取");
        InputValidation.memoryRange(address, replacement.length);
        String processStart = ProcessIdentity.expected(request.getString("expectedProcessStart"));
        ProcessIdentity.require(id, processStart);
        byte[] current = new byte[replacement.length];
        try (RandomAccessFile memory = new RandomAccessFile("/proc/" + id + "/mem", "rw")) {
            ProcessIdentity.require(id, processStart);
            memory.seek(address);
            memory.readFully(current);
            if (!Arrays.equals(current, expected))
                throw new IOException("目标内存已经变化；本次未写入，请重新读取");
            ProcessIdentity.require(id, processStart);
            memory.seek(address);
            memory.write(replacement);
            memory.seek(address);
            memory.readFully(current);
            if (!Arrays.equals(current, replacement))
                throw new IOException("写入后的内存已发生变化，请重新读取实际值");
            if (!ProcessIdentity.read(id).equals(processStart))
                throw new IOException("写入后目标进程已经退出或 PID 被重用，请重新读取当前状态");
        }
        return memoryResult(id, address, current).put("processStart", processStart);
    }

    private static JSONObject memoryResult(int id, long address, byte[] bytes) throws JSONException {
        return new JSONObject().put("pid", id).put("address", "0x" + Long.toHexString(address))
                .put("size", bytes.length).put("hex", InputValidation.hex(bytes));
    }

    private static JSONObject settingRead(String namespace, String key) throws Exception {
        CommandResult listing = settings("list", namespace);
        boolean exists = false;
        for (String line : listing.output.split("\n", -1)) {
            if (line.startsWith(key + "=")) { exists = true; break; }
        }
        if (listing.truncated)
            throw new IOException("系统设置列表过大，无法可靠判断设置是否存在");
        if (!exists) return new JSONObject().put("exists", false).put("value", "");
        CommandResult result = settings("get", namespace, key);
        if (result.truncated) throw new IOException("设置值过长");
        String value = result.output;
        if (value.endsWith("\n")) value = value.substring(0, value.length() - 1);
        if (value.length() > 4096) throw new IOException("设置值超过 4096 字符编辑上限");
        return new JSONObject().put("exists", true).put("value", value);
    }

    private static JSONObject settingWrite(JSONObject request) throws Exception {
        String namespace = InputValidation.namespace(request.getString("namespace"));
        String key = InputValidation.settingKey(request.getString("key"));
        if (!(request.get("expectedExists") instanceof Boolean))
            throw new IllegalArgumentException("请先读取系统设置，再执行写入");
        boolean expectedExists = request.getBoolean("expectedExists");
        String expectedValue = expectedExists ? request.getString("expectedValue") : "";
        boolean delete = request.optBoolean("delete", false);
        String value = delete ? "" : InputValidation.settingValue(request.getString("value"));
        JSONObject before = settingRead(namespace, key);
        if (before.getBoolean("exists") != expectedExists
                || (expectedExists && !before.getString("value").equals(expectedValue)))
            throw new IOException("系统设置已变化；本次未修改，请重新读取");
        JSONObject after = null;
        try {
            if (delete) settings("delete", namespace, key);
            else settings("put", namespace, key, value);
            after = settingRead(namespace, key);
            if (after.getBoolean("exists") != !delete
                    || (!delete && !after.getString("value").equals(value)))
                throw new IOException("系统没有保留请求的设置值，请重新读取当前状态");
            return new JSONObject().put("before", before).put("after", after);
        } catch (Exception uncertain) {
            JSONObject details = new JSONObject().put("before", before)
                    .put("mutationAttempted", true).put("outcomeUnknown", true)
                    .put("namespace", namespace).put("key", key);
            if (after != null) details.put("after", after);
            throw new SettingMutationException("设置操作结果未确认，请读取当前状态后按需恢复。"
                    + (uncertain.getMessage() == null ? "" : uncertain.getMessage()), details);
        }
    }

    private static CommandResult settings(String... arguments) throws Exception {
        String[] command = new String[arguments.length + 1];
        command[0] = "/system/bin/settings";
        System.arraycopy(arguments, 0, command, 1, arguments.length);
        java.lang.Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        boolean[] truncated = {false};
        IOException[] readError = {null};
        Thread reader = new Thread(() -> {
            try (java.io.InputStream input = process.getInputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    int retain = Math.min(count, 256 * 1024 - captured.size());
                    if (retain > 0) captured.write(buffer, 0, retain);
                    if (retain < count) truncated[0] = true;
                }
            } catch (IOException error) { readError[0] = error; }
        }, "mintcli-settings-output");
        reader.setDaemon(true);
        reader.start();
        boolean finished;
        try { finished = process.waitFor(8, TimeUnit.SECONDS); }
        catch (InterruptedException cancelled) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IOException("设置操作已取消");
        }
        if (!finished) {
            process.destroyForcibly();
            reader.join(1000);
            throw new IOException("系统设置命令超时");
        }
        reader.join(1000);
        if (reader.isAlive()) throw new IOException("系统设置输出未完成");
        if (readError[0] != null) throw readError[0];
        String output = captured.toString(StandardCharsets.UTF_8.name());
        if (process.exitValue() != 0) {
            String message = output.trim();
            if (message.length() > 500) message = message.substring(0, 500);
            throw new IOException(message.isEmpty() ? "系统设置操作被拒绝" : message);
        }
        return new CommandResult(output, truncated[0]);
    }

    private static JSONObject fileRead(JSONObject request) throws Exception {
        File file = regularFile(request.getString("path"));
        byte[] bytes = readBounded(file, InputValidation.MAX_FILE_BYTES, true).bytes;
        String text = "";
        boolean utf8 = true;
        try {
            text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            // Binary control bytes expand substantially in JSON/Binder; render those files as hex.
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c < 32 && c != '\n' && c != '\r' && c != '\t') { utf8 = false; text = ""; break; }
            }
        } catch (CharacterCodingException binary) { utf8 = false; }
        return new JSONObject().put("path", file.getPath()).put("text", text).put("utf8", utf8)
                .put("hex", InputValidation.hex(bytes)).put("sha256", digest(bytes)).put("size", bytes.length);
    }

    private static JSONObject fileWrite(JSONObject request) throws Exception {
        File file = regularFile(request.getString("path"));
        byte[] replacement = InputValidation.hex(request.getString("hex"), InputValidation.MAX_FILE_BYTES, true);
        String expected = InputValidation.sha256(request.getString("expectedSha256"));
        byte[] original = readBounded(file, InputValidation.MAX_FILE_BYTES, true).bytes;
        if (!digest(original).equals(expected)) throw new IOException("文件已变化；本次未写入，请重新读取");
        StructStat attributes = Os.stat(file.getPath());
        if (attributes.st_nlink != 1)
            throw new IOException("此文件有多个硬链接，无法通过原子替换保留全部链接");
        File parent = file.getParentFile();
        File backup = null;
        File staged = null;
        boolean replaced = false;
        try {
            staged = File.createTempFile(".mintcli-edit-", ".tmp", parent);
            writeSynced(staged, replacement);
            preserveAttributes(file, staged, attributes);
            backup = File.createTempFile(".mintcli-backup-", ".bak", parent);
            writeSynced(backup, original);
            preserveAttributes(file, backup, attributes);
            if (!digest(readBounded(file, InputValidation.MAX_FILE_BYTES, true).bytes).equals(expected))
                throw new IOException("文件在准备写入时已变化；本次未替换，请重新读取");
            Os.rename(staged.getPath(), file.getPath());
            replaced = true;
            return new JSONObject().put("path", file.getPath()).put("sha256", digest(replacement))
                    .put("size", replacement.length).put("backupPath", backup.getPath());
        } finally {
            if (staged != null && staged.exists()) staged.delete();
            if (!replaced && backup != null) backup.delete();
        }
    }

    private static void preserveAttributes(File original, File copy, StructStat attributes) throws Exception {
        StructStat current = Os.stat(copy.getPath());
        if (current.st_uid != attributes.st_uid || current.st_gid != attributes.st_gid)
            Os.chown(copy.getPath(), attributes.st_uid, attributes.st_gid);
        Os.chmod(copy.getPath(), attributes.st_mode & 07777);
        try {
            byte[] oldContext = Os.getxattr(original.getPath(), "security.selinux");
            byte[] newContext = Os.getxattr(copy.getPath(), "security.selinux");
            if (!Arrays.equals(oldContext, newContext))
                Os.setxattr(copy.getPath(), "security.selinux", oldContext, 0);
        } catch (ErrnoException unsupported) {
            if (unsupported.errno != OsConstants.ENODATA && unsupported.errno != OsConstants.EOPNOTSUPP)
                throw unsupported;
        }
    }

    private static File regularFile(String path) throws Exception {
        if (path == null || path.indexOf('\0') >= 0 || !new File(path).isAbsolute())
            throw new IllegalArgumentException("请输入完整文件路径");
        File file = new File(path).getCanonicalFile();
        String actual = file.getPath();
        if (actual.equals("/proc") || actual.startsWith("/proc/") || actual.equals("/sys")
                || actual.startsWith("/sys/") || actual.equals("/dev") || actual.startsWith("/dev/"))
            throw new IOException("此入口只编辑普通文件；进程内存请使用内存工具");
        StructStat stat = Os.stat(actual);
        if (!OsConstants.S_ISREG(stat.st_mode)) throw new IOException("路径不是普通文件");
        if (stat.st_size > InputValidation.MAX_FILE_BYTES) throw new IOException("文件超过 64 KiB 编辑上限");
        return file;
    }

    private static String digest(byte[] bytes) throws Exception {
        return InputValidation.hex(MessageDigest.getInstance("SHA-256").digest(bytes)).toLowerCase(java.util.Locale.ROOT);
    }

    private static void writeSynced(File file, byte[] bytes) throws IOException {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(bytes);
            output.getFD().sync();
        }
    }

    private static BoundedRead readBounded(File file, int maximum, boolean requireWhole) throws IOException {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer, 0, Math.min(buffer.length, maximum + 1 - output.size()))) != -1) {
                output.write(buffer, 0, count);
                if (output.size() > maximum) break;
            }
            boolean truncated = output.size() > maximum;
            if (truncated && requireWhole) throw new IOException("文件超过 " + maximum + " 字节读取上限");
            byte[] bytes = output.toByteArray();
            if (truncated) bytes = Arrays.copyOf(bytes, maximum);
            return new BoundedRead(bytes, truncated);
        }
    }

    private static final class BoundedRead {
        final byte[] bytes;
        final boolean truncated;
        BoundedRead(byte[] bytes, boolean truncated) { this.bytes = bytes; this.truncated = truncated; }
    }

    private static final class CommandResult {
        final String output;
        final boolean truncated;
        CommandResult(String output, boolean truncated) { this.output = output; this.truncated = truncated; }
    }

    private static final class SettingMutationException extends IOException {
        final JSONObject details;
        SettingMutationException(String message, JSONObject details) {
            super(message);
            this.details = details;
        }
    }
}
