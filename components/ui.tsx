"use client";
import { Children, type CSSProperties, Fragment, isValidElement, ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "@/lib/i18n";

const stack: symbol[] = [];

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Escape only closes the topmost dialog, and Tab stays inside it.
    const token = Symbol();
    stack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusables = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []).filter((el) => el.offsetParent !== null);
    const first = focusables()[0];
    (first ?? dialog)?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack[stack.length - 1] === token) {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || stack[stack.length - 1] !== token) return;
      const items = focusables();
      if (!items.length) { e.preventDefault(); dialog?.focus(); return; }
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? items[at <= 0 ? items.length - 1 : at - 1]
        : items[at === -1 || at === items.length - 1 ? 0 : at + 1];
      e.preventDefault();
      next.focus();
    };
    window.addEventListener("keydown", k);
    return () => {
      window.removeEventListener("keydown", k);
      stack.splice(stack.indexOf(token), 1);
      previous?.focus?.();
    };
  }, []);
  return (
    <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} tabIndex={-1} className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="title">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog(p: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void }) {
  const { t } = useT();
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <p>{p.message}</p>
      <div className="modal-foot">
        <button className="btn" onClick={p.onClose}>{t("Cancel")}</button>
        <button className="btn primary" onClick={() => { p.onConfirm(); p.onClose(); }}>{p.confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function PromptDialog(p: { title: string; label: string; initial?: string; confirmLabel: string; onSubmit: (v: string) => void; onClose: () => void }) {
  const { t } = useT();
  const [v, setV] = useState(p.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const go = () => { if (v.trim()) { p.onSubmit(v.trim()); p.onClose(); } };
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <label className="field">{p.label}
        <input ref={ref} className="input" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      <div className="modal-foot">
        <button className="btn" onClick={p.onClose}>{t("Cancel")}</button>
        <button className="btn primary" onClick={go} disabled={!v.trim()}>{p.confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function NewPoolDialog(p: { kind: "text" | "photos"; textKind?: "hooks" | "block" | "captions"; onCreate: (name: string, scope: "shared" | "project", kind: "hooks" | "block" | "captions") => void; onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"shared" | "project">("shared");
  const [kind, setKind] = useState<"hooks" | "block" | "captions">(p.textKind ?? "hooks");
  const go = () => { if (name.trim()) { p.onCreate(name.trim(), scope, kind); p.onClose(); } };
  return (
    <Modal title={p.kind === "text" ? t("New text list") : t("New photo list")} onClose={p.onClose}>
      <label className="field">{t("Name")}
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      {p.kind === "text" && (
        <label className="field">{t("Type")}
          <Select className="input" value={kind} onChange={(e) => setKind(e.target.value as "hooks" | "block" | "captions")}>
            <option value="hooks">{t("One text per line")}</option>
            <option value="captions">{t("Post captions (with hashtags)")}</option>
          </Select>
        </label>
      )}
      <ScopeSelect value={scope} onChange={setScope} />
      <div className="modal-foot">
        <button className="btn" onClick={p.onClose}>{t("Cancel")}</button>
        <button className="btn primary" onClick={go} disabled={!name.trim()}>{t("Create")}</button>
      </div>
    </Modal>
  );
}

export function ScopeSelect({ value, onChange }: { value: "shared" | "project"; onChange: (v: "shared" | "project") => void }) {
  const { t } = useT();
  return (
    <label className="field">{t("Available in")}
      <Select className="input" value={value} onChange={(e) => onChange(e.target.value as "shared" | "project")}>
        <option value="shared">{t("All projects")}</option>
        <option value="project">{t("This project only")}</option>
      </Select>
    </label>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

/** Small popover menu that closes on outside click / Escape. */
export function Menu({ trigger, children, left, float }: {
  trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; left?: boolean;
  /** Placed on the screen, not in its column: it can spill over the next column (side panels hide what overflows). */
  float?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]);
  // Opens on the side where it fits: inside the column it is in (the slides never spill over the side panels),
  // and upwards near the bottom of the screen.
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: boolean; up: boolean } | null>(null);
  const [fixed, setFixed] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPlace(null); setFixed(null); return; }
    const m = menu.current;
    if (!m) return;
    const r = m.getBoundingClientRect();
    if (float) {
      // From the button: below it (above near the bottom), its right edge on the button's, kept on screen.
      const b = ref.current!.getBoundingClientRect();
      const up = b.bottom + 6 + r.height > window.innerHeight - 8 && b.top - r.height > 60;
      const x = Math.min(window.innerWidth - 8 - r.width, Math.max(8, left ? b.left : b.right - r.width));
      setFixed({ position: "fixed", left: x, right: "auto", top: up ? b.top - 6 - r.height : b.bottom + 6, bottom: "auto" });
      setPlace({ left: false, up: false });
      return;
    }
    const area = (ref.current?.closest(".col, .video-side, .video-stage, [data-menu-bounds]") as HTMLElement | null)?.getBoundingClientRect();
    const lo = Math.max(8, area?.left ?? 0), hi = Math.min(window.innerWidth - 8, area?.right ?? window.innerWidth);
    let l = !!left;
    if (!l && r.left < lo) l = true; // spills out on the left: open to the right instead
    else if (l && r.right > hi) l = false;
    setPlace({ left: l, up: r.bottom > window.innerHeight - 8 && r.top - r.height > 60 });
  }, [open, left, float]);
  // A floating menu stays where it was put: it closes when the page moves under it.
  useEffect(() => {
    if (!open || !float) return;
    const shut = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("scroll", shut, true);
    window.addEventListener("resize", shut);
    return () => { window.removeEventListener("scroll", shut, true); window.removeEventListener("resize", shut); };
  }, [open, float]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div ref={menu} role="menu"
          className={"menu" + ((place ? place.left : left) ? " left" : "") + (place?.up ? " up" : "")}
          // Measured first, hidden: a floating one at its own width (".menu" sets right: 0, which would stretch it).
          style={place ? (fixed ?? undefined) : { visibility: "hidden", ...(float ? { position: "fixed", top: 0, left: 0, right: "auto", bottom: "auto" } : null) }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/**
 * A panel that folds. With `id`, whether it is open is remembered on this device (`open`: the first time).
 */
export function Section({ title, children, open = false, id }: { title: ReactNode; children: ReactNode; open?: boolean; id?: string }) {
  // "sec2": the panels became closed by default; what was remembered before is dropped once.
  const key = id ? `tktgen-sec2:${id}` : null;
  const [shown] = useState(() => {
    if (!key) return open;
    try { const v = localStorage.getItem(key); return v === null ? open : v === "1"; } catch { return open; }
  });
  return (
    <details className="sec" open={shown}
      onToggle={(e) => { if (key) try { localStorage.setItem(key, (e.currentTarget as HTMLDetailsElement).open ? "1" : "0"); } catch { /* private mode */ } }}>
      <summary>{title}</summary>
      <div className="body">{children}</div>
    </details>
  );
}

/** Slider. With `onReset`, a double-click on the value (or the slider) puts the default value back. */
export function Range(p: { label: string; value: number; display?: string; min: number; max: number; step?: number; onReset?: () => void; onChange: (v: number) => void }) {
  const { t } = useT();
  const back = p.onReset;
  const hint = back ? t("Double-click to reset") : undefined;
  return (
    <label className="field">
      <span>{p.label}<span className={"val" + (back ? " resettable" : "")} title={hint} onDoubleClick={back}>{p.display ?? p.value}</span></span>
      <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={p.value} onChange={(e) => p.onChange(+e.target.value)} onDoubleClick={back} title={hint}
        style={{ "--fill": `${((p.value - p.min) / Math.max(1e-9, p.max - p.min)) * 100}%` } as CSSProperties} />
    </label>
  );
}

/**
 * Horizontal wheel, like the photo editors of phones: drag it left or right, the value under the centre mark
 * changes. Stops at 0 on the way; double-click (or Home) puts it back to 0; arrows move by 1, Shift + arrows by 10.
 */
export function Wheel({ value, min, max, label, onChange }: { value: number; min: number; max: number; label: string; onChange: (v: number) => void }) {
  const PX = 4; // pixels of drag per unit
  const drag = useRef<{ x: number; v: number; last: number } | null>(null);
  const set = (v: number) => onChange(Math.round(Math.max(min, Math.min(max, v))));
  return (
    <div className="wheel" role="slider" tabIndex={0} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={value}
      style={{ backgroundPositionX: `${-value * PX}px` }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, v: value, last: value }; }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // Like a phone wheel: push the ticks to the left to go up, to the right to go down.
        let v = Math.round(d.v - (e.clientX - d.x) / PX);
        // A small notch at 0: passing over it stops there for a moment.
        if ((d.last > 0 && v < 0) || (d.last < 0 && v > 0) || Math.abs(v) <= 1) { if (Math.abs(v) <= 4) v = 0; }
        d.last = v;
        set(v);
      }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onDoubleClick={() => set(0)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); set(value + step); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); set(value - step); }
        else if (e.key === "Home") { e.preventDefault(); set(0); }
      }}>
      <span className="wheel-mark" aria-hidden />
    </div>
  );
}

/** A small ⓘ: the explanation shows on hover (or focus), instead of a sentence always on screen. */
export function Hint({ text }: { text: string }) {
  // An <i>, not a <span>: layout rules written for the spans around it never reach it.
  return <i className="hint" tabIndex={0} role="note" aria-label={text} title={text}>i</i>;
}

// ---------- Select: the app's own drop-down (not the browser's), written like a <Select> ----------

type SelOpt = { value: string; label: ReactNode; text: string; disabled?: boolean; group?: string };
const textOf = (n: ReactNode): string =>
  n == null || typeof n === "boolean" ? "" : typeof n === "string" || typeof n === "number" ? String(n)
    : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: ReactNode }).children) : "";
/** The <option>s and <optgroup>s written inside, read as a list (conditions and maps included). */
function readOptions(children: ReactNode, group?: string): SelOpt[] {
  const out: SelOpt[] = [];
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return;
    const p = c.props as { value?: string | number; children?: ReactNode; disabled?: boolean; label?: string };
    if (c.type === "option") out.push({ value: String(p.value ?? textOf(p.children)), label: p.children, text: textOf(p.children), disabled: p.disabled, group });
    else if (c.type === "optgroup") out.push(...readOptions(p.children, p.label));
    else if (c.type === Fragment) out.push(...readOptions(p.children, group));
  });
  return out;
}

/**
 * A drop-down drawn in the app's style. Used exactly like a <Select>: same `value`, same `onChange(e)` reading
 * `e.target.value`, same <option> / <optgroup> children. The list floats over everything (above when there is
 * no room below), with the keyboard: arrows, Enter, Escape, and the first letters of an option.
 */
export function Select({ value, onChange, children, className = "input", style, disabled, title, id, onClick, ...aria }: {
  value?: string | number;
  onChange?: (e: { target: { value: string }; currentTarget: { value: string } }) => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
  title?: string;
  id?: string;
  onClick?: (e: React.MouseEvent) => void;
  "aria-label"?: string;
}) {
  const opts = readOptions(children);
  const cur = String(value ?? "");
  const selected = opts.findIndex((o) => o.value === cur);
  const shown = opts[selected >= 0 ? selected : 0];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef({ s: "", at: 0 });

  const choose = (i: number) => {
    const o = opts[i];
    if (!o || o.disabled) return;
    setOpen(false);
    btn.current?.focus();
    if (o.value !== cur) onChange?.({ target: { value: o.value }, currentTarget: { value: o.value } });
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let k = 1; k <= opts.length; k++) {
      const i = (from + dir * k + opts.length * 2) % opts.length;
      if (!opts[i].disabled) return i;
    }
    return from;
  };
  const show = () => { if (disabled || !opts.length) return; setActive(selected >= 0 ? selected : step(-1, 1)); setOpen(true); };

  // Placed on the screen under the button (above when there is no room), as wide as it at least.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const b = btn.current!.getBoundingClientRect();
    const h = Math.min(320, list.current?.scrollHeight ?? 320);
    const below = window.innerHeight - b.bottom - 8, above = b.top - 8;
    const up = below < Math.min(h, 200) && above > below;
    const maxH = Math.max(120, Math.min(320, up ? above - 6 : below - 6));
    const width = Math.max(b.width, 160);
    const left = Math.min(Math.max(8, b.left), window.innerWidth - 8 - width);
    setPos(up ? { left, minWidth: width, bottom: window.innerHeight - b.top + 4, maxHeight: maxH } : { left, minWidth: width, top: b.bottom + 4, maxHeight: maxH });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false); };
    const away = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(false); };
    // Escape closes the list only (not the dialog it is in).
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); e.preventDefault(); setOpen(false); btn.current?.focus(); } };
    document.addEventListener("mousedown", out);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", out); window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); window.removeEventListener("keydown", esc, true); };
  }, [open]);
  useEffect(() => { if (open && active >= 0) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    let used = true;
    if (!open && (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ")) show();
    else if (open && k === "ArrowDown") setActive((a) => step(a, 1));
    else if (open && k === "ArrowUp") setActive((a) => step(a, -1));
    else if (open && (k === "Enter" || k === " ")) choose(active);
    else if (open && k === "Home") setActive(step(-1, 1));
    else if (open && k === "End") setActive(step(opts.length, -1));
    else if (open && k === "Tab") { setOpen(false); used = false; }
    else if (k.length === 1 && /\S/.test(k)) {
      // Typing the first letters goes to the option that starts with them.
      const now = Date.now();
      typed.current = { s: (now - typed.current.at < 700 ? typed.current.s : "") + k.toLowerCase(), at: now };
      const i = opts.findIndex((o) => !o.disabled && o.text.trim().toLowerCase().startsWith(typed.current.s));
      if (i >= 0) { if (open) setActive(i); else if (opts[i].value !== cur) onChange?.({ target: { value: opts[i].value }, currentTarget: { value: opts[i].value } }); }
    } else used = false;
    // Handled here: the shortcuts of the studios (Space, arrows) do not get it.
    if (used) { e.preventDefault(); e.stopPropagation(); }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button ref={btn} type="button" id={id} className={className + " dd" + (open ? " open" : "")} style={style} disabled={disabled} title={title ?? shown?.text}
        aria-haspopup="listbox" aria-expanded={open} aria-label={aria["aria-label"]}
        onClick={(e) => { onClick?.(e); if (open) setOpen(false); else show(); }} onKeyDown={onKey}>
        <span className="dd-value">{shown?.label ?? ""}</span>
        <svg className="dd-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && createPortal(
        <div ref={list} className="dd-list" role="listbox" aria-label={aria["aria-label"]} style={pos ?? { visibility: "hidden", top: 0, left: 0 }}
          onMouseDown={(e) => e.preventDefault() /* the button keeps the focus */}>
          {opts.map((o, i) => {
            const head = o.group !== lastGroup && o.group ? <div className="dd-group" key={"g" + i}>{o.group}</div> : null;
            lastGroup = o.group;
            return (
              <Fragment key={i}>
                {head}
                <div data-i={i} role="option" aria-selected={i === selected} aria-disabled={o.disabled || undefined}
                  className={"dd-opt" + (i === active ? " active" : "") + (i === selected ? " on" : "") + (o.disabled ? " off" : "")}
                  onMouseEnter={() => !o.disabled && setActive(i)} onClick={() => choose(i)}>
                  <span className="dd-check" aria-hidden="true">{i === selected ? "✓" : ""}</span>
                  <span className="dd-text">{o.label}</span>
                </div>
              </Fragment>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
