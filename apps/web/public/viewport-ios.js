// iOS Safari는 16px보다 작은 입력칸에 초점이 가면 화면을 확대한다. iOS에서만 자동 확대를 막는다(손가락 확대는 그대로 된다).
// CSP(script-src 'self')가 인라인 스크립트를 막으므로 같은 출처의 파일로 둔다.
if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
  document.querySelector('meta[name=viewport]').content += ', maximum-scale=1';
}
