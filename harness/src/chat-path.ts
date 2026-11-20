// The same allowlist protects page routing and the post-login return path.
export function isChatPage(path: string) {
  return path === "/" || /^\/c\/\d+$/.test(path);
}
