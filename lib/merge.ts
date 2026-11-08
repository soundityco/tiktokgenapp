/**
 * Three-way merge of the saved data, for two devices editing at once: `base` is what both started from (the last
 * data this device loaded or saved), `mine` this device's data, `theirs` what the other device saved meanwhile.
 * What only one side changed is kept; what both changed takes this device's (the latest edit here). Lists of
 * things with an `id` (releases, videos, slides, lists, photos…) are merged item by item: added on either side
 * kept, removed on either side removed (unless the other side changed it).
 */
type J = unknown;
const same = (a: J, b: J) => a === b || JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: J): v is Record<string, J> => !!v && typeof v === "object" && !Array.isArray(v);
const withIds = (v: J): v is { id: string }[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObj(x) && typeof x.id === "string");

export function merge3(base: J, mine: J, theirs: J): J {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out: Record<string, J> = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const inM = k in mine, inT = k in theirs, inB = k in b;
      if (inM && inT) out[k] = merge3(b[k], mine[k], theirs[k]);
      else if (inM) { if (!inB || !same(mine[k], b[k])) out[k] = mine[k]; } // removed there, unless changed here
      else if (inT) { if (!inB || !same(theirs[k], b[k])) out[k] = theirs[k]; }
    }
    return out;
  }
  const lists = [base, mine, theirs].filter((v) => Array.isArray(v) && v.length);
  if (Array.isArray(mine) && Array.isArray(theirs) && lists.length && lists.every(withIds)) {
    const byId = (v: J) => new Map((Array.isArray(v) ? (v as { id: string }[]) : []).map((x) => [x.id, x]));
    const B = byId(base), M = byId(mine), T = byId(theirs);
    const out: J[] = [];
    const seen = new Set<string>();
    // Theirs' order, then what was added here.
    for (const id of [...T.keys(), ...M.keys()]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = B.get(id), m = M.get(id), t = T.get(id);
      if (m && t) out.push(merge3(b, m, t));
      else if (m) { if (!b || !same(m, b)) out.push(m); }
      else if (t) { if (!b || !same(t, b)) out.push(t); }
    }
    // This device's order when only it reordered.
    const mineOrder = (mine as { id: string }[]).map((x) => x.id);
    const theirsOrder = (theirs as { id: string }[]).map((x) => x.id);
    const baseOrder = Array.isArray(base) ? (base as { id: string }[]).map((x) => x.id) : [];
    if (!same(mineOrder, baseOrder) && same(theirsOrder, baseOrder)) {
      const rank = new Map(mineOrder.map((id, i) => [id, i]));
      out.sort((a, c) => (rank.get((a as { id: string }).id) ?? 1e9) - (rank.get((c as { id: string }).id) ?? 1e9));
    }
    return out;
  }
  return mine; // both changed a value (or a list without ids): this device's
}
