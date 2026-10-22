export type SiteFile = { path: string; storageKey: string; contentType: string; size: number; checksum: string };
export type GameSite = { schemaVersion: 1; format: "vite"; sourceFiles: Record<string, string>; files: SiteFile[] };
export function safeSitePath(value: string): boolean {
  return /^[A-Za-z0-9_.\/-]+$/.test(value) && !value.startsWith("/") && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
