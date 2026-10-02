// Scan history, persisted in IndexedDB via idb-keyval so it survives page
// reloads (localStorage would be too small for the base64 thumbnails).

import { get, set, del, keys } from "idb-keyval"

export interface HistoryEntry {
  id: string
  createdAt: number
  /** ~400px-wide JPEG data URL, used as a thumbnail in the history drawer. */
  thumb: string
  arabic: string
  translations: Record<string, string>
}

const KEY_PREFIX = "kitab-lens:history:"

function keyFor(id: string): string {
  return `${KEY_PREFIX}${id}`
}

export function newHistoryId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export async function saveEntry(entry: HistoryEntry): Promise<void> {
  await set(keyFor(entry.id), entry)
}

export async function getEntry(id: string): Promise<HistoryEntry | undefined> {
  return get(keyFor(id))
}

/** All entries, newest first. */
export async function getAllEntries(): Promise<HistoryEntry[]> {
  const allKeys = await keys()
  const historyKeys = allKeys.filter(
    (k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX)
  )
  const entries = await Promise.all(historyKeys.map((k) => get<HistoryEntry>(k)))
  return entries
    .filter((e): e is HistoryEntry => !!e)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function deleteEntry(id: string): Promise<void> {
  await del(keyFor(id))
}

export async function clearAllEntries(): Promise<void> {
  const allKeys = await keys()
  const historyKeys = allKeys.filter(
    (k): k is string => typeof k === "string" && k.startsWith(KEY_PREFIX)
  )
  await Promise.all(historyKeys.map((k) => del(k)))
}

/**
 * Downscales a full-res JPEG/PNG data URL (or blob URL) to a ~400px-wide
 * thumbnail JPEG data URL for storage in history.
 */
export async function makeThumbnail(source: Blob, targetWidth = 400): Promise<string> {
  const bitmap = await createImageBitmap(source)
  const scale = targetWidth / bitmap.width
  const width = targetWidth
  const height = Math.round(bitmap.height * scale)

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas 2D context unavailable")
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  return canvas.toDataURL("image/jpeg", 0.8)
}
