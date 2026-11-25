let cleanup;
export function mount(container, host) {
  const render = () => {
    container.replaceChildren();
    const section = document.createElement('section');
    section.style.cssText = 'padding:24px;display:grid;gap:16px;font:14px system-ui';
    const title = document.createElement('h2'); title.textContent = 'Token Monitor · 真实返回与用量';
    const text = document.createElement('p'); text.textContent = '打开监控窗口，查看全部模型累计 Token 用量、模型输出速度（tok/s）、历史会话归档、返回模型与回复原文。';
    const button = document.createElement('button'); button.textContent = '打开监控窗口';
    button.style.cssText = 'padding:12px;border:1px solid #888;border-radius:8px;cursor:pointer';
    button.onclick = () => window.dispatchEvent(new CustomEvent('token-monitor-open', { detail: { sessionId: host.context.session?.id || null } }));
    const link = document.createElement('a'); link.textContent = '上游项目 Javis603/token-monitor · tokscale（本插件为工作台适配版）'; link.href = 'https://github.com/Javis603/token-monitor'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    section.append(title, text, button, link); container.append(section);
  };
  render(); cleanup = host.onContextChange(render);
}
export function unmount(container) { cleanup?.(); container.replaceChildren(); }
