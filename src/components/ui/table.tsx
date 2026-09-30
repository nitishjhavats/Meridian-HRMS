import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Table primitives for desktop.
 *
 * On mobile these are not shrunk — screens render a card list instead. A
 * horizontally scrolling table on a phone is technically responsive and
 * practically unusable.
 */

export function TableWrap({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-x-auto", className)} {...props} />;
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full text-sm", className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn("border-b border-border text-left text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border", className)} {...props} />;
}

export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("hover:bg-muted/40", className)} {...props} />;
}

export function TH({
  className,
  numeric,
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn("px-4 py-2 font-medium", numeric && "text-right", className)}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td className={cn("px-4 py-2.5", numeric && "tabular text-right", className)} {...props} />
  );
}

/** Renders a table on sm+ and a card list below it. */
export function ResponsiveList<T>({
  items,
  head,
  row,
  card,
  empty,
}: {
  items: T[];
  head: React.ReactNode;
  row: (item: T, index: number) => React.ReactNode;
  card: (item: T, index: number) => React.ReactNode;
  empty: React.ReactNode;
}) {
  if (items.length === 0) return <>{empty}</>;

  return (
    <>
      <TableWrap className="hidden sm:block">
        <Table>
          <THead>
            <tr>{head}</tr>
          </THead>
          <TBody>{items.map((item, i) => row(item, i))}</TBody>
        </Table>
      </TableWrap>
      <ul className="divide-y divide-border sm:hidden">
        {items.map((item, i) => (
          <li key={i} className="px-4 py-3">
            {card(item, i)}
          </li>
        ))}
      </ul>
    </>
  );
}
