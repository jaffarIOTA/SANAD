'use client';

/**
 * The document viewer. Loads the Web SDK from this origin (assets copied by
 * scripts/nutrient-assets.mjs) and opens one document fetched from this
 * origin. The licence key, when present, is domain-bound configuration; no
 * other credential reaches this component.
 */

import { useEffect, useRef, useState } from 'react';

export function Viewer({
  documentUrl,
  licenseKey,
  arabic,
}: {
  readonly documentUrl: string;
  readonly licenseKey?: string;
  readonly arabic: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [detail, setDetail] = useState('');

  useEffect(() => {
    const node = container.current;
    if (node === null) return;
    let unloaded = false;
    let sdk: { unload(target: HTMLElement): void } | undefined;
    (async () => {
      try {
        const mod = await import('@nutrient-sdk/viewer');
        const NutrientViewer = mod.default;
        const configuration = {
          container: node,
          document: documentUrl,
          baseUrl: `${window.location.origin}/nutrient/`,
          locale: arabic ? 'ar' : 'en',
          ...(licenseKey === undefined ? {} : { licenseKey }),
        };
        // The WebAssembly artefacts compile once per page; starting early keeps the first document from waiting on them.
        NutrientViewer.preloadWorker(configuration);
        await NutrientViewer.load(configuration);
        sdk = NutrientViewer;
        if (!unloaded) setState('ready');
      } catch (error) {
        if (unloaded) return;
        setState('failed');
        // The vendor's message names the cause (an expired or domain-bound licence, a bad document); it is operational text, not a secret.
        setDetail(error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 240) : 'unknown');
      }
    })();
    return () => {
      unloaded = true;
      try {
        sdk?.unload(node);
      } catch {
        /* already gone */
      }
    };
  }, [documentUrl, licenseKey, arabic]);

  return (
    <div className="relative">
      <div
        ref={container}
        className="h-[75vh] min-h-[480px] w-full overflow-hidden rounded-tile border border-line-strong bg-sunken"
      />
      {state !== 'ready' ? (
        <p role="status" className="mt-3 text-[14px] text-ink-quiet">
          {state === 'loading'
            ? arabic
              ? 'جارٍ تحميل العارض…'
              : 'Loading the viewer…'
            : arabic
              ? `تعذّر تحميل العارض: ${detail}`
              : `The viewer could not load: ${detail}`}
        </p>
      ) : null}
    </div>
  );
}
