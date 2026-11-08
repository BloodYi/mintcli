# mintcli 安卓版

安卓端包含现有 mintcli 网页工作区入口，以及在手机本地执行的原生文件、内存和系统设置工具。支持 Android 8.0 及以上。

## 使用

安装 APK 后，点击「连接」填写你现有的 mintcli 服务网址，登录后使用原有的智能体、账号、会话、项目、终端和 Git 功能。工作区中的代码编辑和终端仍在 mintcli 服务所在机器执行；「手机工具」操作的是当前手机。

App 不内置代理节点、订阅、VPN 或代理内核。开启你自己的 Clash VPN/TUN 模式，并将 mintcli 纳入代理范围。只开启 Clash 的本地 HTTP/SOCKS 监听端口不会自动接管所有 App 网络。

## 手机工具

- **文件编辑**：通过系统文件选择器打开授权文件，支持 UTF-8 文本与十六进制编辑；手工路径可使用普通权限、Shizuku 或 Root 实际允许访问的文件。每次最多读取 64 KiB，保存前校验文件未变化并备份原内容。
- **运行内存**：列出当前权限可见进程、查看内存映射、按地址读取或写入最多 4096 字节。写入前再次核对原字节，切换进程、地址或权限后需要重新读取。
- **系统设置**：读取和修改 `global`、`system`、`secure` 设置；保存前核对当前值，可恢复最近一次修改的原值或原来的不存在状态。
- **权限**：默认使用 App 自身权限；点击相应按钮后才申请 Shizuku 或 Root。状态显示真实连接结果，权限不足、进程退出和系统限制会直接报错。

Android 沙箱限制普通 App 访问其他 App 的私有数据和进程内存。Shizuku 经 ADB 启动时通常运行在 shell UID，具有的权限与 Root 不同；不能据此保证其他 App 的内存可读写。跨进程内存操作通常需要现有的 Root 及系统允许的 `/proc` 访问条件。本 App 不提供 Root 获取或漏洞利用功能。

手机工具与工作区没有 JavaScript 权限桥；网页智能体目前不能自动调用这些手机工具。文件、内存和设置的修改由手机工具页面中的操作按钮发起。原有 CLI 后端仍需运行在受支持的服务器或电脑上，此版本不把桌面 CLI 二进制移植到 Android。

## 构建与验证

需要 JDK 17、Android SDK 35 和 Build Tools 35.0.0，或在 Android Studio 中打开本目录。随附的 Gradle Wrapper 会下载并校验 Gradle 8.9。

```bash
./gradlew --no-daemon testDebugUnitTest lintDebug assembleDebug
```

安装包输出为 `app/build/outputs/apk/debug/app-debug.apk`。这是测试签名的 APK；正式发行应使用你自己的持久签名密钥。源码不包含账号、Token、工作区网址、代理配置或签名私钥。

GitHub Actions 模板位于 [ci/android-app.yml](ci/android-app.yml)，包含单元测试、Android Lint、APK 构建及产物上传。获得允许修改工作流的 GitHub 授权后，将它放到仓库根目录 `.github/workflows/android-app.yml` 即可启用。它与原仓库其他工作流的归档方式一致。

## 依赖与许可

此目录随 mintcli 按仓库的 AGPL-3.0-or-later 许可证发布，保留原仓库归属说明。使用的库为 [libsu 6.0.0](https://github.com/topjohnwu/libsu)（Apache-2.0）和 [Shizuku API 13.1.5](https://github.com/RikkaApps/Shizuku-API)（MIT）；相应运行时组件由用户在手机上自行安装和授权。

验证范围包括输入边界、来源隔离、编译和静态检查。Root、Shizuku、具体机型内存访问和 Clash 路由需要在实际设备上验证。
