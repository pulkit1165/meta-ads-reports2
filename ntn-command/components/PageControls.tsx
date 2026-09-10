import { Suspense } from 'react';
import { ThemeSwitch, DateRange, SiteSwitch } from './Controls';
import type { Range, Scope } from '@/lib/range';

/**
 * The header controls every module carries: website, then date window, then
 * theme. All three read the URL, so a link to a module reproduces exactly what
 * the sender was looking at.
 *
 * DateRange and SiteSwitch call useSearchParams, which needs a Suspense
 * boundary or the whole route opts out of static rendering with a build-time
 * warning.
 */
export default function PageControls({
  range, scope, dates = true, sites = true,
}: { range?: Range; scope?: Scope; dates?: boolean; sites?: boolean }) {
  return (
    <>
      {sites && scope && (
        <Suspense fallback={<div className="h-7 w-56 rounded-lg border border-edge" />}>
          <SiteSwitch scope={scope.key} />
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
