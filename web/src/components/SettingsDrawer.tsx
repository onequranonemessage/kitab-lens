import { useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { LANGUAGES } from "@/lib/languages"
import type { ResultLayout, Settings } from "@/lib/settings"
import { clearAllEntries } from "@/lib/history"
import { toast } from "sonner"
import { cn } from "@/lib/utils"

interface SettingsDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function SettingsDrawer({ open, onOpenChange, settings, onChange }: SettingsDrawerProps) {
  const [clearing, setClearing] = useState(false)

  async function handleClearHistory() {
    setClearing(true)
    try {
      await clearAllEntries()
      toast.success("History cleared")
    } catch {
      toast.error("Couldn't clear history")
    } finally {
      setClearing(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="flex flex-col gap-6 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
        </SheetHeader>

        <div className="flex flex-col gap-2">
          <Label>Results layout</Label>
          <div className="flex gap-2">
            {(["sheet", "split"] as ResultLayout[]).map((layout) => (
              <button
                key={layout}
                type="button"
                onClick={() => onChange({ layout })}
                className={cn(
                  "flex-1 rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors",
                  settings.layout === layout
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-input text-muted-foreground"
                )}
              >
                {layout === "sheet" ? "Bottom sheet" : "Split"}
              </button>
            ))}
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label htmlFor="default-language">Default language</Label>
          <Select value={settings.defaultLanguage} onValueChange={(v) => onChange({ defaultLanguage: v })}>
            <SelectTrigger id="default-language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label>History</Label>
          <Button variant="destructive" size="sm" className="w-fit" onClick={handleClearHistory} disabled={clearing}>
            Clear history
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
