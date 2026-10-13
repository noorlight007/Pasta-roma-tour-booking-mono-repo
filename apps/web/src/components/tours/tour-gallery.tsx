'use client';

import * as React from 'react';

import { Thumbnail } from '@pasta/ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface GalleryImage {
  url: string;
  alt?: string | null;
}

/**
 * The tour's photographs: a lead image with three tiles beneath it, each of
 * which opens a full-screen viewer over the *whole* gallery, not just the four
 * that fit on the page. Arrow keys / swipe-free buttons move between photos,
 * Escape closes.
 *
 * The viewer is a native <dialog> opened with showModal(), so focus trapping,
 * the backdrop, Escape and restoring focus to the tile come from the browser.
 */
export function TourGallery({
  title,
  images,
  fallbackCover,
}: {
  title: string;
  /** Cover first, then the rest in display order. */
  images: GalleryImage[];
  fallbackCover?: string | null;
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const [index, setIndex] = React.useState(0);
  const count = images.length;

  const open = (i: number) => {
    setIndex(i);
    dialogRef.current?.showModal();
  };
  const step = React.useCallback(
    (delta: number) => setIndex((i) => (i + delta + count) % count),
    [count],
  );

  const touchStartX = React.useRef<number | null>(null);
  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touchStartX.current;
    touchStartX.current = null;
    if (start === null) return;
    const delta = (event.changedTouches[0]?.clientX ?? start) - start;
    if (Math.abs(delta) > 50) step(delta < 0 ? 1 : -1);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowRight') step(1);
    if (event.key === 'ArrowLeft') step(-1);
  };

  const lead = images[0];
  const tiles = images.slice(1, 4);
  const hidden = count - 4;

  const tileButton =
    'focus-visible:outline-ring block w-full cursor-zoom-in overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2';
  const navButton =
    'absolute top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-white';

  return (
    <div className="flex flex-col gap-3">
      {lead ? (
        <button
          type="button"
          onClick={() => open(0)}
          aria-label={`View all ${count} photos of ${title}`}
          className={`${tileButton} rounded-card`}
        >
          <Thumbnail
            src={lead.url}
            alt={`${title} — main photograph`}
            className="rounded-card aspect-[16/9] w-full"
          />
        </button>
      ) : (
        <Thumbnail
          src={fallbackCover ?? undefined}
          alt={`${title} — main photograph`}
          className="rounded-card aspect-[16/9] w-full"
        />
      )}

      {tiles.length > 0 ? (
        <div className="grid grid-cols-3 gap-3">
          {tiles.map((image, i) => (
            <button
              key={image.url}
              type="button"
              onClick={() => open(i + 1)}
              aria-label={`Open photo ${i + 2} of ${count}`}
              className={`${tileButton} rounded-card relative`}
            >
              <Thumbnail
                src={image.url}
                alt={image.alt ?? title}
                className="rounded-card aspect-[16/10] w-full"
              />
              {i === tiles.length - 1 && hidden > 0 ? (
                <span className="rounded-card absolute inset-0 flex items-center justify-center bg-black/50 text-lg font-semibold text-white">
                  +{hidden}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <dialog
        ref={dialogRef}
        aria-label={`${title} photo gallery`}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          // A click on the backdrop (the dialog element itself) closes it.
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
        className="fixed inset-0 m-0 h-dvh max-h-none w-dvw max-w-none bg-black/95 p-0 text-white backdrop:bg-black"
      >
        {images[index] ? (
          <div
            className="relative flex h-full w-full items-center justify-center"
            onTouchStart={(event) => (touchStartX.current = event.touches[0]?.clientX ?? null)}
            onTouchEnd={onTouchEnd}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={images[index].url}
              alt={images[index].alt ?? title}
              className="max-h-[calc(100dvh-6rem)] max-w-[calc(100vw-2rem)] object-contain sm:max-w-[calc(100vw-9rem)]"
            />

            <button
              type="button"
              aria-label="Close gallery"
              onClick={() => dialogRef.current?.close()}
              className="absolute right-4 top-4 flex size-11 items-center justify-center rounded-full bg-white/15 hover:bg-white/30 focus-visible:outline-2 focus-visible:outline-white"
            >
              <X className="size-6" aria-hidden />
            </button>

            {count > 1 ? (
              <>
                <button
                  type="button"
                  aria-label="Previous photo"
                  onClick={() => step(-1)}
                  className={`${navButton} left-3 sm:left-5`}
                >
                  <ChevronLeft className="size-6" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label="Next photo"
                  onClick={() => step(1)}
                  className={`${navButton} right-3 sm:right-5`}
                >
                  <ChevronRight className="size-6" aria-hidden />
                </button>
              </>
            ) : null}

            <p
              className="absolute bottom-4 left-1/2 -translate-x-1/2 text-sm text-white/80"
              aria-live="polite"
            >
              {index + 1} / {count}
            </p>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
