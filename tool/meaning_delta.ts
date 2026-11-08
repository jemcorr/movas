import { buildReport } from "./film.ts";

export type MHit = { msg: string; unvalidated: boolean };

/** The film's meaning-rule misses, list side only: drawn and score facts, no pixels, no sound, no motion. */
export const meaningHits = (o: { s: any; checks: any; rows: Map<number, any[]>; meaning: any; W: number; H: number }): Map<string, MHit> => {
  const out = new Map<string, MHit>();
  buildReport({ ...o, px: null, sections: new Set(["none"]), onHits: (l) => { for (const h of l) out.set(h.key, { msg: h.msg, unvalidated: h.unvalidated }); } });
  return out;
};

/** Lines for a reader and the count of new validated misses. */
export const meaningDelta = (now: Map<string, MHit>, base: Map<string, MHit>): { lines: string[]; newValidated: number } => {
  const added = [...now.keys()].filter((k) => !base.has(k));
  const newV = added.filter((k) => !now.get(k)!.unvalidated).map((k) => now.get(k)!.msg);
  const newU = added.filter((k) => now.get(k)!.unvalidated).map((k) => now.get(k)!.msg);
  const gone = [...base.keys()].filter((k) => !now.has(k)).map((k) => base.get(k)!.msg);
  const known = now.size - added.length;
  const lines = [`meaning rules: ${newV.length} new, ${newU.length} new unvalidated, ${gone.length} gone, ${known} known.`];
  for (const m of newV.slice(0, 10)) lines.push(`NEW rule ${m}`);
  for (const m of newU.slice(0, 10)) lines.push(`NEW warn (unvalidated) ${m}`);
  for (const m of gone.slice(0, 5)) lines.push(`GONE ${m}`);
  return { lines, newValidated: newV.length };
};
