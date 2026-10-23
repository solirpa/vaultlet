import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ITEM_HEIGHT, layout, visibleRange, type ListItem } from './sections';

/** Windowed list with fixed per-kind heights (only the visible rows are in the DOM). */
export function VirtualList({
  items,
  render,
  initialScrollTop = 0,
  onScrollTop,
}: {
  items: ListItem[];
  render: (item: ListItem) => React.ReactNode;
  initialScrollTop?: number;
  onScrollTop?: (top: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [height, setHeight] = useState(440);
  const lay = useMemo(() => layout(items), [items]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.clientHeight || 440);
    if (initialScrollTop) el.scrollTop = initialScrollTop;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 440));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [start, end] = visibleRange(lay, scrollTop, height);
  return (
    <div
      ref={ref}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        setScrollTop(top);
        onScrollTop?.(top);
      }}
    >
      <div style={{ height: lay.total + 6, position: 'relative' }}>
        {items.slice(start, end).map((it, i) => (
          <div
            key={it.key}
            style={{ position: 'absolute', top: lay.offsets[start + i], left: 0, right: 0, height: ITEM_HEIGHT[it.kind] }}
          >
            {render(it)}
          </div>
        ))}
      </div>
    </div>
  );
}
