import React from 'react';

const LangCtx = React.createContext({ lang: 'zh', setLang: () => {} });
const KEY = 'ae_mcp_panel_lang';

export function LangProvider({ children }) {
  const [lang, setLangState] = React.useState(() => {
    try {
      const v = window.localStorage.getItem(KEY);
      if (v === 'zh' || v === 'en') return v;
    } catch (e) {
      // localStorage unavailable
    }
    return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
  });
  const setLang = (v) => {
    setLangState(v);
    try {
      window.localStorage.setItem(KEY, v);
    } catch (e) {
      // best-effort persistence
    }
  };
  return <LangCtx.Provider value={{ lang, setLang }}>{children}</LangCtx.Provider>;
}

export const useLang = () => React.useContext(LangCtx);
