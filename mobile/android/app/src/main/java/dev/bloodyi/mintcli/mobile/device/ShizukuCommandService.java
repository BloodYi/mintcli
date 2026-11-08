package dev.bloodyi.mintcli.mobile.device;

import android.content.Context;

/** Shizuku starts this class under its actual shell or root identity. */
public final class ShizukuCommandService extends IDeviceTools.Stub {
    private final DeviceExecutor executor = new DeviceExecutor();

    public ShizukuCommandService() {}

    public ShizukuCommandService(Context context) {}

    @Override public String execute(String requestJson) {
        return executor.execute(requestJson);
    }

    @Override public void destroy() {
        System.exit(0);
    }
}
