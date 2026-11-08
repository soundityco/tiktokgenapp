import { describe, expect, it } from "vitest";
import { merge3 } from "@/lib/merge";

const base = { v: 1, rev: 3, currentProjectId: "a", projects: [
  { id: "a", name: "Merci", slides: [{ id: "s1", text: 1 }, { id: "s2", text: 2 }], videos: [{ id: "v1", crop: { start: 10, duration: 20 }, drive: { copy: { id: "c1", to: 33 } } }] },
  { id: "b", name: "Autre", slides: [], videos: [] },
] };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe("merging two devices' edits", () => {
  it("keeps both: a release renamed on the phone, a slide edited on the computer", () => {
    const phone = clone(base); phone.projects[0].name = "Renommée";
    const computer = clone(base); computer.projects[0].slides[1].text = 9;
    const out = merge3(base, computer, phone) as typeof base;
    expect(out.projects[0].name).toBe("Renommée");
    expect(out.projects[0].slides[1].text).toBe(9);
  });
  it("keeps the phone's longer passage and its new copy while the computer changed the style", () => {
    const phone = clone(base); phone.projects[0].videos[0].crop.duration = 40; phone.projects[0].videos[0].drive.copy = { id: "c2", to: 53 };
    const computer = clone(base); (computer.projects[0].videos[0] as Record<string, unknown>).captionMode = "word";
    const out = merge3(base, computer, phone) as typeof base;
    expect(out.projects[0].videos[0].crop.duration).toBe(40);
    expect(out.projects[0].videos[0].drive.copy.id).toBe("c2");
    expect((out.projects[0].videos[0] as Record<string, unknown>).captionMode).toBe("word");
  });
  it("adds on both sides, removes what was removed", () => {
    const phone = clone(base); phone.projects.push({ id: "c", name: "Nouvelle", slides: [], videos: [] });
    const computer = clone(base); computer.projects = computer.projects.filter((p) => p.id !== "b"); computer.projects[0].slides.push({ id: "s3", text: 3 });
    const out = merge3(base, computer, phone) as typeof base;
    expect(out.projects.map((p) => p.id)).toEqual(["a", "c"]);
    expect(out.projects[0].slides.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });
  it("the same thing changed on both: this device's edit wins", () => {
    const phone = clone(base); phone.projects[0].name = "Téléphone";
    const computer = clone(base); computer.projects[0].name = "Ordinateur";
    expect((merge3(base, computer, phone) as typeof base).projects[0].name).toBe("Ordinateur");
  });
  it("a reorder done here only is kept", () => {
    const computer = clone(base); computer.projects[0].slides.reverse();
    const phone = clone(base); phone.projects[1].name = "X";
    const out = merge3(base, computer, phone) as typeof base;
    expect(out.projects[0].slides.map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(out.projects[1].name).toBe("X");
  });
});
