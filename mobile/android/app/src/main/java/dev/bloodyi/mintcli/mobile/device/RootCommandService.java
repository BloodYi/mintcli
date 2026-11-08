package dev.bloodyi.mintcli.mobile.device;

import android.content.Intent;
import android.os.IBinder;

import com.topjohnwu.superuser.ipc.RootService;

/** A bound local root process; its Binder is never exposed to web content. */
public final class RootCommandService extends RootService {
    private final IDeviceTools.Stub binder = new IDeviceTools.Stub() {
        private final DeviceExecutor executor = new DeviceExecutor();

        @Override public String execute(String requestJson) {
            return executor.execute(requestJson);
        }

        @Override public void destroy() {
            // RootService owns its process lifecycle and stops after unbinding.
        }
    };

    @Override public IBinder onBind(Intent intent) {
        return binder;
    }
}
