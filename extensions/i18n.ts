import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Locale = "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const namespace = "pi-cmux";
const localeChangedEvent = `${namespace}/i18n/localeChanged`;

const fallback = {
	"open.usage": "Usage: /{name} <command...>",
	"open.failed": "tool split failed: {error}",
	"open.failed.tab": "tool tab failed: {error}",
	"open.right.description": "Open a new right split and run any shell command there",
	"open.down.description": "Open a new lower split and run any shell command there",
	"open.tab.description": "Open a new cmux tab and run any shell command there",
	"open.alias.cmo": "Alias for /cmo",
	"open.success.right": "Opened a tool split to the right",
	"open.success.down": "Opened a tool split below",
	"open.success.tab": "Opened a tool tab",
} as const;

export type I18nKey = keyof typeof fallback;

const translations: Record<Locale, Partial<Record<I18nKey, string>>> = {
	es: {
		"open.usage": "Uso: /{name} <comando...>",
		"open.failed": "falló la división de herramienta: {error}",
		"open.failed.tab": "falló la pestaña de herramienta: {error}",
		"open.right.description": "Abrir una nueva división a la derecha y ejecutar allí cualquier comando de shell",
		"open.down.description": "Abrir una nueva división inferior y ejecutar allí cualquier comando de shell",
		"open.tab.description": "Abrir una nueva pestaña de cmux y ejecutar allí cualquier comando de shell",
		"open.alias.cmo": "Alias de /cmo",
		"open.success.right": "Se abrió una división de herramienta a la derecha",
		"open.success.down": "Se abrió una división de herramienta abajo",
		"open.success.tab": "Se abrió una pestaña de herramienta",
	},
	fr: {
		"open.usage": "Utilisation : /{name} <commande...>",
		"open.failed": "échec du split d’outil : {error}",
		"open.failed.tab": "échec de l’onglet d’outil : {error}",
		"open.right.description": "Ouvrir un nouveau split à droite et y exécuter n’importe quelle commande shell",
		"open.down.description": "Ouvrir un nouveau split inférieur et y exécuter n’importe quelle commande shell",
		"open.tab.description": "Ouvrir un nouvel onglet cmux et y exécuter n’importe quelle commande shell",
		"open.alias.cmo": "Alias de /cmo",
		"open.success.right": "Split d’outil ouvert à droite",
		"open.success.down": "Split d’outil ouvert en bas",
		"open.success.tab": "Onglet d’outil ouvert",
	},
	"pt-BR": {
		"open.usage": "Uso: /{name} <comando...>",
		"open.failed": "falha ao abrir divisão de ferramenta: {error}",
		"open.failed.tab": "falha ao abrir aba de ferramenta: {error}",
		"open.right.description": "Abrir uma nova divisão à direita e executar qualquer comando de shell nela",
		"open.down.description": "Abrir uma nova divisão inferior e executar qualquer comando de shell nela",
		"open.tab.description": "Abrir uma nova aba do cmux e executar qualquer comando de shell nela",
		"open.alias.cmo": "Alias para /cmo",
		"open.success.right": "Divisão de ferramenta aberta à direita",
		"open.success.down": "Divisão de ferramenta aberta abaixo",
		"open.success.tab": "Aba de ferramenta aberta",
	},
};

let currentLocale: string | undefined;

function format(template: string, params: Params = {}): string {
	return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? `{${key}}`));
}

function coerceLocale(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const locale = value.trim();
	return locale.length > 0 ? locale : undefined;
}

function resolveLocale(locale: string | undefined): Locale | undefined {
	const normalized = locale?.replace("_", "-");
	if (normalized === "pt-BR" || normalized === "pt-br") {
		return "pt-BR";
	}
	const baseLocale = normalized?.split("-")[0];
	return baseLocale === "es" || baseLocale === "fr" ? baseLocale : undefined;
}

function setCurrentLocale(pi: ExtensionAPI, locale: string | undefined): void {
	if (currentLocale === locale) {
		return;
	}
	currentLocale = locale;
	pi.events?.emit?.(localeChangedEvent, { locale: currentLocale });
}

export function t(key: I18nKey, params?: Params): string {
	const locale = resolveLocale(currentLocale);
	const template = locale ? translations[locale]?.[key] : undefined;
	return format(template ?? fallback[key], params);
}

export function onI18nLocaleChanged(pi: ExtensionAPI, handler: () => void): void {
	pi.events?.on?.(localeChangedEvent, handler);
}

export function initI18n(pi: ExtensionAPI): void {
	pi.events?.emit?.("pi-core/i18n/registerBundle", {
		namespace,
		defaultLocale: "en",
		fallback,
		translations,
	});
	pi.events?.on?.("pi-core/i18n/localeChanged", (event: unknown) => {
		const locale = event && typeof event === "object" && "locale" in event
			? coerceLocale((event as { locale?: unknown }).locale)
			: undefined;
		setCurrentLocale(pi, locale);
	});
	pi.events?.emit?.("pi-core/i18n/requestApi", {
		namespace,
		onApi(api: { getLocale?: () => string | undefined }) {
			setCurrentLocale(pi, coerceLocale(api.getLocale?.()));
		},
	});
}
