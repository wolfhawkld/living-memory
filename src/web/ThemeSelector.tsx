import { useTheme } from './ThemeProvider';
import { normalizeThemePreference } from './theme-preferences';

export function ThemeSelector() {
  const { preference, resolvedTheme, setPreference } = useTheme();
  return (
    <label className="theme-selector" title="主题偏好保存在当前浏览器">
      <span>主题</span>
      <select aria-label="主题" value={preference} onChange={(event) => setPreference(normalizeThemePreference(event.target.value))}>
        <option value="dark">深色</option>
        <option value="light">浅色</option>
        <option value="system">跟随系统</option>
      </select>
      {preference === 'system' ? <span className="theme-resolved">当前{resolvedTheme === 'dark' ? '深色' : '浅色'}</span> : null}
    </label>
  );
}
