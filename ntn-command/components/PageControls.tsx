import { Suspense } from 'react';
import { ThemeSwitch, DateRange } from './Controls';
import type { Range } from '@/lib/range';

/**
 * The header controls every module carries: date window on the left, theme on
 * the right. Both read the URL, so a link to a module keeps whatever window the
 * sender was looking at.
 *
 * DateRange calls useSearchParams, which needs a Suspense boundary or the whole
 * route opts out of static rendering with a build-time warning.
 */
export default function PageControls({ range, dates = true }: { range?: Range; dates?: boolean }) {
  return (
    <>
      {dates && range && (
        <Suspense fallback={<div className="h-7 w-64 rounded-lg border border-edge" />}>
          <DateRange
            days={range.days}
            from={range.from}
            to={range.to}
            custom={range.custom}
          />
        </Suspense>
      )}
      <ThemeSwitch />
    </>
  );
}
