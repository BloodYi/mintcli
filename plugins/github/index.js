// The host renders the native GitHub module so authentication stays inside mintcli.
export function mount(container) {
  container.textContent = '请更新 mintcli 以使用内置 GitHub 登录与上传。';
}
export function unmount(container) { container.replaceChildren(); }
