import { describe, expect, it } from "vitest";
import { defaultWorkspace, isLineList, normalizeWorkspace, textRoles } from "@/lib/defaults";
import type { TextPool, Workspace } from "@/lib/types";

const pool = (name: string, kind: TextPool["kind"] = "hooks"): TextPool => ({ id: name, name, scope: "shared", kind, text: "" });

describe("text list roles", () => {
  it("makes transitions and the later slides' default lists texts, keeps the rest", () => {
    const out = textRoles([pool("Hooks"), pool("Transitions"), pool("Mes transitions FR"), pool("Slide 1 text"), pool("Slide 2 text"), pool("Légendes", "captions"), pool("Bloc", "block")]);
    expect(out.map((p) => p.kind)).toEqual(["hooks", "texts", "texts", "hooks", "texts", "captions", "block"]);
  });
  it("runs once: a list put back to hooks by hand stays a hook list", () => {
    const ws: Workspace = { ...defaultWorkspace(), textPools: [pool("Transitions")], textRolesV1: undefined };
    const once = normalizeWorkspace(ws);
    expect(once.textPools[0].kind).toBe("texts");
    expect(once.textRolesV1).toBe(true);
    const fixed = { ...once, textPools: [{ ...once.textPools[0], kind: "hooks" as const }] };
    expect(normalizeWorkspace(fixed).textPools[0].kind).toBe("hooks");
  });
  it("new workspaces: slide 1 draws hooks, the next slides texts", () => {
    const ws = defaultWorkspace();
    expect(ws.textPools.map((p) => p.kind)).toEqual(["hooks", "texts"]);
    expect(ws.textRolesV1).toBe(true);
  });
  it("hooks and texts are both one-per-line lists", () => {
    expect([pool("a"), pool("b", "texts"), pool("c", "captions"), pool("d", "block")].map(isLineList)).toEqual([true, true, false, false]);
  });
});
