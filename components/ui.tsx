"use client";
import { ReactNode, useEffect, useRef, useState } from "react";

const stack: symbol[] = [];

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    // Escape only closes the topmost dialog.
    const token = Symbol();
    stack.push(token);
    const k = (e: KeyboardEvent) => e.key === "Escape" && stack[stack.length - 1] === token && closeRef.current();
    window.addEventListener("keydown", k);
    return () => { window.removeEventListener("keydown", k); stack.splice(stack.indexOf(token), 1); };
  }, []);
  return (
    <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"modal" + (wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog(p: { title: string; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <p style={{ margin: 0 }}>{p.message}</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={p.onClose}>Cancel</button>
        <button className="btn red" onClick={() => { p.onConfirm(); p.onClose(); }}>{p.confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function PromptDialog(p: { title: string; label: string; initial?: string; confirmLabel: string; onSubmit: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(p.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const go = () => { if (v.trim()) { p.onSubmit(v.trim()); p.onClose(); } };
  return (
    <Modal title={p.title} onClose={p.onClose}>
      <label className="f">{p.label}
        <input ref={ref} className="input" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={p.onClose}>Cancel</button>
        <button className="btn red" onClick={go} disabled={!v.trim()}>{p.confirmLabel}</button>
      </div>
    </Modal>
  );
}

export function NewPoolDialog(p: { tab: "text" | "pics"; onCreate: (name: string, scope: "shared" | "project", kind: "hooks" | "block") => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"shared" | "project">("shared");
  const [kind, setKind] = useState<"hooks" | "block">("hooks");
  const go = () => { if (name.trim()) { p.onCreate(name.trim(), scope, kind); p.onClose(); } };
  return (
    <Modal title={p.tab === "text" ? "New text pool" : "New picture pool"} onClose={p.onClose}>
      <label className="f">Name
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </label>
      {p.tab === "text" && (
        <label className="f">Kind
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "hooks" | "block")}>
            <option value="hooks">One text per line</option>
            <option value="block">Lyrics block</option>
          </select>
        </label>
      )}
      <label className="f">Scope
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value as "shared" | "project")}>
          <option value="shared">Shared by all projects</option>
          <option value="project">Only this project</option>
        </select>
      </label>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn" onClick={p.onClose}>Cancel</button>
        <button className="btn red" onClick={go} disabled={!name.trim()}>Create</button>
      </div>
    </Modal>
  );
}

export function Toast({ msg }: { msg: string | null }) {
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
