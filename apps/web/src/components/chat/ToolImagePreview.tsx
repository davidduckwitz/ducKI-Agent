import { useState } from "react";
import { Camera, Maximize2, X } from "lucide-react";
import { getBaseUrl } from "../../lib/api";
import type { RenderedChatMessage } from "./chatTypes";

interface ToolImage {
  url: string;
  title?: string;
  caption?: string;
}

/** Tool images carry server paths ("/api/plugins/..."); in desktop/remote mode the API lives on
 *  another origin, so re-root them onto the configured API base instead of the page origin. */
function resolveImageSrc(url: string): string {
  if (url.startsWith("data:")) return url;
  if (url.startsWith("/api/")) return `${getBaseUrl()}${url.slice(4)}`;
  return url;
}

/**
 * Inline image(s) a tool asked to show the user via `display_images` (agent event
 * "tool_image") - e.g. a Home Assistant camera snapshot the user asked for.
 */
export function ToolImagePreview({ msg }: { msg: RenderedChatMessage }) {
  const images = (msg.eventData?.["images"] as ToolImage[] | undefined)?.filter((image) => typeof image?.url === "string") ?? [];
  const [lightbox, setLightbox] = useState<ToolImage | null>(null);
  if (images.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {images.map((image, index) => (
          <figure
            key={`${image.url}-${index}`}
            className="group relative w-full max-w-md overflow-hidden rounded-2xl border border-border bg-black/40 shadow-lg"
          >
            <button type="button" onClick={() => setLightbox(image)} className="block w-full" title="Vergrößern">
              <img
                src={resolveImageSrc(image.url)}
                alt={image.title ?? "Bild"}
                loading="lazy"
                className="aspect-video w-full object-cover transition duration-300 group-hover:scale-[1.02]"
              />
            </button>
            <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6 text-xs text-white">
              <Camera className="h-3.5 w-3.5 shrink-0 opacity-80" />
              <span className="truncate font-medium">{image.caption ?? image.title ?? "Bild"}</span>
              <Maximize2 className="ml-auto h-3.5 w-3.5 shrink-0 opacity-0 transition group-hover:opacity-80" />
            </figcaption>
          </figure>
        ))}
      </div>
      {lightbox && (
        <div
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 p-4 backdrop-blur-sm"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-label={lightbox.title ?? "Bild"}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
            onClick={() => setLightbox(null)}
            aria-label="Schließen"
          >
            <X className="h-5 w-5" />
          </button>
          <figure className="max-h-full max-w-6xl" onClick={(e) => e.stopPropagation()}>
            <img src={resolveImageSrc(lightbox.url)} alt={lightbox.title ?? "Bild"} className="max-h-[85vh] w-auto rounded-xl" />
            {(lightbox.caption ?? lightbox.title) && (
              <figcaption className="mt-2 text-center text-sm text-white/80">{lightbox.caption ?? lightbox.title}</figcaption>
            )}
          </figure>
        </div>
      )}
    </>
  );
}
