package dev.bloodyi.mintcli.mobile.device;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;

import com.topjohnwu.superuser.Shell;
import com.topjohnwu.superuser.ipc.RootService;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

import rikka.shizuku.Shizuku;

/** Activity-owned local Binder connections. Nothing is injected into a WebView. */
public final class DeviceBridge {
    public interface Listener { void onStatusChanged(String status); }
    public interface Callback { void onResult(JSONObject response); }

    private static final int SHIZUKU_REQUEST = 30671;
    private final Activity owner;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final DeviceExecutor local = new DeviceExecutor();
    private final Shizuku.UserServiceArgs shizukuArgs;
    private final Shizuku.OnRequestPermissionResultListener permissionListener;
    private final Shizuku.OnBinderDeadListener shizukuDeathListener;
    private volatile boolean closed;
    private volatile IDeviceTools remote;
    private String status = "普通权限 · UID " + Process.myUid();
    private ServiceConnection rootConnection;
    private ServiceConnection shizukuConnection;
    private volatile int selection;
    private int pendingShizukuSelection = -1;
    private boolean shizukuListenersAdded;

    public DeviceBridge(Activity owner, Listener listener) {
        this.owner = owner;
        this.listener = listener;
        shizukuArgs = new Shizuku.UserServiceArgs(
                new ComponentName(owner.getPackageName(), ShizukuCommandService.class.getName()))
                .daemon(false).processNameSuffix("device_tools").debuggable(false).version(1);
        permissionListener = (requestCode, grantResult) -> main.post(() -> {
            if (closed || requestCode != SHIZUKU_REQUEST || pendingShizukuSelection != selection) return;
            int expectedSelection = pendingShizukuSelection;
            pendingShizukuSelection = -1;
            if (grantResult == PackageManager.PERMISSION_GRANTED) bindShizuku(expectedSelection);
            else setStatus("Shizuku 授权被拒绝 · 当前为普通权限");
        });
        shizukuDeathListener = () -> main.post(() -> {
            if (!closed && shizukuConnection != null) {
                resetConnections();
                setStatus("Shizuku 已停止 · 当前为普通权限");
            }
        });
        try {
            Shizuku.addRequestPermissionResultListener(permissionListener);
            Shizuku.addBinderDeadListener(shizukuDeathListener);
            shizukuListenersAdded = true;
        } catch (RuntimeException unavailable) {
            // Normal tools still work when the Shizuku companion is unavailable.
        }
    }

    public void requestRoot() {
        if (closed) return;
        resetConnections();
        final int expectedSelection = selection;
        setStatus("正在请求 Root 授权…");
        submit(() -> {
            try {
                boolean granted = Shell.getShell().isRoot();
                main.post(() -> {
                    if (closed || expectedSelection != selection) return;
                    if (!granted) {
                        setStatus("未获得 Root 授权 · 当前为普通权限");
                        return;
                    }
                    rootConnection = connection(true, expectedSelection);
                    try {
                        RootService.bind(new Intent(owner, RootCommandService.class), rootConnection);
                        bindingTimeout(expectedSelection, true);
                    } catch (RuntimeException error) { connectionError(expectedSelection, "Root", error); }
                });
            } catch (RuntimeException error) {
                main.post(() -> connectionError(expectedSelection, "Root", error));
            }
        });
    }

    public void requestShizuku() {
        if (closed) return;
        resetConnections();
        int expectedSelection = selection;
        try {
            if (!Shizuku.pingBinder()) {
                setStatus("请先安装并启动 Shizuku · 当前为普通权限");
                return;
            }
            if (Shizuku.getVersion() < 11) {
                setStatus("请更新 Shizuku 至支持 API 11 或以上的版本");
                return;
            }
            if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                bindShizuku(expectedSelection);
            } else {
                pendingShizukuSelection = expectedSelection;
                setStatus("等待 Shizuku 授权…");
                Shizuku.requestPermission(SHIZUKU_REQUEST);
            }
        } catch (RuntimeException error) { connectionError(expectedSelection, "Shizuku", error); }
    }

    public void useAppPermissions() {
        if (closed) return;
        resetConnections();
        setStatus("普通权限 · UID " + Process.myUid());
    }

    public String getStatusText() { return status; }

    public void execute(JSONObject request, Callback callback) {
        if (closed) return;
        final IDeviceTools selectedRemote = remote;
        final int selectedGeneration = selection;
        final String encoded = request == null ? "" : request.toString();
        if (encoded.length() > 300_000) {
            deliver(callback, DeviceExecutor.failure("操作请求过大"));
            return;
        }
        submit(() -> {
            String result;
            try {
                // A queued write must not silently run after the selected permission mode changed.
                if (selectedGeneration != selection) throw new IllegalStateException("权限模式已变化，请重试操作");
                if (selectedRemote == null) result = local.execute(encoded);
                else result = selectedRemote.execute(encoded);
            } catch (Exception error) {
                String message = error.getMessage();
                result = DeviceExecutor.failure(message == null ? "手机工具连接已断开，请重新授权" : message);
            }
            deliver(callback, result);
        });
    }

    private void bindShizuku(int expectedSelection) {
        if (closed || expectedSelection != selection) return;
        setStatus("正在连接 Shizuku 手机工具…");
        shizukuConnection = connection(false, expectedSelection);
        try {
            Shizuku.bindUserService(shizukuArgs, shizukuConnection);
            bindingTimeout(expectedSelection, false);
        } catch (RuntimeException error) { connectionError(expectedSelection, "Shizuku", error); }
    }

    private ServiceConnection connection(boolean root, int expectedSelection) {
        return new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) {
                if (closed || expectedSelection != selection) return;
                IDeviceTools service = IDeviceTools.Stub.asInterface(binder);
                submit(() -> {
                    try {
                        if (binder == null || !binder.pingBinder() || service == null)
                            throw new IllegalStateException("服务未响应");
                        JSONObject result = new JSONObject(service.execute("{\"op\":\"info\"}"));
                        if (!result.getBoolean("ok")) throw new IllegalStateException(result.optString("error"));
                        int uid = result.getJSONObject("data").getInt("uid");
                        if (root && uid != 0) throw new IllegalStateException("Root 服务没有获得 UID 0");
                        binder.linkToDeath(() -> main.post(() -> disconnected(expectedSelection)), 0);
                        main.post(() -> {
                            if (closed || expectedSelection != selection) return;
                            remote = service;
                            String identity = uid == 0 ? "Root" : uid == 2000 ? "ADB shell" : "UID " + uid;
                            setStatus((root ? "Root" : "Shizuku · " + identity) + " · UID " + uid);
                        });
                    } catch (Exception error) {
                        main.post(() -> connectionError(expectedSelection, root ? "Root" : "Shizuku", error));
                    }
                });
            }

            @Override public void onServiceDisconnected(ComponentName name) {
                main.post(() -> disconnected(expectedSelection));
            }

            @Override public void onBindingDied(ComponentName name) {
                main.post(() -> disconnected(expectedSelection));
            }

            @Override public void onNullBinding(ComponentName name) {
                main.post(() -> disconnected(expectedSelection));
            }
        };
    }

    private void bindingTimeout(int expectedSelection, boolean root) {
        main.postDelayed(() -> {
            if (!closed && expectedSelection == selection && remote == null) {
                resetConnections();
                setStatus((root ? "Root" : "Shizuku") + " 服务连接超时 · 当前为普通权限");
            }
        }, 20_000);
    }

    private void connectionError(int expectedSelection, String backend, Exception error) {
        if (closed || expectedSelection != selection) return;
        resetConnections();
        String reason = error.getMessage();
        if (reason == null || reason.isEmpty()) reason = error.getClass().getSimpleName();
        if (reason.length() > 300) reason = reason.substring(0, 300);
        setStatus(backend + " 连接失败：" + reason + " · 当前为普通权限");
    }

    private void disconnected(int expectedSelection) {
        if (closed || expectedSelection != selection) return;
        resetConnections();
        setStatus("手机工具服务已断开 · 当前为普通权限");
    }

    private void resetConnections() {
        selection++;
        pendingShizukuSelection = -1;
        remote = null;
        if (rootConnection != null) {
            try { RootService.unbind(rootConnection); } catch (RuntimeException ignored) {}
            rootConnection = null;
        }
        if (shizukuConnection != null) {
            try { Shizuku.unbindUserService(shizukuArgs, shizukuConnection, true); }
            catch (RuntimeException ignored) {}
            shizukuConnection = null;
        }
    }

    private void submit(Runnable work) {
        if (closed) return;
        try { worker.execute(work); }
        catch (RejectedExecutionException stopped) { /* Activity has been destroyed. */ }
    }

    private void deliver(Callback callback, String encoded) {
        main.post(() -> {
            if (closed || callback == null) return;
            JSONObject result;
            try { result = new JSONObject(encoded); }
            catch (Exception malformed) {
                try { result = new JSONObject(DeviceExecutor.failure("手机工具返回了无效响应")); }
                catch (Exception impossible) { return; }
            }
            callback.onResult(result);
        });
    }

    private void setStatus(String next) {
        if (closed) return;
        status = next;
        if (listener != null) listener.onStatusChanged(next);
    }

    public void close() {
        if (closed) return;
        resetConnections();
        closed = true;
        if (shizukuListenersAdded) {
            Shizuku.removeRequestPermissionResultListener(permissionListener);
            Shizuku.removeBinderDeadListener(shizukuDeathListener);
        }
        worker.shutdownNow();
        main.removeCallbacksAndMessages(null);
    }
}
