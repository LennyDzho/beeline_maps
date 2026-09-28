"use client";

import MaterialIcon from "./material-icon";

type PaginationProps = {
  page: number;
  pageCount: number;
  pageSize: number;
  totalItems: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
};

type PageToken = number | `ellipsis-${number}`;

export default function Pagination({ page, pageCount, pageSize, totalItems, itemLabel, onPageChange, onPageSizeChange }: PaginationProps) {
  const start = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);
  const tokens = getPageTokens(page, pageCount);

  return (
    <>
      <span className="pagination-summary" aria-live="polite">Показано {start}-{end} из {totalItems} {itemLabel}</span>
      {onPageSizeChange && <label className="pagination-page-size">Строк на странице<select value={pageSize} onChange={event => onPageSizeChange(Number(event.target.value))}>{[10, 20, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>}
      <nav className="pagination-controls" aria-label={`Страницы списка: ${itemLabel}`}>
        <button type="button" aria-label="Предыдущая страница" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><MaterialIcon name="chevron_left" /></button>
        {tokens.map((token) => typeof token === "number"
          ? <button className={token === page ? "active current-page" : ""} type="button" aria-label={`Страница ${token}`} aria-current={token === page ? "page" : undefined} disabled={token === page} onClick={() => onPageChange(token)} key={token}>{token}</button>
          : <span className="pagination-ellipsis" aria-hidden="true" key={token}>…</span>)}
        <button type="button" aria-label="Следующая страница" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}><MaterialIcon name="chevron_right" /></button>
      </nav>
    </>
  );
}

function getPageTokens(page: number, pageCount: number): PageToken[] {
  if (pageCount <= 5) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const visiblePages = [...new Set([1, page - 1, page, page + 1, pageCount].filter((value) => value >= 1 && value <= pageCount))].sort((left, right) => left - right);
  const tokens: PageToken[] = [];
  visiblePages.forEach((value, index) => {
    const previous = visiblePages[index - 1];
    if (previous !== undefined && value - previous > 1) tokens.push(`ellipsis-${previous}`);
    tokens.push(value);
  });
  return tokens;
}
