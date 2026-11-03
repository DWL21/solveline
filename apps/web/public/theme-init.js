// 테마(src/lib/theme.ts): 그리기 전에 정해 깜빡이지 않게 한다. 고른 적이 있으면 그 값, 없으면 기기 설정.
// CSP(script-src 'self')가 인라인 스크립트를 막으므로 같은 출처의 파일로 둔다.
(function () {
  var t = null;
  try { t = localStorage.getItem('solveline:theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  if (t === 'light') document.querySelector('meta[name=theme-color]').content = '#ffffff';
})();
