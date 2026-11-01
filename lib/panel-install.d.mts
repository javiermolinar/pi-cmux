export interface PanelInspection {
  status: "missing" | "non-file" | "modified" | "current" | "outdated";
  kind?: string;
  legacy?: boolean;
  content?: string;
  hash?: string;
  mode?: number;
  version?: number;
  recordedHash?: string;
  bodyHash?: string;
  currentHash?: string;
}
export function sha256(bytes: string | Uint8Array): string;
export function readBundledPanel(): string;
export function renderInstalledPanel(source?: string): string;
export function inspectInstalledPanel(target: string): PanelInspection;
export function installSidebar(target: string, content: string, expectedHash?: string): { changed: boolean; backup?: string };
