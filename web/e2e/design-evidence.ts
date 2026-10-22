import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";

export async function designEvidence(page: Page, id: string, note: string) {
  if (!process.env.DESIGN_REPORT_EVIDENCE) return;
  const dir = '../.impeccable/review/design-fix-20261012';
  await mkdir(`${dir}/screenshots`, { recursive: true });
  await mkdir(`${dir}/evidence`, { recursive: true });
  await page.screenshot({ path: `${dir}/screenshots/${id}.png` });
  await writeFile(`${dir}/evidence/${id}-shot.json`, JSON.stringify({ id, file: `screenshots/${id}.png`, note, url: page.url(), viewport: page.viewportSize(), capturedAt: new Date().toISOString(), origin: 'app' }, null, 2));
}

