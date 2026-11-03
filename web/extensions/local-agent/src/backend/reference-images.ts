/**
 * 从用户原文里找出点名的组内图片，并读出字节。
 *
 * 组内回合不让 Codex 自己读文件。宿主在发送前用标题对上节点，再把字节放进回合输入。
 */
import { canvasGroupMembers, type AgentImageInput, type ServerCanvas } from "@woohaa3/contracts";

const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

export type MentionedTitle = { nodeId: string; title: string };

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif)$/i;

/** 标题全文，或去掉扩展名后「 - 」前的主名称（及其至少 4 字的前缀）出现在原文里。 */
export function titleMentioned(prompt: string, title: string): boolean {
  const haystack = prompt.trim().toLowerCase();
  const raw = title.trim().toLowerCase();
  if (haystack.length === 0 || raw.length < 2) return false;
  if (haystack.includes(raw)) return true;
  const stem = (raw.replace(IMAGE_EXTENSION, "").split(/\s+-\s+/)[0] ?? "").trim();
  if (stem.length < 4) return false;
  if (haystack.includes(stem)) return true;
  let prefix = "";
  for (const part of stem.split(/\s+/)) {
    if (part.length === 0) continue;
    prefix = prefix.length > 0 ? `${prefix} ${part}` : part;
    if (prefix.length >= 4 && haystack.includes(prefix)) return true;
  }
  return false;
}

export function mentionedTitles(prompt: string, nodes: readonly MentionedTitle[]): MentionedTitle[] {
  return nodes.filter((node) => titleMentioned(prompt, node.title));
}

export function referenceImageNote(matches: readonly MentionedTitle[]): string {
  const lines = ["本轮输入已附上组内图片，顺序与 Image 编号一致："];
  matches.forEach((match, index) => {
    lines.push(`Image ${index + 1}：${match.title}（节点 ${match.nodeId}）`);
  });
  lines.push("这些图片可以直接查看。用户询问画面内容时，按看到的像素描述，不要回答看不到图。");
  return lines.join("\n");
}

function storageKeyOf(asset: { url?: string; metadata?: Record<string, unknown> } | undefined): string | null {
  const key = asset?.metadata?.storageKey;
  if (typeof key === "string" && key.trim().length > 0) return key.trim();
  const url = asset?.url;
  if (typeof url === "string" && url.startsWith("/api/media/")) {
    const rest = url.slice("/api/media/".length).split("?")[0] ?? "";
    return rest.length > 0 ? decodeURIComponent(rest) : null;
  }
  return null;
}

/** 在授权根组内，按原文点名读取最多 4 张图片。读不到或超出大小的跳过，不让这一轮因此失败。 */
export async function loadMentionedReferenceImages(
  canvas: ServerCanvas,
  prompt: string,
  rootGroupId: string,
  read: (storageKey: string) => Promise<{ bytes: Uint8Array; contentType: string }>
): Promise<{ images: AgentImageInput[]; note: string } | undefined> {
  let members: Set<string>;
  try {
    members = canvasGroupMembers(canvas, rootGroupId);
  } catch {
    return undefined;
  }
  const matches = mentionedTitles(prompt, canvas.document.nodes.flatMap((node) => {
    if (node.type !== "image" || !members.has(node.id) || node.id === rootGroupId) return [];
    const title = canvas.nodeData[node.id]?.title;
    return typeof title === "string" && title.trim().length > 0 ? [{ nodeId: node.id, title: title.trim() }] : [];
  })).slice(0, MAX_REFERENCE_IMAGES);

  const images: AgentImageInput[] = [];
  const attached: MentionedTitle[] = [];
  for (const match of matches) {
    const assetId = canvas.nodeData[match.nodeId]?.outputAssetId;
    const asset = typeof assetId === "string" ? canvas.assets.find((entry) => entry.id === assetId) : undefined;
    const storageKey = storageKeyOf(asset);
    if (!storageKey) continue;
    try {
      const file = await read(storageKey);
      if (file.bytes.byteLength === 0 || file.bytes.byteLength > MAX_REFERENCE_BYTES) continue;
      images.push({ bytes: file.bytes, contentType: file.contentType || "image/png" });
      attached.push(match);
    } catch {
      continue;
    }
  }
  if (images.length === 0) return undefined;
  return { images, note: referenceImageNote(attached) };
}
