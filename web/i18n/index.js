import en from "./locales/en.js";
import de from "./locales/de.js";
import es from "./locales/es.js";
import fr from "./locales/fr.js";
import ja from "./locales/ja.js";
import ko from "./locales/ko.js";
import ptBR from "./locales/pt-BR.js";
import ru from "./locales/ru.js";
import zhCN from "./locales/zh-CN.js";
import zhHant from "./locales/zh-Hant.js";

const LOCALE_STORAGE_KEY = "remcodex.locale";
const LOCALE_OPTIONS = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
  { id: "zh-Hant", label: "繁體中文" },
  { id: "ja", label: "日本語" },
  { id: "ko", label: "한국어" },
  { id: "es", label: "Español" },
  { id: "fr", label: "Français" },
  { id: "de", label: "Deutsch" },
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "ru", label: "Русский" },
];
const SUPPORTED_LOCALES = new Set(LOCALE_OPTIONS.map((item) => item.id));
const DICTIONARIES = {
  de,
  en,
  es,
  fr,
  ja,
  ko,
  "pt-BR": ptBR,
  ru,
  "zh-CN": zhCN,
  "zh-Hant": zhHant,
};

function normalizeLocale(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return "en";
  }
  if (raw === "zh" || raw === "zh-cn" || raw === "zh-hans" || raw.startsWith("zh-cn")) {
    return "zh-CN";
  }
  if (
    raw === "zh-tw" ||
    raw === "zh-hk" ||
    raw === "zh-hant" ||
    raw.startsWith("zh-tw") ||
    raw.startsWith("zh-hk") ||
    raw.startsWith("zh-hant")
  ) {
    return "zh-Hant";
  }
  if (raw === "ja" || raw.startsWith("ja-")) {
    return "ja";
  }
  if (raw === "ko" || raw.startsWith("ko-")) {
    return "ko";
  }
  if (raw === "es" || raw.startsWith("es-")) {
    return "es";
  }
  if (raw === "fr" || raw.startsWith("fr-")) {
    return "fr";
  }
  if (raw === "de" || raw.startsWith("de-")) {
    return "de";
  }
  if (raw === "pt" || raw === "pt-br" || raw.startsWith("pt-br")) {
    return "pt-BR";
  }
  if (raw === "ru" || raw.startsWith("ru-")) {
    return "ru";
  }
  return "en";
}

function readStoredLocale() {
  try {
    const value = window.localStorage?.getItem(LOCALE_STORAGE_KEY);
    return value && SUPPORTED_LOCALES.has(value) ? value : "";
  } catch {
    return "";
  }
}

function detectLocale() {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }
  if (typeof navigator !== "undefined") {
    return normalizeLocale(navigator.language || navigator.languages?.[0] || "");
  }
  return "en";
}

let currentLocale = detectLocale();

function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function resolveValue(dict, key) {
  return dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

export function getCurrentLocale() {
  return currentLocale;
}

export function getIntlLocale() {
  switch (currentLocale) {
    case "zh-CN":
      return "zh-Hans-CN";
    case "zh-Hant":
      return "zh-Hant";
    case "pt-BR":
      return "pt-BR";
    default:
      return currentLocale;
  }
}

export function listSupportedLocales() {
  return LOCALE_OPTIONS;
}

export function setCurrentLocale(locale) {
  currentLocale = normalizeLocale(locale);
  try {
    window.localStorage?.setItem(LOCALE_STORAGE_KEY, currentLocale);
  } catch {
    /* ignore */
  }
  return currentLocale;
}

export function toggleLocale() {
  return setCurrentLocale(currentLocale === "zh-CN" ? "en" : "zh-CN");
}

export function t(key, params = {}) {
  const dict = DICTIONARIES[currentLocale] || DICTIONARIES.en;
  const fallback = DICTIONARIES["zh-CN"];
  const value = resolveValue(dict, key) ?? resolveValue(fallback, key) ?? resolveValue(DICTIONARIES.en, key);
  if (typeof value === "function") {
    return String(value(params));
  }
  if (typeof value === "string") {
    return interpolate(value, params);
  }
  return key;
}

export function formatInlineList(values) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (list.length === 0) {
    return "";
  }
  if (currentLocale === "zh-CN") {
    return list.join("、");
  }
  return list.join(", ");
}
