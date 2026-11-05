"use client";
import { ReactNode, useEffect, useRef, useState } from "react";
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

export function NewPoolDialog(p: { kind: "text" | "photos"; onCreate: (name: string, scope: "shared" | "project", kind: "hooks" | "block") => void; onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"shared" | "project">("shared");
  const [kind, setKind] = useState<"hooks" | "block">("hooks");
  const go = () => { if (name.trim()) { p.onCreate(name.trim(), scope, kind); p.onClose(); } };
  return (
    <Modal title={p.kind === "text" ? t("New text list") : t("New photo list")} onClose={p.onClose}>
      <label className="field">{t("Name")}
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      {p.kind === "text" && (
        <label className="field">{t("Type")}
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "hooks" | "block")}>
            <option value="hooks">{t("One text per line")}</option>
            <option value="block">{t("Lyrics block")}</option>
          </select>
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
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as "shared" | "project")}>
        <option value="shared">{t("All projects")}</option>
        <option value="project">{t("This project only")}</option>
      </select>
    </label>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

/** Small popover menu that closes on outside click / Escape. */
export function Menu({ trigger, children, left }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; left?: boolean }) {
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
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className={"menu" + (left ? " left" : "")} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/**
 * A panel that folds. With `id`, whether it is open is remembered on this device (`open`: the first time).
 */
export function Section({ title, children, open = true, id }: { title: string; children: ReactNode; open?: boolean; id?: string }) {
  const key = id ? `tktgen-sec:${id}` : null;
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
        style={{ "--fill": `${((p.value - p.min) / Math.max(1e-9, p.max - p.min)) * 100}%` } as React.CSSProperties} />
    </label>
  );
}
