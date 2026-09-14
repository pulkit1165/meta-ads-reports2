'use client';

import { useCallback, useEffect, useState } from 'react';
import { buildXlsx, sheetName, toCell, type Cell, type Sheet } from '@/lib/xlsx';

/**
 * Export every table on the page to one .xlsx, a sheet per table.
 *
 * It reads the rendered DOM rather than re-running the queries. That sounds
 * like a shortcut, but it is the right one here: what lands in the spreadsheet
 * is then exactly what the person was looking at, filters and window included,
 * and a new module gets export for free instead of needing its own endpoint.
 * The cost is that a figure is exported as it was formatted, which is why
 * toCell converts money and percentages back into numbers that Excel can add.
 */

/** Text of a cell, with a space between separate elements so chips do not fuse. */
function cellText(el: Element): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (t.trim()) out.push(t.trim());
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(el);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function tableRows(table: HTMLTableElement): Cell[][] {
  const rows: Cell[][] = [];
  const heads = Array.from(table.querySelectorAll('thead tr'));
  heads.forEach((tr) => {
    rows.push(Array.from(tr.children).map((c) => cellText(c)));
  });
  Array.from(table.querySelectorAll('tbody tr')).forEach((tr) => {
    rows.push(Array.from(tr.children).map((c) => toCell(cellText(c))));
  });
  Array.from(table.querySelectorAll('tfoot tr')).forEach((tr) => {
    rows.push(Array.from(tr.children).map((c) => toCell(cellText(c))));
  });
  return rows;
}

function collect(): Sheet[] {
  const taken = new Set<string>();
  const sheets: Sheet[] = [];
  const tables = Array.from(document.querySelectorAll('main table')) as HTMLTableElement[];
  tables.forEach((t, i) => {
    const rows = tableRows(t);
    if (rows.length < 2) return;
    const card = t.closest('section');
    const title = card?.querySelector('h2')?.textContent?.trim() || `Table ${i + 1}`;
    sheets.push({ name: sheetName(title, taken), rows });
  });
  return sheets;
}

export default function ExportButton() {
  // -1 means "not counted yet". The button renders on the server too, so it is
  // present in the HTML rather than appearing a beat after hydration; the sheet
  // count fills in once the DOM can actually be read.
  const [count, setCount] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    setCount(document.querySelectorAll('main table').length);
  }, []);

  const run = useCallback(() => {
    setBusy(true);
    setNote('');
    try {
      const sheets = collect();
      if (!sheets.length) {
        setNote('nothing to export');
        setTimeout(() => setNote(''), 2500);
        return;
      }

      const title = document.querySelector('main h1')?.textContent?.trim() || 'NTN Command';
      const subtitle = document.querySelector('main h1 + p')?.textContent?.trim() ?? '';
      // A sheet saying where the numbers came from, because a spreadsheet
      // outlives the tab it was exported from.
      sheets.unshift({
        name: sheetName('Report', new Set()),
        rows: [
          ['Report', title],
          ['Scope', subtitle],
          ['Source', window.location.href],
          ['Exported', new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'],
          [],
          ['Sheets', sheets.length],
          ...sheets.map((s) => ['', s.name]),
        ],
      });

      const slug = window.location.pathname.replace(/^\//, '').replace(/\//g, '-') || 'home';
      const stamp = new Date().toISOString().slice(0, 10);
      const url = URL.createObjectURL(buildXlsx(sheets));
      const a = document.createElement('a');
      a.href = url;
      a.download = `ntn-${slug}-${stamp}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } finally {
      setBusy(false);
    }
  }, []);

  if (count === 0) return null;

  return (
    <button
      type="button"
      onClick={run}
      disabled={busy || count === 0}
      title={count > 0
        ? `Download every table on this page as one Excel file — ${count} sheet${count > 1 ? 's' : ''}`
        : 'Download every table on this page as one Excel file'}
      className="rounded-lg border border-edge px-2.5 py-1 text-[12px] text-muted transition hover:border-gold/50 hover:text-gold disabled:opacity-50"
    >
      {busy ? 'Building…' : note || 'Excel'}
      {count > 0 && !note && <span className="ml-1 text-muted/60">{count}</span>}
    </button>
  );
}
