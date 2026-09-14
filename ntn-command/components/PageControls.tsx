import { Suspense } from 'react';
import { ThemeSwitch, DateRange, SiteSwitch, DayPicker, RoasFilter } from './Controls';
import type { Range, Scope } from '@/lib/range';

/**
 * The header controls every module carries: website, then date window, then
 * theme. The Excel export lives in the Page shell instead, so a module that
 * renders no controls still has it. All three read the URL, so a link to a module reproduces exactly what
 * the sender was looking at.
 *
 * DateRange and SiteSwitch call useSearchParams, which needs a Suspense
 * boundary or the whole route opts out of static rendering with a build-time
 * warning.
 */
export default function PageControls({
  range, scope, dates = true, sites = true, days, day, today, maxRoas,
}: {
  range?: Range; scope?: Scope; dates?: boolean; sites?: boolean;
  /** Single-day reports pass the selectable days instead of a range. */
  days?: string[]; day?: string; today?: string;
  /** Present on modules that can be narrowed to the weak end of the book. */
  maxRoas?: string;
}) {
  return (
    <>
      {sites && scope && (
        <Suspense fallback={<div className="h-7 w-56 rounded-lg border border-edge" />}>
          <SiteSwitch scope={scope.key} />
        </Suspense>
      )}
      {days && day && (
        <Suspense fallback={<div className="h-7 w-40 rounded-lg border border-edge" />}>
          <DayPicker days={days} value={day} today={today ?? ''} />
        </Suspense>
      )}
      {maxRoas !== undefined && (
        <Suspense fallback={<div className="h-7 w-56 rounded-lg border border-edge" />}>
          <RoasFilter value={maxRoas} />
        </Suspense>
      )}
      {dates && range && (
        <Suspense fallback={<div className="h-7 w-64 rounded-lg border border-edge" />}>
          <DateRange days={range.days} from={range.from} to={range.to} custom={range.custom} />
        </Suspense>
      )}
      <ThemeSwitch />
    </>
  );
}
