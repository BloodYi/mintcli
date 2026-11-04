# 二次元主题来源与适配说明

使用网上现有主题的视觉规则，适配已有聊天 DOM；并非原项目整站移植。业务代码、框架和全局 reset 未引入。

- Sakura Dream: https://github.com/13026574332/anime-ui — 樱粉、星紫、玻璃卡片与日夜渐变，视觉参考 src/index.css。原仓库未附 LICENSE，未整包引入其 React 代码或角色插画。
- MomoTalk: https://github.com/MiyakuKage/discord-momotalk — 作者 yumemiya / elatedcard / kyonakansou / kuurp；粉色顶栏、蓝灰气泡与日夜表面颜色。视觉规则见 Momotalk.theme.css、MomotalkSource.theme.css；人物图来自 img/aronastatic.png。原仓库未附 LICENSE，不宣称该素材获得 MIT 授权；用于本次 VPS 界面适配，公开再分发人物素材前需核实权利。
- Anime UI: https://github.com/a10x-dev/anime-ui — MIT，颜色见 app/globals.css，卡片、按钮与输入框见 components/ui；草原背景来自 public/bg.png。完整许可见 Anime-UI-LICENSE.txt。深色阅读表面为本程序兼容适配。
- Valaxy Sakura: https://github.com/WRXinYue/valaxy-theme-sakura — MIT，卡片来自 theme/styles/common/card.scss，颜色、圆角见 vars.scss，主色见 theme/node/config.ts；完整许可见 Valaxy-Sakura-LICENSE.txt。

## 来源版本

- sakura: `e27ee8ca866c6028be4eaa4c53a2c264c4fef2e4`
- momotalk: `d96c133c98adf4e67d4d0e630eeb3393fed9ae17`
- ghibli: `39f063956452b8511aae9b1a5a3373f0316fc647`
- valaxy: `a1a0f5c16d2f3c7a839a7e42c5c980cbbc7cc885`

所有主题保留已有控件与聊天逻辑。主题选择仅写入本浏览器 localStorage。为正文对比度和手机布局调整少量颜色、尺寸。
