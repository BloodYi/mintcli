package dev.bloodyi.mintcli.mobile.device;

interface IDeviceTools {
    String execute(String requestJson) = 0;
    // Shizuku reserves this transaction for stopping a non-daemon user service.
    void destroy() = 16777114;
}
