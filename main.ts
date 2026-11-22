// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does the whole
// of SPEC.md: sections 1 to 4 (the command line, the output and exit codes, safe paths, format detection), section 5
// (three-tier line matching), section 6 (unified diffs), section 7 (SEARCH/REPLACE blocks), section 8 (V4A patches),
// section 9 (JSON edits) and section 10 (order and atomicity). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. `moves` records the (old, new) pairs of move edits that succeeded, so the exit-0 rows can print `R <old> -> <new>` for a move instead of a `D` and an `A` line. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Section 5: three-tier line matching ---

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// A file's lines, its line break, and whether it ends with one. The break is
// CRLF when the first line feed follows a carriage return, else LF; the empty
// piece after a final break is not a line; an empty file has no lines.
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

type Tier = 0 | 1 | 2;
function tiersFor(strict: boolean): Tier[] {
  return strict ? [0] : [0, 1, 2];
}
function matchAtTier(O: string[], F: string[], tier: Tier, i: number): boolean {
  if (i < 0 || i + O.length > F.length) return false;
  for (let k = 0; k < O.length; k++) {
    const o = O[k]!;
    const f = F[i + k]!;
    if (tier === 0) { if (o !== f) return false; }
    else if (tier === 1) { if (stripTrail(o) !== stripTrail(f)) return false; }
    else if (stripBoth(o) !== stripBoth(f)) return false;
  }
  return true;
}
// The first tier at which O occurs in F at least once, and all its occurrences.
function findTier(O: string[], F: string[], strict: boolean): { tier: Tier; occ: number[] } | null {
  for (const t of tiersFor(strict)) {
    const occ: number[] = [];
    for (let i = 0; i + O.length <= F.length; i++) if (matchAtTier(O, F, t, i)) occ.push(i);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
// The first tier at which O occurs at or after `from`, and all such occurrences.
function findTierFrom(O: string[], F: string[], from: number, strict: boolean): { tier: Tier; occ: number[] } | null {
  for (const t of tiersFor(strict)) {
    const occ: number[] = [];
    for (let i = Math.max(0, from); i + O.length <= F.length; i++) if (matchAtTier(O, F, t, i)) occ.push(i);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}
function nearest(occ: number[], target: number): number {
  let best = occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const o of occ) {
    const d = Math.abs(o - target);
    if (d < bestDist) { best = o; bestDist = d; }
  }
  return best;
}

// The lines that replace F[i .. i+O.length) for a matched occurrence. A
// context line is written as the file's own matched line; at tier 2 every
// other line is re-indented from O's first line's leading whitespace to the
// file's first matched line's.
interface NLine { text: string; context: boolean; oPos: number; }
function buildReplacement(F: string[], i: number, O: string[], N: NLine[], tier: Tier): string[] {
  const out: string[] = [];
  const leadF = leadingWS(F[i] ?? '');
  const leadP = leadingWS(O.length > 0 ? O[0]! : '');
  for (const n of N) {
    if (n.context) {
      out.push(F[i + n.oPos]!);
    } else if (tier === 2) {
      const t = n.text;
      if (t === '' || /^[ \t]+$/.test(t)) out.push(t);
      else if (t.startsWith(leadP)) out.push(leadF + t.slice(leadP.length));
      else out.push(t);
    } else {
      out.push(n.text);
    }
  }
  return out;
}
// The first line at or after `cursor` equal to the single-line `anchor` at
// the first tier where one is, or -1.
function findAnchor(anchor: string, F: string[], cursor: number, strict: boolean): number {
  for (const t of tiersFor(strict)) {
    for (let j = Math.max(0, cursor); j < F.length; j++) {
      const f = F[j]!;
      const ok = t === 0 ? anchor === f : t === 1 ? stripTrail(anchor) === stripTrail(f) : stripBoth(anchor) === stripBoth(f);
      if (ok) return j;
    }
  }
  return -1;
}

// --- Section 6: unified diffs ---

type UBodyKind = 'ctx' | 'old' | 'new' | 'mark';
interface UBody { kind: UBodyKind; text: string; }
interface UHunk { a: number; body: UBody[]; }
interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffGit: [string, string] | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  let cur: USection | null = null;
  let inHeader = false;
  let hasPair = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { pairOld: null, pairNew: null, renameFrom: null, renameTo: null, diffGit: [m[1]!, m[2]!], isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      hasPair = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      cur = { pairOld: headerPath(line), pairNew: headerPath(lines[i + 1]!), renameFrom: null, renameTo: null, diffGit: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: UHunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (bl === '') { hunk.body.push({ kind: 'ctx', text: '' }); i++; }
        else if (bl[0] === ' ') { hunk.body.push({ kind: 'ctx', text: bl.slice(1) }); i++; }
        else if (bl[0] === '-') { hunk.body.push({ kind: 'old', text: bl.slice(1) }); i++; }
        else if (bl[0] === '+') { hunk.body.push({ kind: 'new', text: bl.slice(1) }); i++; }
        else if (bl[0] === '\\') { hunk.body.push({ kind: 'mark', text: bl.slice(1) }); i++; }
        else break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.kind === 'ctx' && lastB.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function hasBackslashAfterLastCP(h: UHunk): boolean {
  let last = -1;
  for (let j = 0; j < h.body.length; j++) {
    if (h.body[j]!.kind === 'ctx' || h.body[j]!.kind === 'new') last = j;
  }
  if (last < 0) return false;
  return last + 1 < h.body.length && h.body[last + 1]!.kind === 'mark';
}

function applyUnifiedHunks(before: string, hunks: UHunk[], strict: boolean, path: string): string {
  let { lines, br, final } = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') { O.push(b.text); N.push({ text: b.text, context: true, oPos: O.length - 1 }); }
      else if (b.kind === 'old') { O.push(b.text); }
      else if (b.kind === 'new') { N.push({ text: b.text, context: false, oPos: -1 }); }
    }
    if (O.length > 0) {
      const found = findTier(O, lines, strict);
      if (!found) throw new Fail('no-match', path);
      const at = nearest(found.occ, h.a - 1 + d);
      const repl = buildReplacement(lines, at, O, N, found.tier);
      if (at + O.length === lines.length) final = !hasBackslashAfterLastCP(h);
      lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + O.length)];
      d += N.length - O.length;
    } else {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const ins = N.map((x) => x.text);
      if (pos === lines.length) final = !hasBackslashAfterLastCP(h);
      lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
      d += N.length;
    }
  }
  return joinFile(lines, br, final);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null = sec.pairOld !== null ? sec.pairOld : (sec.renameFrom ?? (sec.diffGit ? sec.diffGit[0] : null));
    let newP: string | null = sec.pairNew !== null ? sec.pairNew : (sec.renameTo ?? (sec.diffGit ? sec.diffGit[1] : null));
    if (oldP === '/dev/null') oldP = null;
    if (newP === '/dev/null') newP = null;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = newP === null || sec.isDelete;
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === 'new') {
            plus.push(h.body[j]!.text);
            noBreak = j + 1 < h.body.length && h.body[j + 1]!.kind === 'mark';
          }
        }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP !== null ? oldP : newP;
    if (p === null) throw new Fail('unsafe', '/dev/null');
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(before, sec.hunks, strict, p));
  };
}

// --- Section 7: SEARCH/REPLACE blocks ---

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevReplaceEnd = -1;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { s = j; break; }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(oldLines, lines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, context: false, oPos: -1 }));
    const repl = buildReplacement(lines, at, oldLines, N, found.tier);
    const out = [...lines.slice(0, at), ...repl, ...lines.slice(at + oldLines.length)];
    tree.now.set(path, joinFile(out, br, final));
  };
}

// --- Section 8: V4A patches ---

interface VChunk { anchor: string | null; eof: boolean; body: string[]; }

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) { last = j; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (true) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    const m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(line);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    let j = i + 1;
    while (j < last && !/^\*\*\* (Add File|Delete File|Update File): /.test(lines[j]!)) j++;
    const body = lines.slice(i + 1, j);
    while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
    if (kind === 'Add File') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k]!;
        if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else if (bl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'Delete File') {
      for (let k = 0; k < body.length; k++) {
        if (!blank(body[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, body, i, strict));
    }
    i = j;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, body: string[], headerIdx: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let restStart = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
    moveTo = body[0]!.slice('*** Move to: '.length).trim();
    restStart = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let startedAny = false;
  for (let k = restStart; k < body.length; k++) {
    const bl = body[k]!;
    const lineNo = headerIdx + 2 + k;
    if (bl.startsWith('@@')) {
      if (cur) chunks.push(cur);
      const anchor = bl.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      startedAny = true;
    } else if (bl === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
      startedAny = true;
    } else if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') {
      if (!cur) {
        if (startedAny) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, body: [] };
        startedAny = true;
      }
      cur.body.push(bl);
    } else {
      throw new Exit2(`error: parse ${lineNo}`);
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerIdx + 1}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, lines, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const b of ch.body) {
        if (b.startsWith(' ')) { const t = b.slice(1); O.push(t); N.push({ text: t, context: true, oPos: O.length - 1 }); }
        else if (b.startsWith('-')) { O.push(b.slice(1)); }
        else if (b.startsWith('+')) { N.push({ text: b.slice(1), context: false, oPos: -1 }); }
        else if (b === '') { O.push(''); N.push({ text: '', context: true, oPos: O.length - 1 }); }
      }
      if (O.length > 0) {
        let at: number;
        let tier: Tier;
        if (ch.eof) {
          // An end-of-file chunk takes only an occurrence that ends at the
          // file's last line, at the first tier with one.
          const endPos = lines.length - O.length;
          if (endPos < cursor) throw new Fail('no-match', path);
          let foundTier: Tier | null = null;
          for (const t of tiersFor(strict)) {
            if (matchAtTier(O, lines, t, endPos)) { foundTier = t; break; }
          }
          if (foundTier === null) throw new Fail('no-match', path);
          at = endPos;
          tier = foundTier;
        } else {
          const found = findTierFrom(O, lines, cursor, strict);
          if (!found) throw new Fail('no-match', path);
          at = found.occ[0]!;
          tier = found.tier;
        }
        const repl = buildReplacement(lines, at, O, N, tier);
        lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + O.length)];
        cursor = at + repl.length;
      } else {
        const pos = ch.eof ? lines.length : cursor;
        const ins = N.map((x) => x.text);
        lines = [...lines.slice(0, pos), ...ins, ...lines.slice(pos)];
        cursor = pos + ins.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // One row per changed path, in byte order of the paths. A move that
  // succeeded prints `R <old> -> <new>` (sorted by <new>) instead of the
  // pair's `D` and `A` lines, when <old> existed before the patch and does
  // not after it, and <new> did not exist before it and does after it.
  const rowList: { key: string; line: string }[] = [];
  const handledOld = new Set<string>();
  const handledNew = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (handledOld.has(old) || handledNew.has(nw)) continue;
    const wasOld = tree.original(old);
    const wasNew = tree.original(nw);
    const nowOld = tree.now.has(old) ? tree.now.get(old)! : undefined;
    const nowNew = tree.now.has(nw) ? tree.now.get(nw)! : undefined;
    if (wasOld !== null && nowOld === null && wasNew === null && typeof nowNew === 'string') {
      rowList.push({ key: nw, line: `R ${old} -> ${nw}` });
      handledOld.add(old);
      handledNew.add(nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (handledOld.has(p) || handledNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
