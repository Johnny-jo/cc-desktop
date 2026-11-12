import path from "node:path";
import ts from "typescript";
import type { Coverage } from "./code-symbol-index";

export type CodePurposeRequest = {
  purpose: string; hints?: string[]; scope?: string;
  name?: never; file?: never; line?: never; column?: never; callOffset?: never;
};
export type CodePurposeCandidate = {
  name: string; file: string; startLine: number; endLine: number; startColumn: number;
  excerpt: {
    startLine: number; endLine: number; text: string;
    /** Present for partial-line slices; columns are one-based, endColumn exclusive. */
    startColumn?: number; endColumn?: number;
  };
  reasons: string[];
};
export type CodePurposeResult = {
  status: "candidates" | "no_match";
  candidates: CodePurposeCandidate[]; totalCandidates: number; terms: string[];
  coverage: Coverage; hint: string;
};

// Filled by the exact-name reader's recognizer, including its overload set and
// arrow/function-expression deduplication. Discovery never reparses source.
export type PurposeImplementation = {
  name: string; token: ts.Node; source: ts.SourceFile;
  start: number; fullStart: number; end: number; nodes: Set<ts.Node>;
};
type EvidenceKind = "name" | "identifier" | "string" | "comment" | "resolved symbol";
type Evidence = { kind: EvidenceKind; term: string; position: number; positions: number[]; weight: number; detail?: string };
type Candidate = { impl: PurposeImplementation; evidence: Map<string, Evidence>; related: Map<Candidate, number>; test: boolean };

const MAX_TERMS = 64;
const MAX_TERM_LENGTH = 120;
const EXCERPT_LINES = 16;
const EXCERPT_CHARS = 2400;
const weights: Record<EvidenceKind, number> = { name: 10, identifier: 4, string: 3, comment: 2, "resolved symbol": 9 };
const stopWords = new Set("a an and are as at be been by can code could did do does find for from function functions get has have how i if in into is it its locate me of on or our please read show so that the their them there these they this those to track us use was we what when where which will with would you your".split(" "));
// This is a deliberately small technical glossary, not a natural-language or
// semantic model. Unknown Chinese phrases can still match literal source text.
const chineseTerms: Record<string, string[]> = {
  "摘要": ["summary", "summarize"], "模型": ["model"], "切换": ["switch", "change"],
  "取消": ["abort", "aborted", "cancel", "cancelled", "canceled"], "续发": ["resume", "resend"], "发送": ["send"],
  "消息": ["message"], "请求": ["request"], "重试": ["retry"], "超时": ["timeout"],
  "缓存": ["cache"], "配置": ["config", "settings"], "错误": ["error"],
  "登录": ["login", "auth"], "权限": ["permission"], "保存": ["save"],
  "删除": ["delete", "remove"], "读取": ["read"], "队列": ["queue"],
  "压缩": ["compress", "compact", "compression", "compaction"], "等待": ["await"],
  "提交": ["commit", "committed"], "过期": ["stale", "obsolete"],
  "会话": ["session"], "历史": ["history"], "变化": ["change", "changed"],
};

function words(text: string) {
  return text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase().match(/[a-z\d]+|[\u3400-\u9fff]+/g) ?? [];
}

function searchTerms(request: CodePurposeRequest) {
  const terms = new Map<string, string>();
  const add = (term: string, explicit = false) => {
    term = term.trim();
    const key = term.toLowerCase();
    if (term && term.length <= MAX_TERM_LENGTH && (explicit || (term.length > 1 && !stopWords.has(key))) && terms.size < MAX_TERMS && !terms.has(key)) terms.set(key, term);
  };
  for (const hint of request.hints ?? []) {
    add(hint, true);
    // Retain exact error text/identifier hints before any derived word fragments.
  }
  for (const input of [request.purpose, ...(request.hints ?? [])]) {
    for (const token of input.match(/[a-zA-Z_$][\w$]*|[\u3400-\u9fff]+/g) ?? []) {
      add(token);
      for (const word of words(token)) add(word);
    }
    for (const [chinese, expanded] of Object.entries(chineseTerms)) {
      if (!input.includes(chinese)) continue;
      add(chinese);
      for (const term of expanded) add(term);
    }
  }
  return [...terms.values()];
}

function matchingTerms(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const tokens = new Set([lower, ...words(text)]);
  // Latin word matches use identifier/word boundaries. In particular, `end`
  // does not match `send`; full identifier and exact error-text hints also work.
  for (const token of text.match(/[a-zA-Z_$][\w$]*/g) ?? []) tokens.add(token.toLowerCase());
  return terms.filter(term => /^[\w$]+$/.test(term) ? tokens.has(term.toLowerCase()) : lower.includes(term.toLowerCase()));
}

function scopeDirectory(root: string, scope: string | undefined) {
  if (scope === undefined) return root;
  if (path.isAbsolute(scope) || /^[a-z]:/i.test(scope) || /^[/\\]/.test(scope)) throw Error("scope must be a project-relative directory.");
  const directory = path.resolve(root, scope);
  const relative = path.relative(root, directory);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw Error("scope must remain inside the project.");
  return directory;
}

function inDirectory(directory: string, file: string) {
  const relative = path.relative(directory, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function testFile(file: string) {
  return /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(file);
}

function excerpt(impl: PurposeImplementation, evidence: Evidence[]) {
  const source = impl.source;
  const lineStarts = source.getLineStarts();
  const hits = evidence.flatMap(item => item.positions.map(position => ({ ...item, position, line: source.getLineAndCharacterOfPosition(position).line })));
  if (!hits.length) hits.push({ kind: "name", term: impl.name, position: impl.start, positions: [impl.start], weight: 1, line: source.getLineAndCharacterOfPosition(impl.start).line });
  const first = source.getLineAndCharacterOfPosition(Math.min(impl.start, ...hits.map(hit => hit.position))).line;
  const last = source.getLineAndCharacterOfPosition(impl.end - 1).line;
  let start = first;
  let bestScore = -1;
  for (const hit of hits) {
    const windowStart = Math.max(first, Math.min(hit.line - 4, last - EXCERPT_LINES + 1));
    const byTerm = new Map<string, number>();
    for (const other of hits) {
      if (other.line < windowStart || other.line >= windowStart + EXCERPT_LINES) continue;
      // A declaration is useful context; independent clues in a real branch
      // carry more excerpt value than the first matching parameter/name alone.
      const weight = other.kind === "name" || other.kind === "resolved symbol" ? 1 : other.weight;
      byTerm.set(other.term.toLowerCase(), Math.max(byTerm.get(other.term.toLowerCase()) ?? 0, weight));
    }
    const value = [...byTerm.values()].reduce((sum, weight) => sum + weight, 0);
    if (value > bestScore) { start = windowStart; bestScore = value; }
  }
  const end = Math.min(last + 1, start + EXCERPT_LINES);
  let startOffset = lineStarts[start];
  const inWindow = hits.filter(hit => hit.line >= start && hit.line < end);
  const anchor = inWindow.find(hit => hit.kind !== "name" && hit.kind !== "resolved symbol") ?? inWindow[0];
  const windowEnd = lineStarts[end] ?? source.text.length;
  // Every excerpt is a single source slice. No stitched branches or annotations.
  // When a long line needs a middle slice, keep the hit visible and expose exact
  // columns instead of implying that the excerpt contains whole source lines.
  if (anchor.position >= startOffset + EXCERPT_CHARS) startOffset = Math.max(startOffset, anchor.position - Math.floor(EXCERPT_CHARS / 3));
  let endOffset = Math.min(windowEnd, startOffset + EXCERPT_CHARS);
  while (endOffset > startOffset && /[\r\n]/.test(source.text[endOffset - 1])) endOffset--;
  const begin = source.getLineAndCharacterOfPosition(startOffset);
  const finish = source.getLineAndCharacterOfPosition(endOffset);
  const partialLine = begin.character > 0 || (endOffset < source.text.length && !/[\r\n]/.test(source.text[endOffset]));
  return {
    startLine: begin.line + 1, endLine: source.getLineAndCharacterOfPosition(Math.max(startOffset, endOffset - 1)).line + 1,
    text: source.text.slice(startOffset, endOffset),
    ...(partialLine ? { startColumn: begin.character + 1, endColumn: finish.character + 1 } : {}),
  };
}

export function searchCodePurpose(
  root: string, request: CodePurposeRequest, sources: ts.SourceFile[], checker: ts.TypeChecker,
  implementations: PurposeImplementation[], coverage: Coverage,
): CodePurposeResult {
  const directory = scopeDirectory(root, request.scope);
  const terms = searchTerms(request);
  const candidates = implementations.filter(impl => inDirectory(directory, impl.source.fileName)).map(impl => ({
    impl, evidence: new Map<string, Evidence>(), related: new Map<Candidate, number>(),
    test: testFile(path.relative(root, impl.source.fileName).split(path.sep).join("/")),
  }));
  const owners = new Map<ts.Node, Candidate>();
  for (const candidate of candidates) for (const node of candidate.impl.nodes) owners.set(node, candidate);

  function target(node: ts.Node, seen = new Set<ts.Node>()): Candidate | undefined {
    if (seen.has(node) || seen.size > 12) return;
    seen.add(node);
    const physical = owners.get(node);
    if (physical) return physical;
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
    const declarations = symbol?.declarations ?? [];
    const matches = new Set<Candidate>();
    for (const declaration of declarations) {
      let resolved = owners.get(declaration);
      if (!resolved && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer) {
        let value = declaration.initializer;
        while (ts.isParenthesizedExpression(value) || ts.isAsExpression(value) || ts.isNonNullExpression(value) || ts.isSatisfiesExpression(value) || ts.isTypeAssertionExpression(value)) value = value.expression;
        resolved = target(ts.isPropertyAccessExpression(value) ? value.name : value, seen);
      }
      if (resolved) matches.add(resolved);
      else if (declarations.length > 1) return;
    }
    // Unrelated overload/union declarations cannot establish one physical target.
    return matches.size === 1 ? [...matches][0] : undefined;
  }

  const add = (candidate: Candidate | undefined, kind: EvidenceKind, matched: string[], position: number, detail?: string) => {
    if (!candidate) return;
    for (const term of matched) {
      const key = kind + ":" + term.toLowerCase();
      const existing = candidate.evidence.get(key);
      if (!existing) candidate.evidence.set(key, { kind, term, position, positions: [position], weight: weights[kind], detail });
      else if (existing.positions.length < 16 && !existing.positions.includes(position)) existing.positions.push(position);
    }
  };
  const calls: { node: ts.CallExpression; owner: Candidate }[] = [];
  for (const source of sources) {
    if (!inDirectory(directory, source.fileName)) continue;
    const comments = new Map<number, { range: ts.CommentRange; owner: Candidate }>();
    function recordComments(ranges: ts.CommentRange[] | undefined, owner: Candidate | undefined) {
      if (!owner) return;
      for (const range of ranges ?? []) {
        if (range.pos < owner.impl.fullStart || range.pos >= owner.impl.end) continue;
        const prior = comments.get(range.pos);
        if (!prior || owner.impl.end - owner.impl.fullStart < prior.owner.impl.end - prior.owner.impl.fullStart) comments.set(range.pos, { range, owner });
      }
    }
    function visit(node: ts.Node, enclosing?: Candidate) {
      const owner = owners.get(node) ?? enclosing;
      recordComments(ts.getLeadingCommentRanges(source.text, node.getFullStart()), owner);
      recordComments(ts.getTrailingCommentRanges(source.text, node.end), owner);
      if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        const matched = matchingTerms(node.text, terms);
        if (matched.length) {
          add(owner, node === owner?.impl.token ? "name" : "identifier", matched, node.getStart(source));
          // A spelling contributes to another implementation only when the
          // checker resolves that particular occurrence, including real aliases.
          const resolved = target(node);
          if (resolved && resolved !== owner) add(resolved, "resolved symbol", matched, resolved.impl.start, `"${node.text}" at ${path.relative(root, source.fileName).split(path.sep).join("/")}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      } else if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        const position = node.getStart(source);
        const raw = source.text.slice(position, node.end).toLowerCase();
        for (const term of matchingTerms(node.text, terms)) add(owner, node === owner?.impl.token ? "name" : "string", [term], position + Math.max(0, raw.indexOf(term.toLowerCase())));
      }
      if (owner && ts.isAwaitExpression(node)) add(owner, "identifier", matchingTerms("await", terms), node.getStart(source));
      if (owner && ts.isCallExpression(node)) calls.push({ node, owner });
      ts.forEachChild(node, child => visit(child, owner));
    }
    visit(source);
    for (const { range, owner } of comments.values()) {
      const raw = source.text.slice(range.pos, range.end);
      for (const term of matchingTerms(raw, terms)) add(owner, "comment", [term], range.pos + Math.max(0, raw.toLowerCase().indexOf(term.toLowerCase())));
    }
  }

  const score = (candidate: Candidate) => {
    // Count each term/kind once; repeated mentions or a huge wrapper do not gain
    // an advantage simply by repeating a word hundreds of times.
    const byTerm = new Map<string, number>();
    let name = 0;
    let alias = 0;
    for (const evidence of candidate.evidence.values()) {
      // `summaryModel`, `summary`, and `model` on a single declaration are one
      // naming clue, not three independent pieces of implementation evidence.
      if (evidence.kind === "name") name = Math.max(name, evidence.weight);
      else if (evidence.kind === "resolved symbol") alias = Math.max(alias, evidence.weight);
      else byTerm.set(evidence.term.toLowerCase(), Math.max(byTerm.get(evidence.term.toLowerCase()) ?? 0, evidence.weight));
    }
    return name + alias + [...byTerm.values()].reduce((sum, weight) => sum + weight, 0);
  };
  const directScores = new Map(candidates.map(candidate => [candidate, score(candidate)]));
  // One hop only, from actual lexical seeds. Resolved relationships are evidence
  // to inspect a related function, never proof that it implements the purpose.
  for (const { node, owner } of calls) {
    const seed = directScores.get(owner) ?? 0;
    if (!seed) continue;
    const declaration = checker.getResolvedSignature(node)?.declaration;
    const resolved = declaration && owners.get(declaration);
    if (!resolved || resolved === owner) continue;
    let expression: ts.Expression = node.expression;
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    const token = ts.isPropertyAccessExpression(expression) ? expression.name : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;
    // A synthesized union call signature can pick one declaration even after
    // `const alias = receiver.method`. Resolve every alias layer to one physical
    // target as well; a signature alone cannot establish that relationship.
    if (target(token) !== resolved) continue;
    resolved.related.set(owner, Math.min(6, seed * 0.4));
  }
  const explicitHints = [...new Set((request.hints ?? []).map(hint => hint.trim().toLowerCase()))];
  const hintCoverage = new Map(candidates.map(candidate => {
    let coverage = 0;
    for (const hint of explicitHints) {
      let best = 0;
      for (const evidence of candidate.evidence.values()) {
        if (evidence.term.toLowerCase() !== hint) continue;
        best = Math.max(best, evidence.kind === "comment" ? 0.3 : evidence.kind === "string" ? 0.7 : 1);
      }
      coverage += best;
    }
    return [candidate, coverage * (candidate.test ? 0.4 : 1)] as const;
  }));
  const rank = (candidate: Candidate) => {
    const source = candidate.impl.source;
    const lines = source.getLineAndCharacterOfPosition(candidate.impl.end - 1).line - source.getLineAndCharacterOfPosition(candidate.impl.start).line + 1;
    // Broad registration wrappers naturally accumulate unrelated vocabulary.
    // Only large implementations are damped; ordinary functions keep full weight.
    const size = Math.sqrt(Math.max(1, lines / 200));
    return ((directScores.get(candidate) ?? 0) + Math.max(0, ...candidate.related.values())) * (candidate.test ? 0.4 : 1) / size;
  };
  const ranked = candidates.filter(candidate => rank(candidate) > 0).sort((a, b) => {
    const left = path.relative(root, a.impl.source.fileName);
    const right = path.relative(root, b.impl.source.fileName);
    return (hintCoverage.get(b) ?? 0) - (hintCoverage.get(a) ?? 0) || rank(b) - rank(a) || (left < right ? -1 : left > right ? 1 : 0) || a.impl.start - b.impl.start;
  });
  const top = ranked[0];
  const weak = top && (top.test || ![...top.evidence.values()].some(e => e.kind !== "comment" && e.kind !== "string"));
  let hint = "Local lexical evidence and resolved static relationships only; candidates are not semantic conclusions. Excerpts are bounded continuous source ranges. Expand a candidate with name, file, line=startLine and column=startColumn.";
  if (!top) hint = "No indexed function has matching lexical evidence in this scope. Add an identifier/exact error text or broaden scope; no_match does not establish absence of an implementation.";
  else if (weak) hint = "Weak match: the leading candidate has only comment/string, test, or relationship evidence. Add an identifier/exact error text or broaden scope. " + hint;
  if (coverage.partial) hint += " Index coverage is partial; skipped files can contain additional matches.";
  return {
    status: top ? "candidates" : "no_match", totalCandidates: ranked.length, terms, coverage, hint,
    candidates: ranked.slice(0, 3).map(candidate => {
      const impl = candidate.impl;
      const evidence = [...candidate.evidence.values()].sort((a, b) => b.weight - a.weight || a.position - b.position);
      const pos = impl.source.getLineAndCharacterOfPosition(impl.start);
      const reasons = evidence.slice(0, 6).map(e => `${e.kind} matches "${e.term}"${e.detail ? ` via resolved ${e.detail}` : ""}.`);
      if (explicitHints.length) reasons.unshift(`Explicit hints matched: ${explicitHints.filter(hint => evidence.some(item => item.term.toLowerCase() === hint)).length}/${explicitHints.length}.`);
      for (const source of [...candidate.related.keys()].slice(0, 2)) reasons.push(`Resolved direct call from ${source.impl.name} at ${path.relative(root, source.impl.source.fileName).split(path.sep).join("/")}:${source.impl.source.getLineAndCharacterOfPosition(source.impl.start).line + 1}.`);
      if (candidate.test) reasons.push("Test/fixture source; verify the production implementation.");
      return {
        name: impl.name, file: path.relative(root, impl.source.fileName).split(path.sep).join("/"),
        startLine: pos.line + 1, endLine: impl.source.getLineAndCharacterOfPosition(impl.end - 1).line + 1,
        startColumn: pos.character + 1, excerpt: excerpt(impl, evidence), reasons,
      };
    }),
  };
}
