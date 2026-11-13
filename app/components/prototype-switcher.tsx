// PROTOTYPE — throwaway. Floating variant switcher for UI prototypes.
import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function PrototypeSwitcher({
  variants,
  param = "variant",
  children,
}: {
  variants: { key: string; name: string }[];
  param?: string;
  children?: ReactNode;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const current = searchParams.get(param) ?? variants[0].key;
  const index = Math.max(
    0,
    variants.findIndex((v) => v.key === current)
  );

  function go(delta: number) {
    const next = variants[(index + delta + variants.length) % variants.length];
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set(param, next.key);
        return p;
      },
      { replace: true, preventScrollReset: true }
    );
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (import.meta.env.PROD) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {children}
      <div className="flex items-center gap-2 rounded-full bg-black px-2 py-1.5 text-sm text-white shadow-xl ring-2 ring-fuchsia-500">
        <button
          onClick={() => go(-1)}
          className="rounded-full p-1 hover:bg-white/20"
          title="Previous variant (←)"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="min-w-48 text-center font-mono">
          {variants[index].key} ({variants[index].name})
        </span>
        <button
          onClick={() => go(1)}
          className="rounded-full p-1 hover:bg-white/20"
          title="Next variant (→)"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
