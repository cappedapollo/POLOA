import { GaugeIcon, MoonIcon, SlidersVerticalIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MasterStudio, type MasterStudioHandle } from "@/components/mastering/master-studio";
import { MixStudio } from "@/components/mixing/mix-studio";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const MODE_KEY = "poloa.mode";
type Mode = "mix" | "master";
const loadMode = (): Mode => (localStorage.getItem(MODE_KEY) === "mix" ? "mix" : "master");

/** The two desks, one on screen at a time: mixing stems, then mastering the bounce. */
export function App() {
  const { theme, setTheme } = useTheme();
  const [mode, setMode] = useState<Mode>(loadMode);
  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode]);
  /** Bumped for a new master: the mastering desk mounts afresh once its saved session is cleared. */
  const [masterKey, setMasterKey] = useState(0);
  const newMaster = useCallback(() => setMasterKey((value) => value + 1), []);
  const master = useRef<MasterStudioHandle>(null);
  const bounceToMaster = useCallback((file: File) => {
    master.current?.load(file);
    setMode("master");
  }, []);

  const dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  return (
    <div className="relative flex min-h-svh flex-col gap-3 bg-background p-3 text-foreground">
      <header className="flex flex-wrap items-center gap-2">
        <div className="me-2 flex items-baseline gap-2">
          <h1 className="font-semibold text-lg tracking-tight">POLOA</h1>
          <span className="text-muted-foreground text-xs">{mode === "mix" ? "Multitrack mixing desk" : "Stereo mastering desk"}</span>
        </div>
        <ToggleGroup
          aria-label="Desk"
          onValueChange={(value: string[]) => {
            const next = value[0];
            if (next === "mix" || next === "master") {
              setMode(next);
            }
          }}
          size="sm"
          spacing={0}
          value={[mode]}
          variant="outline"
        >
          <ToggleGroupItem value="mix">
            <SlidersVerticalIcon />
            Mix
          </ToggleGroupItem>
          <ToggleGroupItem value="master">
            <GaugeIcon />
            Master
          </ToggleGroupItem>
        </ToggleGroup>
        <Button
          aria-label="Toggle dark mode"
          className="ms-auto"
          onClick={() => setTheme(dark ? "light" : "dark")}
          size="icon-sm"
          variant="ghost"
        >
          {dark ? <SunIcon /> : <MoonIcon />}
        </Button>
      </header>

      <div className={mode === "mix" ? "contents" : "hidden"}>
        <MixStudio active={mode === "mix"} onBounce={bounceToMaster} />
      </div>
      <MasterStudio active={mode === "master"} key={masterKey} onNewMaster={newMaster} ref={master} />
    </div>
  );
}

export default App;
