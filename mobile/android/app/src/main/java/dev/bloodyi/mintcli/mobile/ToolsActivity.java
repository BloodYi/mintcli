package dev.bloodyi.mintcli.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import dev.bloodyi.mintcli.mobile.device.DeviceBridge;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Local phone tools. This activity has no network endpoint or JavaScript bridge. */
public final class ToolsActivity extends Activity {
    private static final int PICK_FILE = 41;
    private static final int EXPORT_BACKUP = 42;
    private static final int MAX_FILE_BYTES = 64 * 1024;
    private static final int BG = Color.rgb(11, 20, 18);
    private static final int PANEL = Color.rgb(21, 35, 30);
    private static final int INPUT = Color.rgb(13, 25, 21);
    private static final int TEXT = Color.rgb(233, 245, 238);
    private static final int MUTED = Color.rgb(157, 181, 166);
    private static final int MINT = Color.rgb(144, 229, 178);

    private final ExecutorService fileIo = Executors.newSingleThreadExecutor();
    private final List<Button> actionButtons = new ArrayList<>();
    private final List<View> inputViews = new ArrayList<>();
    private final List<LinearLayout> pages = new ArrayList<>();
    private final List<Button> tabs = new ArrayList<>();
    private DeviceBridge bridge;
    private TextView accessStatus;
    private TextView operationStatus;
    private TextView fileDetails;
    private EditText filePath;
    private EditText fileEditor;
    private Spinner fileFormat;
    private Button fileSave;
    private Button exportBackup;
    private FileSnapshot fileSnapshot;
    private File lastBackup;
    private int editorFormat;
    private boolean updatingFile;
    private EditText memoryPid;
    private EditText memoryAddress;
    private EditText memorySize;
    private EditText memoryEditor;
    private TextView memoryDetails;
    private Button memoryWrite;
    private MemorySnapshot memorySnapshot;
    private Spinner settingsNamespace;
    private EditText settingsKey;
    private EditText settingsValue;
    private TextView settingsDetails;
    private Button settingsWrite;
    private Button settingsRestore;
    private SettingSnapshot settingSnapshot;
    private SettingUndo settingUndo;
    private long accessEpoch;
    private long fileGeneration;
    private boolean busy;
    private boolean closed;
    private String lastAccessStatus = "";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        LinearLayout root = column();
        root.setBackgroundColor(BG);
        root.setPadding(dp(18), dp(12), dp(18), dp(12));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(dp(18) + insets.getSystemWindowInsetLeft(),
                    dp(12) + insets.getSystemWindowInsetTop(),
                    dp(18) + insets.getSystemWindowInsetRight(),
                    dp(12) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        LinearLayout heading = row();
        Button back = button("‹ 工作区", () -> finish());
        heading.addView(back, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView title = text("手机工具", 24, TEXT);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setPadding(dp(15), dp(10), 0, 0);
        heading.addView(title);
        root.addView(heading);

        LinearLayout permissionCard = card();
        permissionCard.addView(text("访问权限", 16, TEXT));
        accessStatus = text("普通应用权限", 13, MINT);
        permissionCard.addView(accessStatus);
        LinearLayout accessButtons = row();
        addWeighted(accessButtons, action("普通权限", () -> switchAccess(0)));
        addWeighted(accessButtons, action("Shizuku", () -> switchAccess(1)));
        addWeighted(accessButtons, action("Root", () -> switchAccess(2)));
        permissionCard.addView(accessButtons);
        permissionCard.addView(text("仅在点击后申请授权；功能按实际取得的权限运行。", 12, MUTED));
        root.addView(permissionCard);

        LinearLayout tabRow = row();
        String[] names = {"文件", "运行内存", "系统设置"};
        for (int i = 0; i < names.length; i++) {
            final int index = i;
            Button tab = button(names[i], () -> showPage(index));
            tabs.add(tab);
            addWeighted(tabRow, tab);
        }
        root.addView(tabRow);
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout body = column();
        body.setPadding(0, dp(8), 0, dp(20));
        body.addView(buildFiles());
        body.addView(buildMemory());
        body.addView(buildSettings());
        scroll.addView(body);
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        operationStatus = text("准备就绪", 12, MUTED);
        operationStatus.setPadding(0, dp(8), 0, 0);
        operationStatus.setTextIsSelectable(true);
        root.addView(operationStatus);
        setContentView(root);
        root.requestApplyInsets();
        showPage(0);
        String backupName = getSharedPreferences("phone-tools", MODE_PRIVATE)
                .getString("latestBackup", "");
        if (!backupName.isEmpty() && !backupName.contains("/") && !backupName.contains("\\")) {
            File saved = new File(new File(getFilesDir(), "file-backups"), backupName);
            if (saved.isFile()) lastBackup = saved;
        }
        bridge = new DeviceBridge(this, status -> {
            if (closed) return;
            if (!status.equals(lastAccessStatus)) {
                lastAccessStatus = status;
                invalidateAccessSnapshots();
            }
            accessStatus.setText(status);
        });
        accessStatus.setText(bridge.getStatusText());
        refreshActions();
    }

    private LinearLayout buildFiles() {
        LinearLayout page = card();
        pages.add(page);
        page.addView(text("本机文件", 20, TEXT));
        page.addView(text("选择文件，或通过当前权限读取绝对路径。支持 64 KiB 以内的文本和二进制文件。", 13, MUTED));
        page.addView(action("选择手机中的文件", this::chooseFile));
        filePath = field("绝对路径，例如 /sdcard/Download/example.txt", false, false);
        page.addView(filePath);
        page.addView(action("读取路径", this::readPath));
        fileDetails = text("尚未打开文件", 12, MUTED);
        fileDetails.setTextIsSelectable(true);
        page.addView(fileDetails);
        fileFormat = spinner(new String[]{"UTF-8 文本", "十六进制"});
        fileFormat.setOnItemSelectedListener(new Selection() {
            @Override public void selected(int position) { changeFileFormat(position); }
        });
        page.addView(fileFormat);
        fileEditor = field("文件内容", true, true);
        fileEditor.setMinLines(9);
        page.addView(fileEditor);
        fileSave = action("备份并保存文件", this::saveFile);
        exportBackup = action("导出上次文件备份", this::chooseBackupExport);
        page.addView(fileSave);
        page.addView(exportBackup);
        page.addView(text("保存前检查文件是否被其他应用更改。原文件会先保留一份备份。", 12, MUTED));
        watch(filePath, () -> {
            if (!updatingFile) {
                fileSnapshot = null;
                fileGeneration++;
                fileDetails.setText("路径已变化，请重新读取。");
                refreshActions();
            }
        });
        return page;
    }

    private LinearLayout buildMemory() {
        LinearLayout page = card();
        pages.add(page);
        page.addView(text("运行内存", 20, TEXT));
        page.addView(text("先读取地址，再修改字节。访问其他应用通常需要 Root；系统策略也可能限制操作。", 13, MUTED));
        page.addView(action("查看可访问进程", this::chooseProcess));
        memoryPid = field("进程 PID", false, true);
        memoryPid.setInputType(InputType.TYPE_CLASS_NUMBER);
        page.addView(memoryPid);
        page.addView(action("查看内存映射", this::readMaps));
        memoryAddress = field("十六进制地址，例如 0x7a12340000", false, true);
        page.addView(memoryAddress);
        memorySize = field("读取字节数（1–4096）", false, true);
        memorySize.setInputType(InputType.TYPE_CLASS_NUMBER);
        memorySize.setText("32");
        page.addView(memorySize);
        page.addView(action("读取内存", this::readMemory));
        memoryDetails = text("尚未读取内存", 12, MUTED);
        memoryDetails.setTextIsSelectable(true);
        page.addView(memoryDetails);
        memoryEditor = field("十六进制字节，例如 00 FF 2A", true, true);
        memoryEditor.setMinLines(5);
        page.addView(memoryEditor);
        memoryWrite = action("写入修改后的字节", this::writeMemory);
        page.addView(memoryWrite);
        page.addView(text("地址、进程、长度或权限改变后需要重新读取。原字节发生变化时会拒绝覆盖。", 12, MUTED));
        Runnable changed = () -> {
            memorySnapshot = null;
            refreshActions();
        };
        watch(memoryPid, changed);
        watch(memoryAddress, changed);
        watch(memorySize, changed);
        return page;
    }

    private LinearLayout buildSettings() {
        LinearLayout page = card();
        pages.add(page);
        page.addView(text("系统设置", 20, TEXT));
        page.addView(text("读取具体设置项后编辑其值。写入权限取决于当前授权及 Android 版本。", 13, MUTED));
        settingsNamespace = spinner(new String[]{"global", "system", "secure"});
        page.addView(settingsNamespace);
        settingsKey = field("设置名称，例如 screen_brightness", false, true);
        page.addView(settingsKey);
        page.addView(action("读取当前值", this::readSetting));
        settingsDetails = text("尚未读取设置", 12, MUTED);
        settingsDetails.setTextIsSelectable(true);
        page.addView(settingsDetails);
        settingsValue = field("设置值", true, true);
        settingsValue.setMinLines(3);
        page.addView(settingsValue);
        settingsWrite = action("保存设置", this::writeSetting);
        settingsRestore = action("恢复上一次修改前的值", this::restoreSetting);
        page.addView(settingsWrite);
        page.addView(settingsRestore);
        watch(settingsKey, this::clearSettingSnapshots);
        settingsNamespace.setOnItemSelectedListener(new Selection() {
            @Override public void selected(int position) { clearSettingSnapshots(); }
        });
        return page;
    }

    private void switchAccess(int mode) {
        if (bridge == null || busy) return;
        invalidateAccessSnapshots();
        if (mode == 1) bridge.requestShizuku();
        else if (mode == 2) bridge.requestRoot();
        else bridge.useAppPermissions();
        accessStatus.setText(bridge.getStatusText());
    }

    private void invalidateAccessSnapshots() {
        SettingUndo recovery = settingUndo;
        accessEpoch++;
        fileGeneration++;
        fileSnapshot = null;
        memorySnapshot = null;
        settingSnapshot = null;
        settingUndo = null;
        if (recovery != null && settingsNamespace != null && settingsKey != null
                && recovery.before.namespace.equals(namespace()) && recovery.before.key.equals(key())) {
            // Preserve the recovery value across a disconnected privileged service, but require a fresh read.
            String identity = settingIdentity();
            SettingSnapshot original = new SettingSnapshot(identity, recovery.before.namespace,
                    recovery.before.key, recovery.before.exists, recovery.before.value);
            SettingSnapshot previouslyExpected = new SettingSnapshot(identity, recovery.after.namespace,
                    recovery.after.key, recovery.after.exists, recovery.after.value);
            settingUndo = new SettingUndo(original, previouslyExpected, true);
            if (settingsDetails != null) settingsDetails.setText(original.namespace + "/" + original.key
                    + " · 已保留修改前原值\n权限已变化，请重新读取当前值后恢复。");
        }
        refreshActions();
    }

    private void clearSettingSnapshots() {
        settingSnapshot = null;
        settingUndo = null;
        refreshActions();
    }

    private void chooseFile() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, PICK_FILE);
    }

    private void chooseBackupExport() {
        if (lastBackup == null) return;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/octet-stream");
        intent.putExtra(Intent.EXTRA_TITLE, "mintcli-file-backup.bin");
        startActivityForResult(intent, EXPORT_BACKUP);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (!"content".equalsIgnoreCase(uri.getScheme()) || uri.getAuthority() == null
                || uri.getAuthority().contains(getPackageName())) {
            message("请选择系统文件选择器中可访问的文件。");
            return;
        }
        if (requestCode == PICK_FILE) {
            try {
                boolean canRead = (data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION) != 0;
                boolean canWrite = (data.getFlags() & Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != 0;
                if (canRead && canWrite) {
                    getContentResolver().takePersistableUriPermission(uri,
                            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                } else if (canRead) {
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } else if (canWrite) {
                    getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                }
            } catch (SecurityException ignored) { /* Some providers grant this session only. */ }
            final long generation = ++fileGeneration;
            final long epoch = accessEpoch;
            fileSnapshot = null;
            setBusy(true, "正在读取文件…");
            fileIo.execute(() -> {
                try {
                    byte[] bytes = readUri(uri);
                    String name = displayName(uri);
                    post(() -> {
                        if (generation == fileGeneration && epoch == accessEpoch)
                            displayFile(new FileSnapshot(uri, null, name, bytes, epoch));
                        setBusy(false, "文件读取完成");
                    });
                } catch (Exception error) { fileError(error); }
            });
        } else if (requestCode == EXPORT_BACKUP && lastBackup != null) {
            File backup = lastBackup;
            setBusy(true, "正在导出备份…");
            fileIo.execute(() -> {
                try (InputStream in = new java.io.FileInputStream(backup);
                     OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("无法打开备份导出位置");
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                    out.flush();
                    post(() -> setBusy(false, "备份已导出"));
                } catch (Exception error) { fileError(error); }
            });
        }
    }

    private void readPath() {
        String path = filePath.getText().toString().trim();
        if (path.isEmpty()) { message("请填写绝对路径"); return; }
        final long generation = ++fileGeneration;
        final long epoch = accessEpoch;
        fileSnapshot = null;
        execute(json("op", "file_read", "path", path), "正在读取路径…", data -> {
            if (generation != fileGeneration || epoch != accessEpoch) return;
            byte[] bytes = decodeHex(data.getString("hex"));
            String canonicalPath = data.getString("path");
            displayFile(new FileSnapshot(null, canonicalPath, canonicalPath, bytes, epoch));
        });
    }

    private void displayFile(FileSnapshot snapshot) {
        fileSnapshot = snapshot;
        updatingFile = true;
        filePath.setText(snapshot.path == null ? "" : snapshot.path);
        boolean utf8 = isUtf8(snapshot.bytes);
        editorFormat = utf8 ? 0 : 1;
        fileFormat.setSelection(editorFormat);
        fileEditor.setText(editorFormat == 0 ? new String(snapshot.bytes, StandardCharsets.UTF_8)
                : spacedHex(snapshot.bytes));
        updatingFile = false;
        fileDetails.setText(snapshot.name + "\n" + snapshot.bytes.length + " 字节 · "
                + (utf8 ? "UTF-8" : "二进制") + " · 已读取");
        refreshActions();
    }

    private void changeFileFormat(int selected) {
        if (updatingFile || fileEditor == null || selected == editorFormat) return;
        if (fileSnapshot == null) { editorFormat = selected; return; }
        try {
            byte[] bytes = editedFileBytes();
            if (selected == 0 && !isUtf8(bytes)) throw new IOException("此内容不是有效 UTF-8，请使用十六进制编辑。");
            editorFormat = selected;
            fileEditor.setText(selected == 0 ? new String(bytes, StandardCharsets.UTF_8) : spacedHex(bytes));
        } catch (Exception error) {
            updatingFile = true;
            fileFormat.setSelection(editorFormat);
            updatingFile = false;
            message(errorText(error));
        }
    }

    private byte[] editedFileBytes() throws IOException {
        byte[] bytes = editorFormat == 0
                ? fileEditor.getText().toString().getBytes(StandardCharsets.UTF_8)
                : decodeHex(fileEditor.getText().toString());
        if (bytes.length > MAX_FILE_BYTES) throw new IOException("文件超过 64 KiB 编辑上限。");
        return bytes;
    }

    private void saveFile() {
        FileSnapshot snapshot = fileSnapshot;
        if (snapshot == null || snapshot.epoch != accessEpoch) { message("请先重新读取文件。"); return; }
        final byte[] bytes;
        try { bytes = editedFileBytes(); }
        catch (Exception error) { message(errorText(error)); return; }
        final long generation = fileGeneration;
        if (snapshot.uri == null) {
            fileSnapshot = null;
            execute(json("op", "file_write", "path", snapshot.path, "hex", compactHex(bytes),
                    "expectedSha256", snapshot.sha256), "正在备份并保存文件…", data -> {
                if (generation == fileGeneration && snapshot.epoch == accessEpoch) {
                    fileSnapshot = new FileSnapshot(null, data.getString("path"), snapshot.name,
                            bytes, snapshot.epoch);
                    fileDetails.setText(snapshot.name + "\n" + bytes.length + " 字节 · 已保存\n备份："
                            + data.optString("backupPath", "已创建"));
                }
            });
            return;
        }
        setBusy(true, "正在检查、备份并保存文件…");
        fileIo.execute(() -> {
            File backup = null;
            try {
                byte[] current = readUri(snapshot.uri);
                if (!sha256(current).equals(snapshot.sha256))
                    throw new IOException("文件已被其他应用修改，请重新读取后再保存。");
                backup = backup(current);
                try {
                    writeUri(snapshot.uri, bytes);
                    if (!Arrays.equals(readUri(snapshot.uri), bytes))
                        throw new IOException("保存后的内容校验失败");
                } catch (Exception failure) {
                    // Another writer may have changed the document after our write; never overwrite it again.
                    throw new IOException("保存未完成，文件状态可能已变化。原文件备份已保留，请重新读取；需要时可导出备份。\n"
                            + errorText(failure));
                }
                File savedBackup = backup;
                post(() -> {
                    lastBackup = savedBackup;
                    if (generation == fileGeneration && snapshot.epoch == accessEpoch) {
                        fileSnapshot = new FileSnapshot(snapshot.uri, null, snapshot.name, bytes, snapshot.epoch);
                        fileDetails.setText(snapshot.name + "\n" + bytes.length + " 字节 · 已保存并保留原文件备份");
                    }
                    setBusy(false, "保存完成，可导出原文件备份");
                });
            } catch (Exception error) {
                File savedBackup = backup;
                post(() -> {
                    if (savedBackup != null) lastBackup = savedBackup;
                    fileSnapshot = null;
                    setBusy(false, errorText(error));
                    showError(errorText(error));
                });
            }
        });
    }

    private void chooseProcess() {
        execute(json("op", "processes"), "正在读取进程…", data -> {
            JSONArray processes = data.getJSONArray("processes");
            if (processes.length() == 0) { message("当前权限下没有可显示的进程。"); return; }
            String[] entries = new String[processes.length()];
            int[] pids = new int[processes.length()];
            for (int i = 0; i < processes.length(); i++) {
                JSONObject process = processes.getJSONObject(i);
                pids[i] = process.getInt("pid");
                entries[i] = pids[i] + " · " + process.optString("name", "未知进程")
                        + "\nUID " + process.optInt("uid", -1);
            }
            new AlertDialog.Builder(this).setTitle("选择进程")
                    .setItems(entries, (dialog, which) -> memoryPid.setText(String.valueOf(pids[which])))
                    .setNegativeButton("关闭", null).show();
        });
    }

    private int selectedPid() throws IOException {
        try {
            int pid = Integer.parseInt(memoryPid.getText().toString().trim());
            if (pid <= 1) throw new NumberFormatException();
            return pid;
        } catch (NumberFormatException error) { throw new IOException("请输入大于 1 的有效 PID。"); }
    }

    private String memoryIdentity() {
        return accessEpoch + "|" + memoryPid.getText().toString().trim() + "|"
                + memoryAddress.getText().toString().trim() + "|" + memorySize.getText().toString().trim();
    }

    private void readMaps() {
        try {
            final long epoch = accessEpoch;
            int pid = selectedPid();
            String selected = memoryPid.getText().toString().trim();
            execute(json("op", "maps", "pid", pid), "正在读取内存映射…", data -> {
                if (epoch == accessEpoch && selected.equals(memoryPid.getText().toString().trim()))
                    showText("PID " + pid + " 内存映射", data.getString("text"));
            });
        } catch (Exception error) { message(errorText(error)); }
    }

    private void readMemory() {
        try {
            int pid = selectedPid();
            String address = memoryAddress.getText().toString().trim();
            int size = Integer.parseInt(memorySize.getText().toString().trim());
            if (address.isEmpty() || size < 1 || size > 4096) throw new IOException("请填写地址及 1–4096 字节的长度。");
            String identity = memoryIdentity();
            memorySnapshot = null;
            execute(json("op", "memory_read", "pid", pid, "address", address, "size", size),
                    "正在读取内存…", data -> {
                        if (!identity.equals(memoryIdentity())) return;
                        byte[] bytes = decodeHex(data.getString("hex"));
                        memorySnapshot = new MemorySnapshot(identity, pid, address, compactHex(bytes),
                                data.getString("processStart"));
                        memoryEditor.setText(spacedHex(bytes));
                        memoryDetails.setText("PID " + pid + " · " + data.optString("address", address)
                                + " · " + bytes.length + " 字节 · 已读取");
                    });
        } catch (NumberFormatException error) { message("请输入有效的读取字节数。"); }
        catch (Exception error) { message(errorText(error)); }
    }

    private void writeMemory() {
        MemorySnapshot snapshot = memorySnapshot;
        if (snapshot == null || !snapshot.identity.equals(memoryIdentity())) { message("请先读取当前地址。"); return; }
        try {
            byte[] bytes = decodeHex(memoryEditor.getText().toString());
            String hex = compactHex(bytes);
            if (hex.length() != snapshot.hex.length()) throw new IOException("写入长度必须与读取长度相同。");
            String submitted = memoryEditor.getText().toString();
            memorySnapshot = null;
            execute(json("op", "memory_write", "pid", snapshot.pid, "address", snapshot.address,
                    "hex", hex, "expectedHex", snapshot.hex, "expectedProcessStart", snapshot.processStart),
                    "正在比对并写入内存…", data -> {
                if (snapshot.identity.equals(memoryIdentity()) && submitted.equals(memoryEditor.getText().toString())) {
                    String savedHex = compactHex(decodeHex(data.getString("hex")));
                    memorySnapshot = new MemorySnapshot(snapshot.identity, snapshot.pid, snapshot.address, savedHex,
                            data.getString("processStart"));
                    memoryDetails.setText("PID " + snapshot.pid + " · " + snapshot.address + " · 已写入并校验");
                }
            });
        } catch (Exception error) { message(errorText(error)); }
    }

    private String namespace() { return String.valueOf(settingsNamespace.getSelectedItem()); }
    private String key() { return settingsKey.getText().toString().trim(); }
    private String settingIdentity() { return accessEpoch + "|" + namespace() + "|" + key(); }

    private void readSetting() {
        if (key().isEmpty()) { message("请填写设置名称。"); return; }
        String identity = settingIdentity();
        String space = namespace();
        String name = key();
        settingSnapshot = null;
        execute(json("op", "settings_get", "namespace", space, "key", name), "正在读取设置…", data -> {
            if (!identity.equals(settingIdentity())) return;
            settingSnapshot = new SettingSnapshot(identity, space, name,
                    data.getBoolean("exists"), data.optString("value", ""));
            if (settingUndo != null && settingUndo.before.identity.equals(identity))
                settingUndo = new SettingUndo(settingUndo.before, settingSnapshot, false);
            settingsValue.setText(settingSnapshot.value);
            settingsDetails.setText(space + "/" + name + (settingSnapshot.exists ? " · 已读取" : " · 当前不存在")
                    + (settingUndo == null ? "" : "\n已保留修改前的原值，可按需恢复。"));
        });
    }

    private void writeSetting() {
        SettingSnapshot snapshot = settingSnapshot;
        if (snapshot == null || !snapshot.identity.equals(settingIdentity())) { message("请先读取当前设置。"); return; }
        String value = settingsValue.getText().toString();
        settingSnapshot = null;
        settingUndo = new SettingUndo(snapshot,
                new SettingSnapshot(snapshot.identity, snapshot.namespace, snapshot.key, true, value), true);
        settingsDetails.setText(snapshot.namespace + "/" + snapshot.key
                + " · 已保留原值\n若保存未完成，请重新读取当前值后恢复。");
        execute(json("op", "settings_put", "namespace", snapshot.namespace, "key", snapshot.key,
                "value", value, "expectedExists", snapshot.exists, "expectedValue", snapshot.value),
                "正在比对并保存设置…", data -> {
                    if (!snapshot.identity.equals(settingIdentity())) return;
                    JSONObject after = data.getJSONObject("after");
                    SettingSnapshot saved = new SettingSnapshot(snapshot.identity, snapshot.namespace, snapshot.key,
                            after.getBoolean("exists"), after.optString("value", ""));
                    settingSnapshot = saved;
                    settingUndo = new SettingUndo(snapshot, saved, false);
                    settingsDetails.setText(snapshot.namespace + "/" + snapshot.key + " · 已保存，可恢复原值");
                });
    }

    private void restoreSetting() {
        SettingUndo undo = settingUndo;
        if (undo == null || undo.requiresRead || settingSnapshot == null
                || !undo.after.identity.equals(settingIdentity())) {
            message("请先读取当前设置，再恢复保留的原值。"); return;
        }
        settingSnapshot = null;
        settingUndo = new SettingUndo(undo.before, undo.after, true);
        settingsDetails.setText(undo.before.namespace + "/" + undo.before.key
                + " · 正在恢复\n若操作未完成，请重新读取当前值后重试。");
        execute(json("op", "settings_put", "namespace", undo.before.namespace, "key", undo.before.key,
                "value", undo.before.value, "delete", !undo.before.exists,
                "expectedExists", undo.after.exists, "expectedValue", undo.after.value),
                "正在恢复原设置…", data -> {
                    if (!undo.before.identity.equals(settingIdentity())) return;
                    JSONObject after = data.getJSONObject("after");
                    settingSnapshot = new SettingSnapshot(undo.before.identity, undo.before.namespace, undo.before.key,
                            after.getBoolean("exists"), after.optString("value", ""));
                    settingUndo = null;
                    settingsValue.setText(settingSnapshot.value);
                    settingsDetails.setText(undo.before.namespace + "/" + undo.before.key
                            + (settingSnapshot.exists ? " · 已恢复原值" : " · 已恢复为不存在"));
                });
    }

    private interface DataCallback { void onData(JSONObject data) throws Exception; }

    private void execute(JSONObject request, String status, DataCallback callback) {
        if (bridge == null || closed || busy) return;
        final long epoch = accessEpoch;
        setBusy(true, status);
        bridge.execute(request, response -> {
            if (closed) return;
            if (epoch != accessEpoch) { setBusy(false, "权限已变化，请重新读取。"); return; }
            try {
                if (!response.optBoolean("ok")) throw new IOException(response.optString("error", "操作失败"));
                callback.onData(response.getJSONObject("data"));
                setBusy(false, "操作完成");
            } catch (Exception error) {
                setBusy(false, errorText(error));
                showError(errorText(error));
            }
        });
    }

    private byte[] readUri(Uri uri) throws IOException {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("无法打开此文件。");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() + count > MAX_FILE_BYTES) throw new IOException("文件超过 64 KiB 编辑上限。");
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    private void writeUri(Uri uri, byte[] bytes) throws IOException {
        try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException("文件提供方没有授予写入权限。");
            out.write(bytes);
            out.flush();
        }
    }

    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) { /* The URI remains usable without a name. */ }
        return "已选择的手机文件";
    }

    private File backup(byte[] bytes) throws IOException {
        File directory = new File(getFilesDir(), "file-backups");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法创建备份目录。");
        File file = File.createTempFile("original-", ".bin", directory);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
            out.getFD().sync();
        }
        getSharedPreferences("phone-tools", MODE_PRIVATE).edit()
                .putString("latestBackup", file.getName()).apply();
        return file;
    }

    private void fileError(Exception error) {
        post(() -> { setBusy(false, errorText(error)); showError(errorText(error)); });
    }

    private void post(Runnable runnable) { runOnUiThread(() -> { if (!closed && !isFinishing()) runnable.run(); }); }

    private void setBusy(boolean value, String status) {
        busy = value;
        if (operationStatus != null) operationStatus.setText(status);
        refreshActions();
    }

    private void refreshActions() {
        for (Button button : actionButtons) button.setEnabled(!busy);
        for (View view : inputViews) view.setEnabled(!busy);
        if (fileSave != null) fileSave.setEnabled(!busy && fileSnapshot != null && fileSnapshot.epoch == accessEpoch);
        if (exportBackup != null) exportBackup.setEnabled(!busy && lastBackup != null);
        if (memoryWrite != null) memoryWrite.setEnabled(!busy && memorySnapshot != null);
        if (settingsWrite != null) settingsWrite.setEnabled(!busy && settingSnapshot != null);
        if (settingsRestore != null) settingsRestore.setEnabled(!busy && settingUndo != null
                && !settingUndo.requiresRead && settingSnapshot != null);
    }

    private void showPage(int selected) {
        for (int i = 0; i < pages.size(); i++) pages.get(i).setVisibility(i == selected ? View.VISIBLE : View.GONE);
        for (int i = 0; i < tabs.size(); i++) {
            tabs.get(i).setTextColor(i == selected ? BG : MUTED);
            tabs.get(i).setBackground(background(i == selected ? MINT : PANEL, 12));
        }
    }

    private void showText(String title, String value) {
        ScrollView scroll = new ScrollView(this);
        TextView content = text(value, 12, TEXT);
        content.setTypeface(Typeface.MONOSPACE);
        content.setTextIsSelectable(true);
        content.setPadding(dp(18), dp(12), dp(18), dp(12));
        scroll.setBackgroundColor(BG);
        scroll.addView(content);
        new AlertDialog.Builder(this).setTitle(title).setView(scroll).setPositiveButton("关闭", null).show();
    }

    private void message(String value) {
        if (operationStatus != null) operationStatus.setText(value);
        Toast.makeText(this, value, Toast.LENGTH_LONG).show();
    }

    private void showError(String value) {
        if (!closed && !isFinishing()) new AlertDialog.Builder(this).setTitle("操作未完成")
                .setMessage(value).setPositiveButton("知道了", null).show();
    }

    private LinearLayout column() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); return view; }
    private LinearLayout row() { LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.HORIZONTAL); return view; }

    private LinearLayout card() {
        LinearLayout view = column();
        view.setPadding(dp(14), dp(14), dp(14), dp(14));
        view.setBackground(background(PANEL, 16));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(10), 0, dp(10));
        view.setLayoutParams(params);
        return view;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(size);
        view.setLineSpacing(dp(2), 1f);
        view.setPadding(0, dp(5), 0, dp(5));
        return view;
    }

    private EditText field(String hint, boolean multiline, boolean mono) {
        EditText view = new EditText(this);
        view.setTextColor(TEXT);
        view.setHintTextColor(MUTED);
        view.setTextSize(14);
        view.setHint(hint);
        view.setPadding(dp(12), dp(10), dp(12), dp(10));
        view.setBackground(background(INPUT, 10));
        view.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                | (multiline ? InputType.TYPE_TEXT_FLAG_MULTI_LINE : 0));
        view.setSingleLine(!multiline);
        if (multiline) view.setGravity(android.view.Gravity.TOP | android.view.Gravity.START);
        if (mono) view.setTypeface(Typeface.MONOSPACE);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(7), 0, dp(7));
        view.setLayoutParams(params);
        inputViews.add(view);
        return view;
    }

    private Spinner spinner(String[] options) {
        Spinner spinner = new Spinner(this);
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, options) {
            @Override public View getView(int position, View convertView, ViewGroup parent) {
                TextView view = (TextView) super.getView(position, convertView, parent);
                view.setTextColor(TEXT);
                view.setPadding(dp(10), dp(12), dp(10), dp(12));
                return view;
            }
            @Override public View getDropDownView(int position, View convertView, ViewGroup parent) {
                TextView view = (TextView) super.getDropDownView(position, convertView, parent);
                view.setTextColor(TEXT);
                view.setBackgroundColor(PANEL);
                view.setPadding(dp(12), dp(14), dp(12), dp(14));
                return view;
            }
        };
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        spinner.setBackground(background(INPUT, 10));
        inputViews.add(spinner);
        return spinner;
    }

    private Button action(String label, Runnable click) {
        Button button = button(label, click);
        actionButtons.add(button);
        return button;
    }

    private Button button(String label, Runnable click) {
        Button view = new Button(this);
        view.setText(label);
        view.setAllCaps(false);
        view.setTextColor(MINT);
        view.setTextSize(13);
        view.setMinHeight(dp(44));
        view.setMinimumHeight(dp(44));
        view.setPadding(dp(10), dp(8), dp(10), dp(8));
        view.setBackground(background(INPUT, 10));
        view.setOnClickListener(ignored -> click.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        params.setMargins(0, dp(6), 0, dp(6));
        view.setLayoutParams(params);
        return view;
    }

    private void addWeighted(LinearLayout row, View view) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
        params.setMargins(dp(3), dp(6), dp(3), dp(6));
        row.addView(view, params);
    }

    private GradientDrawable background(int color, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }

    private static JSONObject json(Object... pairs) {
        JSONObject result = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) result.put((String) pairs[i], pairs[i + 1]);
        } catch (JSONException impossible) { throw new IllegalArgumentException(impossible); }
        return result;
    }

    private static void watch(EditText field, Runnable callback) {
        field.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { callback.run(); }
            @Override public void afterTextChanged(Editable editable) { }
        });
    }

    private static String errorText(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty() ? error.getClass().getSimpleName() : message;
    }

    private static String sha256(byte[] bytes) {
        try { return compactHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }

    private static boolean isUtf8(byte[] bytes) {
        try {
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes));
            for (byte value : bytes) if (value == 0) return false;
            return true;
        } catch (CharacterCodingException error) { return false; }
    }

    private static byte[] decodeHex(String input) throws IOException {
        String hex = input.replaceAll("\\s", "");
        if ((hex.length() & 1) != 0 || !hex.matches("[0-9a-fA-F]*"))
            throw new IOException("十六进制需要成对字节，只能包含 0–9、A–F 和空白。");
        if (hex.length() > MAX_FILE_BYTES * 2) throw new IOException("内容超过 64 KiB 编辑上限。");
        byte[] bytes = new byte[hex.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }

    private static String compactHex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = digits[(bytes[i] & 0xff) >>> 4];
            out[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(out);
    }

    private static String spacedHex(byte[] bytes) {
        String hex = compactHex(bytes).toUpperCase(Locale.ROOT);
        StringBuilder out = new StringBuilder(bytes.length * 3);
        for (int i = 0; i < bytes.length; i++) {
            if (i > 0) out.append(i % 16 == 0 ? '\n' : ' ');
            out.append(hex, i * 2, i * 2 + 2);
        }
        return out.toString();
    }

    private abstract static class Selection implements AdapterView.OnItemSelectedListener {
        abstract void selected(int position);
        @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) { selected(position); }
        @Override public void onNothingSelected(AdapterView<?> parent) { }
    }

    private static final class FileSnapshot {
        final Uri uri;
        final String path;
        final String name;
        final byte[] bytes;
        final String sha256;
        final long epoch;
        FileSnapshot(Uri uri, String path, String name, byte[] bytes, long epoch) {
            this.uri = uri; this.path = path; this.name = name; this.bytes = bytes.clone();
            this.sha256 = sha256(bytes); this.epoch = epoch;
        }
    }

    private static final class MemorySnapshot {
        final String identity;
        final int pid;
        final String address;
        final String hex;
        final String processStart;
        MemorySnapshot(String identity, int pid, String address, String hex, String processStart) {
            this.identity = identity; this.pid = pid; this.address = address; this.hex = hex;
            this.processStart = processStart;
        }
    }

    private static final class SettingSnapshot {
        final String identity;
        final String namespace;
        final String key;
        final boolean exists;
        final String value;
        SettingSnapshot(String identity, String namespace, String key, boolean exists, String value) {
            this.identity = identity; this.namespace = namespace; this.key = key;
            this.exists = exists; this.value = value;
        }
    }

    private static final class SettingUndo {
        final SettingSnapshot before;
        final SettingSnapshot after;
        final boolean requiresRead;
        SettingUndo(SettingSnapshot before, SettingSnapshot after, boolean requiresRead) {
            this.before = before; this.after = after; this.requiresRead = requiresRead;
        }
    }

    @Override protected void onDestroy() {
        closed = true;
        if (bridge != null) bridge.close();
        fileIo.shutdown();
        super.onDestroy();
    }
}
