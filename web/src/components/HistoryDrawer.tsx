import { useEffect, useState } from "react"
import { Trash2 } from "lucide-react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { deleteEntry, getAllEntries, type HistoryEntry } from "@/lib/history"

interface HistoryDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (entry: HistoryEntry) => void
}

export function HistoryDrawer({ open, onOpenChange, onSelect }: HistoryDrawerProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  useEffect(() => {
    if (!open) return
    getAllEntries()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [open])

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    await deleteEntry(id)
    setEntries((prev) => prev.filter((entry) => entry.id !== id))
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col gap-4 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
        </SheetHeader>

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No scans yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => (
              <div
                key={entry.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(entry)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelect(entry)
                }}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-secondary/40 p-2 text-left transition-colors hover:bg-secondary"
              >
                <img src={entry.thumb} alt="" className="h-14 w-14 shrink-0 rounded-md object-cover" />
                <div className="flex-1 overflow-hidden">
                  <p dir="rtl" lang="ar" className="font-arabic truncate text-sm text-foreground">
                    {entry.arabic}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => handleDelete(entry.id, e)}
                  aria-label="Delete"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
