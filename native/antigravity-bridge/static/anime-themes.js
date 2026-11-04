(() => {
  "use strict";
  // Presentation only. No chat requests, message rendering or session state.
  const key = "agy_anime_skin_v1";
  const themes = [
    { id: "sakura-dream", title: "Sakura Dream", desc: "樱粉与星紫 · 玻璃卡片", url: "https://github.com/13026574332/anime-ui", colors: ["#ff9ecb", "#a78bfa", "#7dd3fc"] },
    { id: "momotalk", title: "MomoTalk", desc: "蔚蓝档案 · 粉色顶栏与聊天气泡", url: "https://github.com/MiyakuKage/discord-momotalk", colors: ["#FB90A4", "#4A8AC8", "#4C5B6F"] },
    { id: "ghibli", title: "Ghibli · 森林", desc: "Anime UI · 手绘草原与纸张卡片", url: "https://github.com/a10x-dev/anime-ui", colors: ["#7d8f69", "#f8ecd1", "#85c7de"] },
    { id: "sakura-card", title: "Sakura · 清透", desc: "Valaxy Sakura · 浮动卡片与橙色强调", url: "https://github.com/WRXinYue/valaxy-theme-sakura", colors: ["#fe9500", "#ffffff", "#26262b"] },
    { id: "original", title: "原有界面", desc: "流萤 × 遐蝶 · 保留原来的外观设置", colors: ["#70dbc7", "#ad8cff", "#171d28"] },
  ];
  let current = "sakura-dream";
  try { const saved = localStorage.getItem(key); if (themes.some(t => t.id === saved)) current = saved; } catch {}
  const layer = document.getElementById("ui-settings");
  if (!layer) return;
  const legacySceneStyle = document.querySelector('link[href*="/static/scene-theme.css"], #legacy-scene-style');
  const section = document.createElement("fieldset");
  section.className = "ui-settings-section anime-theme-section";
  const legend = document.createElement("legend");
  legend.textContent = "二次元 UI 主题";
  section.appendChild(legend);
  const grid = document.createElement("div");
  grid.className = "anime-theme-grid";
  section.appendChild(grid);
  for (const theme of themes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "anime-theme-option";
    button.dataset.animeChoice = theme.id;
    const swatch = document.createElement("span");
    swatch.className = "anime-theme-swatch";
    swatch.style.background = `linear-gradient(120deg,${theme.colors[0]},${theme.colors[1]} 60%,${theme.colors[2]})`;
    swatch.setAttribute("aria-hidden", "true");
    const title = document.createElement("strong"); title.textContent = theme.title;
    const desc = document.createElement("small"); desc.textContent = theme.desc;
    button.append(swatch, title, desc);
    button.addEventListener("click", () => apply(theme.id, true));
    grid.appendChild(button);
  }
  const source = document.createElement("a");
  source.className = "anime-theme-source";
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  section.appendChild(source);
  layer.querySelector(".ui-settings-body").prepend(section);
  function apply(id, save) {
    current = id;
    const theme = themes.find(t => t.id === id);
    if (id === "original") delete document.body.dataset.animeSkin;
    else document.body.dataset.animeSkin = id;
    if (legacySceneStyle?.sheet) legacySceneStyle.sheet.disabled = id !== "original";
    grid.querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.animeChoice === id)));
    source.hidden = !theme.url;
    if (theme.url) { source.href = theme.url; source.textContent = "查看 " + theme.title + " 原主题 ↗"; }
    if (save) { try { localStorage.setItem(key, id); } catch {} }
  }
  // Existing palette/scene preferences remain available when returning to the original skin.
  const existingPalettes = layer.querySelector(".ui-palette-options")?.closest("fieldset");
  function syncLegacyControls() {
    if (existingPalettes) existingPalettes.hidden = current !== "original";
    const scene = layer.querySelector("#ui-scene");
    if (scene) scene.closest("label").hidden = current !== "original";
  }
  grid.addEventListener("click", syncLegacyControls);
  layer.querySelector("#ui-reset")?.addEventListener("click", () => { apply("original", true); syncLegacyControls(); });
  apply(current, false);
  syncLegacyControls();
})();
