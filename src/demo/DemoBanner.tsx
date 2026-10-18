const button = 'min-h-9 pointer-coarse:min-h-11 rounded-lg border border-amber-300 bg-white px-3 py-1.5 font-semibold hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-amber-700';

export function DemoBanner({ onHowItWorks, onExit }: { onHowItWorks: () => void; onExit: () => void }) {
  return (
    <div role="region" aria-label="Demo mode" className="border-b border-amber-200 bg-amber-50 text-body1 text-amber-950">
      <div className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6 lg:px-8">
        <p>Demo: nothing is saved. All data is fictional.</p>
        <div className="flex gap-2">
          <button type="button" onClick={onHowItWorks} className={button}>How this works</button>
          <button type="button" onClick={onExit} className={button}>Exit demo</button>
        </div>
      </div>
    </div>
  );
}
