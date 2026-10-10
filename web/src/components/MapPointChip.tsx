'use client';

/** Action chip opened by a long press or a right-click. The map stays put. */
export function MapPointChip({
  title,
  detail,
  left,
  top,
  note,
  section,
  onAsk,
  onPlace,
  onSection,
  onCopy,
  onClose,
}: {
  title: string;
  detail: string;
  left: number;
  top: number;
  note: string;
  section: boolean;
  onAsk: () => void;
  onPlace: () => void;
  onSection: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const flipX = left > 62;
  const flipY = top > 58;
  return (
    <div
      data-map-chip
      role="menu"
      aria-label={title}
      className="map-chip"
      style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${flipX ? 'calc(-100% - 8px)' : '8px'}, ${flipY ? 'calc(-100% - 8px)' : '8px'})` }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="map-chip-head">
        <span>
          <strong>{title}</strong>
          {detail ? <span data-point-coords>{detail}</span> : null}
        </span>
        <button type="button" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <button type="button" role="menuitem" data-chip-ask onClick={onAsk}>Ask about here</button>
      <button type="button" role="menuitem" data-chip-place onClick={onPlace}>Set as my place</button>
      {section ? <button type="button" role="menuitem" data-chip-section onClick={onSection}>Section from here</button> : null}
      <button type="button" role="menuitem" data-chip-copy onClick={onCopy}>Copy position</button>
      {note ? <span className="map-chip-note" role="status">{note}</span> : null}
    </div>
  );
}
